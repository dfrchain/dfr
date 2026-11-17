/**
 * PostgresTransactionStore 契约测试（DFR-M1-A09）。
 *
 * 权威来源：docs/architecture/m1-storage-model.md 第 4/5 节、ADR-015 §5。
 *
 * 默认**跳过**；显式开启（`pnpm test:db` 会导出 DSN）：
 *
 *   DFR_TRANSACTION_MIGRATION_DATABASE_URL=postgres://dfr_migrator:...@127.0.0.1:55432/dfr_m1_test \
 *   pnpm vitest run packages/storage-postgres/test/transaction-store.test.ts
 *
 * 本文件**自建一次性数据库**（`dfr_t_store_test`）并在结束时不删除它之前先关闭连接。
 * 原因：schema 契约测试会 `DROP SCHEMA transaction_data CASCADE`，
 * 若共用同一数据库，两个测试文件会互相破坏（vitest 默认跨文件并行）。
 *
 * 任务卡要求的两个关键验证：
 *   1. 两个连接竞争同一 version，只有一个成功（CAS 生效）；
 *   2. transition 审计写入失败时，状态快照必须回滚。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import type { AccountRef, ChainId, DecimalUint, Iso8601, TransactionId } from '@dfr/types';
import type { TransactionRecord, TransitionPatch } from '@dfr/transaction';
import { PostgresTransactionStore } from '../src/transaction-store.js';
import { PostgresNonceStore } from '../src/nonce-store.js';
import { loadMigrations, runMigrations } from '../src/migrate.js';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

/** 迁移身份 DSN：用于建库、跑迁移，以及安装测试用探针约束。 */
const ADMIN_DSN = process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
const ENABLED = typeof ADMIN_DSN === 'string' && ADMIN_DSN.length > 0;

const PRIVATE_DB = 'dfr_t_store_test';
const SCHEMA = 'transaction_data';

const chain = 'ethereum-sepolia' as ChainId;
const from: AccountRef = { chain, address: '0x1111111111111111111111111111111111111111' };
const to: AccountRef = { chain, address: '0x2222222222222222222222222222222222222222' };

const num = (v: string): DecimalUint => v as DecimalUint;
const iso = (v: string): Iso8601 => v as Iso8601;

let admin: Client;
/** 指向私有库的原始连接：用于绕过 Store 直接断言数据库真实状态。 */
let inspector: Client;
let pool: Pool;
let store: PostgresTransactionStore;

function dsnFor(database: string): string {
  // 把 DSN 的库名替换为目标库；保留其余部分不变。
  return ADMIN_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

function makeRecord(id: string, overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    transactionId: id as TransactionId,
    projectId: 'default',
    chain,
    requestFingerprint: 'a'.repeat(64),
    status: 'built',
    stateVersion: num('1'),
    from,
    createdAt: iso('2026-10-04T00:00:00Z'),
    updatedAt: iso('2026-10-04T00:00:00Z'),
    ...overrides,
  };
}

async function resetRows(): Promise<void> {
  await inspector.query(
    `TRUNCATE ${SCHEMA}.transaction_transitions, ${SCHEMA}.sequencing_leases, ${SCHEMA}.nonce_leases, ${SCHEMA}.transactions CASCADE`,
  );
}

/** Simulates the real nonce reservation boundary without invoking the transaction engine. */
async function seedNonceLease(
  transactionId: string,
  nonce: string,
  options: { status?: string; ttl?: string; owner?: string } = {},
): Promise<void> {
  await inspector.query(
    `INSERT INTO ${SCHEMA}.nonce_accounts (chain_id, account_address, next_nonce)
      VALUES ($1, $2, $3::numeric + 1)
      ON CONFLICT (chain_id, account_address) DO NOTHING`,
    [chain, from.address, nonce],
  );
  await inspector.query(
    `INSERT INTO ${SCHEMA}.nonce_leases
      (chain_id, account_address, nonce, transaction_id, status, expires_at)
      VALUES ($1, $2, $3::numeric, $4, $5, clock_timestamp() + $6::interval)`,
    [chain, from.address, nonce, options.owner ?? transactionId, options.status ?? 'reserved', options.ttl ?? '1 hour'],
  );
}

/** Seed the actual ADR-032 blockhash lease before transaction creation. */
async function seedBlockhashLease(
  transactionId: string,
  chainId: ChainId,
  accountAddress: string,
  options: { token?: string; status?: string; ttl?: string; owner?: string; height?: string } = {},
): Promise<void> {
  await inspector.query(
    `INSERT INTO ${SCHEMA}.sequencing_leases
       (chain_id, account_address, token_kind, token_value,
        last_valid_block_height, transaction_id, status, expires_at)
     VALUES ($1, $2, 'blockhash', $3, $4::numeric, $5, $6, clock_timestamp() + $7::interval)`,
    [
      chainId, accountAddress, options.token ?? '11111111111111111111111111111111',
      options.height ?? '495317734', options.owner ?? transactionId,
      options.status ?? 'reserved', options.ttl ?? '1 hour',
    ],
  );
}

/** 读取绕过 Store 的原始行，用于验证"数据库里真正发生了什么"。 */
async function rawRow(id: string): Promise<{ status: string; state_version: string; canonical_block_hash: string | null } | undefined> {
  const { rows } = await inspector.query<{ status: string; state_version: string; canonical_block_hash: string | null }>(
    `SELECT status, state_version, canonical_block_hash FROM ${SCHEMA}.transactions WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function transitionCount(id: string): Promise<number> {
  const { rows } = await inspector.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${SCHEMA}.transaction_transitions WHERE transaction_id = $1`,
    [id],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (!ENABLED) return;
  admin = new Client({ connectionString: ADMIN_DSN });
  await admin.connect();

  const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
  if (!/_test$/u.test(rows[0]!.db)) {
    throw new Error(`拒绝在非测试库 "${rows[0]!.db}" 上执行（库名必须以 _test 结尾）`);
  }

  await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${PRIVATE_DB}`);

  // 在私有库上应用真实迁移，保证测试针对的是真实 schema。
  const setupClient = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await setupClient.connect();
  await runMigrations({ client: setupClient, migrations: loadMigrations(migrationsDir) });
  await setupClient.end();

  pool = new Pool({ connectionString: dsnFor(PRIVATE_DB), max: 5 });
  store = new PostgresTransactionStore(pool);

  inspector = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await inspector.connect();
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  // DROP DATABASE 要求没有活动连接：先释放池，再从 admin 连接删除。
  if (inspector) await inspector.end();
  if (pool) await pool.end();
  if (admin) {
    // 池关闭后服务端可能仍有极少量残留 backend；先 terminate 再 DROP，
    // 避免 FORCE 掐连接时在 pg 客户端上抛出 57P01 噪声错误。
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [PRIVATE_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB} WITH (FORCE)`);
    await admin.end();
  }
}, 60_000);

describe.skipIf(!ENABLED)('PostgresTransactionStore（DFR-M1-A09）', () => {
  it('create → get 往返：字段映射正确且版本为十进制字符串', async () => {
    await resetRows();
    const record = makeRecord('txn_roundtrip', {
      to,
      nonce: num('7'),
      sequencingRef: { kind: 'nonce', value: num('7') },
      unsignedPayload: '0xdeadbeef',
      payloadEncoding: 'hex',
      expectedHash: '0x' + 'ab'.repeat(32),
      minFinality: 'finalized',
      blockRef: { kind: 'tag', tag: 'latest' },
      canonicalBlockHash: '0x' + 'cd'.repeat(32),
    });
    await seedNonceLease('txn_roundtrip', '7');
    const created = await store.create({ record });
    expect(created.kind).toBe('created');

    const loaded = await store.get(record.transactionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.transactionId).toBe(record.transactionId);
    expect(loaded!.status).toBe('built');
    expect(loaded!.stateVersion).toBe('1');
    // nonce 必须是十进制字符串，不能变成 number（浮点/精度红线）。
    expect(typeof loaded!.nonce).toBe('string');
    expect(loaded!.nonce).toBe('7');
    expect(loaded!.from.address).toBe(from.address);
    expect(loaded!.to?.address).toBe(to.address);
    expect(loaded!.payloadEncoding).toBe('hex');
    expect(loaded!.minFinality).toBe('finalized');
    expect(loaded!.blockRef).toEqual({ kind: 'tag', tag: 'latest' });
    expect(loaded!.canonicalBlockHash).toBe('0x' + 'cd'.repeat(32));
    // 时间必须是 ISO 8601 字符串。
    expect(loaded!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('get 未找到返回 null（不是 undefined）', async () => {
    expect(await store.get('txn_missing' as TransactionId)).toBeNull();
  });

  it('getByHash 限定链并可命中已广播哈希或 expectedHash', async () => {
    await resetRows();
    const expectedHash = `0x${'ab'.repeat(32)}`;
    const txHash = `0x${'cd'.repeat(32)}`;
    await store.create({ record: makeRecord('txn_by_hash', { expectedHash, txHash }) });

    await expect(store.getByHash(chain, txHash)).resolves.toMatchObject({ transactionId: 'txn_by_hash' });
    await expect(store.getByHash(chain, expectedHash)).resolves.toMatchObject({ transactionId: 'txn_by_hash' });
    await expect(store.getByHash('base-sepolia' as ChainId, txHash)).resolves.toBeNull();
    await expect(store.getByHash(chain, `0x${'ef'.repeat(32)}`)).resolves.toBeNull();
  });

  it('重复 create 返回 already_exists，且不覆盖既有记录', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_dup', { status: 'built' }) });
    const again = await store.create({
      record: makeRecord('txn_dup', { status: 'finalized', stateVersion: num('9') }),
    });
    expect(again.kind).toBe('already_exists');
    if (again.kind === 'already_exists') {
      expect(again.record.status).toBe('built');
      expect(again.record.stateVersion).toBe('1');
    }
  });

  it('ADR-033：非 EVM（Solana blockhash）记录可落 sequencing_ref，且往返一致', async () => {
    await resetRows();
    const solChain = 'solana-devnet' as ChainId;
    const record: TransactionRecord = {
      ...makeRecord('txn_seq_ref'),
      chain: solChain,
      from: { chain: solChain, address: 'So11111111111111111111111111111111111111112' },
      status: 'built',
      sequencingRef: {
        kind: 'blockhash',
        value: '11111111111111111111111111111111',
        lastValidBlockHeight: num('495317734'),
      },
    };
    await seedBlockhashLease('txn_seq_ref', solChain, record.from.address);
    const created = await store.create({ record });
    expect(created.kind).toBe('created');
    expect(created.record.sequencingRef).toEqual({
      kind: 'blockhash',
      value: '11111111111111111111111111111111',
      lastValidBlockHeight: '495317734',
    });

    const readBack = await store.get('txn_seq_ref' as TransactionId);
    expect(readBack?.sequencingRef).toEqual(record.sequencingRef);
    // Solana 记录没有 EVM nonce 列。
    expect(readBack?.nonce).toBeUndefined();

    const { rows } = await inspector.query<{ ref: unknown }>(
      `SELECT sequencing_ref AS ref FROM ${SCHEMA}.transactions WHERE id = $1`,
      ['txn_seq_ref'],
    );
    expect(rows[0]!.ref).toEqual({
      kind: 'blockhash',
      value: '11111111111111111111111111111111',
      lastValidBlockHeight: '495317734',
    });
  });

  it('NEW-04: transaction with nonce but no sequencing_ref cannot bypass nonce lease ownership', async () => {
    await resetRows();
    await seedNonceLease('txn_nonce_without_ref', '17');
    await expect(store.create({
      record: makeRecord('txn_nonce_without_ref', { nonce: num('17') }),
    })).rejects.toThrow(/sequencing_ref/u);
    expect(await store.get('txn_nonce_without_ref' as TransactionId)).toBeNull();
  });

  it('NEW-04: nonce mixed with blockhash sequencing_ref is refused before DB insertion', async () => {
    await resetRows();
    const solChain = 'solana-devnet' as ChainId;
    await expect(store.create({
      record: { ...makeRecord('txn_invalid_mixed'), chain: solChain, from: { ...from, chain: solChain },
        nonce: num('17'),
        sequencingRef: { kind: 'blockhash', value: '11111111111111111111111111111111',
          lastValidBlockHeight: num('495317734') } },
    })).rejects.toThrow(/nonce|sequencing_ref/u);
    expect(await store.get('txn_invalid_mixed' as TransactionId)).toBeNull();
  });

  it('NEW-04: a blockhash reference must have a matching reserved sequencing lease', async () => {
    const solChain = 'solana-devnet' as ChainId;
    const account = { chain: solChain, address: 'So11111111111111111111111111111111111111112' };
    const token = { kind: 'blockhash' as const, value: '11111111111111111111111111111111',
      lastValidBlockHeight: num('495317734') };
    for (const scenario of [
      { id: 'txn_seq_absent', noLease: true },
      { id: 'txn_seq_stolen', owner: 'txn_seq_other' },
      { id: 'txn_seq_wrong_chain', differentChain: true },
      { id: 'txn_seq_wrong_owner', differentAccount: true },
      { id: 'txn_seq_wrong_token', token: 'wrong-blockhash' },
      { id: 'txn_seq_wrong_height', height: '495317735' },
      { id: 'txn_seq_released', status: 'released' },
      { id: 'txn_seq_consumed', status: 'consumed' },
      { id: 'txn_seq_expired', ttl: '-1 second' },
    ]) {
      await resetRows();
      if (!('noLease' in scenario)) {
        await seedBlockhashLease(
          scenario.id, 'differentChain' in scenario && scenario.differentChain ? chain : solChain,
          'differentAccount' in scenario && scenario.differentAccount ? from.address : account.address,
          {
            ...('owner' in scenario ? { owner: scenario.owner } : {}),
            ...('token' in scenario ? { token: scenario.token } : {}),
            ...('height' in scenario ? { height: scenario.height } : {}),
            ...('status' in scenario ? { status: scenario.status } : {}),
            ...('ttl' in scenario ? { ttl: scenario.ttl } : {}),
          },
        );
      }
      await expect(store.create({ record: {
        ...makeRecord(scenario.id), chain: solChain, from: account, sequencingRef: token,
      } })).rejects.toThrow(/sequencing|blockhash|租约/u);
      expect(await store.get(scenario.id as TransactionId)).toBeNull();
    }
  });

  it('ADR-032: independent Solana transactions can share one blockhash with separate leases', async () => {
    await resetRows();
    const solChain = 'solana-devnet' as ChainId;
    const address = 'So11111111111111111111111111111111111111112';
    const token = { kind: 'blockhash' as const, value: '11111111111111111111111111111111',
      lastValidBlockHeight: num('495317734') };
    for (const id of ['txn_shared_blockhash_one', 'txn_shared_blockhash_two']) {
      await seedBlockhashLease(id, solChain, address);
    }
    const created = await Promise.all(['txn_shared_blockhash_one', 'txn_shared_blockhash_two'].map(
      (id) => store.create({ record: {
        ...makeRecord(id), chain: solChain, from: { chain: solChain, address }, sequencingRef: token,
      } }),
    ));
    expect(created.map((result) => result.kind)).toEqual(['created', 'created']);
    expect((await store.get('txn_shared_blockhash_one' as TransactionId))?.sequencingRef).toEqual(token);
    expect((await store.get('txn_shared_blockhash_two' as TransactionId))?.sequencingRef).toEqual(token);
  });

  it('ADR-033：EVM 记录 sequencing_ref(nonce) 与 nonce 列必须自洽', async () => {
    await resetRows();
    // 自洽且持有有效租约：允许。DB-01 之后，仅字段自洽不够。
    await seedNonceLease('txn_ref_ok', '5');
    await expect(
      store.create({ record: makeRecord('txn_ref_ok', { nonce: num('5'), sequencingRef: { kind: 'nonce', value: num('5') } }) }),
    ).resolves.toMatchObject({ kind: 'created' });
    // 不一致：fail-closed。
    await expect(
      store.create({ record: makeRecord('txn_ref_bad', { nonce: num('5'), sequencingRef: { kind: 'nonce', value: num('6') } }) }),
    ).rejects.toThrow(/sequencing_ref/u);
    // 有引用却没有 nonce 列：fail-closed。
    await expect(
      store.create({ record: makeRecord('txn_ref_nononce', { sequencingRef: { kind: 'nonce', value: num('1') } }) }),
    ).rejects.toThrow(/没有 nonce/u);
  });

  it('DB-01: production EVM create refuses a missing or reclaimed lease', async () => {
    await resetRows();
    const id = 'txn_expired_owner';
    const record = makeRecord(id, { nonce: num('8'), sequencingRef: { kind: 'nonce', value: num('8') } });

    await expect(store.create({ record })).rejects.toThrow(/租约|水位/u);
    expect(await store.get(id as TransactionId)).toBeNull();

    await seedNonceLease(id, '8', { owner: 'txn_new_owner' });
    await expect(store.create({ record })).rejects.toThrow(/租约/u);
    expect(await store.get(id as TransactionId)).toBeNull();
  });

  it('DB-01: expired, released, or broadcast nonce lease cannot become a built transaction', async () => {
    for (const scenario of [
      { id: 'txn_expired', ttl: '-1 second', status: 'reserved' },
      { id: 'txn_released', ttl: '1 hour', status: 'released' },
      { id: 'txn_broadcast', ttl: '1 hour', status: 'broadcast' },
    ]) {
      await resetRows();
      await seedNonceLease(scenario.id, '9', { ttl: scenario.ttl, status: scenario.status });
      await expect(store.create({ record: makeRecord(scenario.id, {
        nonce: num('9'), sequencingRef: { kind: 'nonce', value: num('9') },
      }) })).rejects.toThrow(/租约/u);
      expect(await store.get(scenario.id as TransactionId)).toBeNull();
    }
  });

  it('DB-01: stale build cannot insert after ownership is reassigned while waiting for account lock', async () => {
    await resetRows();
    const id = 'txn_stale_builder';
    await seedNonceLease(id, '11');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT next_nonce FROM ${SCHEMA}.nonce_accounts
           WHERE chain_id = $1 AND account_address = $2 FOR UPDATE`,
        [chain, from.address],
      );

      let settled = false;
      const staleCreate = store.create({ record: makeRecord(id, {
        nonce: num('11'), sequencingRef: { kind: 'nonce', value: num('11') },
      }) }).then(
        () => { settled = true; return false; },
        () => { settled = true; return true; },
      );
      // Check that transaction creation really waits at the account lock.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);

      await holder.query(
        `UPDATE ${SCHEMA}.nonce_leases SET transaction_id = 'txn_new_builder'
          WHERE transaction_id = $1`,
        [id],
      );
      await holder.query('COMMIT');
      expect(await staleCreate).toBe(true);
      expect(await store.get(id as TransactionId)).toBeNull();
    } finally {
      try { await holder.query('ROLLBACK'); } catch { /* already committed */ }
      holder.release();
    }
  }, 15_000);

  it('create 时同 transactionId 的既有租约 chain/from 不一致 → fail-closed', async () => {
    await resetRows();
    const id = 'txn_lease_mismatch';
    // 先落一条与记录不匹配的租约（M1-C00 后租约不再要求交易行先存在）。
    await inspector.query(
      `INSERT INTO ${SCHEMA}.nonce_leases
         (chain_id, account_address, nonce, transaction_id, status, expires_at)
       VALUES ($1, '0xother', 9, $2, 'reserved', now() + interval '1 minute')`,
      [chain, id],
    );

    await expect(store.create({ record: makeRecord(id, { nonce: num('9'), sequencingRef: { kind: 'nonce', value: num('9') } }) })).rejects.toThrow(
      /租约|lease/u,
    );
    // 记录不得落库：否则会出现"记录与租约指向不同账户"的静默不一致。
    expect(await store.get(id as TransactionId)).toBeNull();
  });

  it('transition 成功：状态推进、version +1，并写入审计行', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_ok') });

    const result = await store.transition({
      transactionId: 'txn_ok' as TransactionId,
      expectedStatus: 'built',
      expectedVersion: num('1'),
      toStatus: 'simulated',
      reason: 'simulate.succeeded',
      requestId: 'req_01' as never,
    });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.record.status).toBe('simulated');
      expect(result.record.stateVersion).toBe('2');
    }

    const raw = await rawRow('txn_ok');
    expect(raw).toEqual({ status: 'simulated', state_version: '2', canonical_block_hash: null });

    // 审计行与快照必须同时存在（同事务）。
    const { rows } = await inspector.query<{
      from_status: string | null;
      to_status: string;
      reason: string;
      request_id: string | null;
    }>(
      `SELECT from_status, to_status, reason, request_id
         FROM ${SCHEMA}.transaction_transitions WHERE transaction_id = $1`,
      ['txn_ok'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      from_status: 'built',
      to_status: 'simulated',
      reason: 'simulate.succeeded',
      request_id: 'req_01',
    });
  });

  it('transition 携带 patch 时一并更新白名单字段', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_patch') });
    const patch: TransitionPatch = {
      txHash: '0x' + 'cd'.repeat(32),
      nonce: num('3'),
    };
    const result = await store.transition({
      transactionId: 'txn_patch' as TransactionId,
      expectedStatus: 'built',
      expectedVersion: num('1'),
      toStatus: 'signed',
      reason: 'sign',
      patch,
    });
    expect(result.kind).toBe('applied');
    const loaded = await store.get('txn_patch' as TransactionId);
    expect(loaded!.txHash).toBe('0x' + 'cd'.repeat(32));
    expect(loaded!.nonce).toBe('3');
  });

  it('reorg 回退在同一 CAS 中清空失效的 blockRef 与 canonical hash', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_reorg_clear', {
      status: 'included',
      stateVersion: num('4'),
      blockRef: { kind: 'number', number: num('100') },
      canonicalBlockHash: '0x' + 'ab'.repeat(32),
    }) });
    const result = await store.transition({
      transactionId: 'txn_reorg_clear' as TransactionId,
      expectedStatus: 'included',
      expectedVersion: num('4'),
      toStatus: 'pending',
      reason: 'reorg',
      patch: { blockRef: null, canonicalBlockHash: null },
    });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.record.status).toBe('pending');
      expect(result.record.blockRef).toBeUndefined();
      expect(result.record.canonicalBlockHash).toBeUndefined();
    }
  });

  it('transition 版本不匹配 → version_conflict 并回带当前记录', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_vc', { stateVersion: num('5') }) });
    const result = await store.transition({
      transactionId: 'txn_vc' as TransactionId,
      expectedStatus: 'built',
      expectedVersion: num('2'),
      toStatus: 'simulated',
      reason: 'simulate.succeeded',
    });
    expect(result.kind).toBe('version_conflict');
    if (result.kind === 'version_conflict') expect(result.current.stateVersion).toBe('5');
    // 数据库未被改动。
    expect(await rawRow('txn_vc')).toEqual({ status: 'built', state_version: '5', canonical_block_hash: null });
  });

  it('transition 状态不匹配 → status_conflict', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_sc', { status: 'built' }) });
    const result = await store.transition({
      transactionId: 'txn_sc' as TransactionId,
      expectedStatus: 'signed',
      expectedVersion: num('1'),
      toStatus: 'broadcast',
      reason: 'broadcast.accepted',
    });
    expect(result.kind).toBe('status_conflict');
  });

  it('transition 未知交易 → not_found', async () => {
    await resetRows();
    const result = await store.transition({
      transactionId: 'txn_nope' as TransactionId,
      expectedStatus: 'built',
      expectedVersion: num('1'),
      toStatus: 'simulated',
      reason: 'simulate.succeeded',
    });
    expect(result.kind).toBe('not_found');
  });

  it('行锁确定性验证：前一个事务持有 FOR UPDATE 时，第二个连接必须等待', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_lock') });

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c1.query(`SELECT id FROM ${SCHEMA}.transactions WHERE id = $1 FOR UPDATE`, [
        'txn_lock',
      ]);

      await c2.query('BEGIN');
      let settled = false;
      const pending = c2
        .query(`SELECT id FROM ${SCHEMA}.transactions WHERE id = $1 FOR UPDATE`, ['txn_lock'])
        .then(() => {
          settled = true;
        });

      // 给第二个连接充分时间尝试获取锁；若行锁失效它会立刻完成。
      await new Promise((r) => setTimeout(r, 400));
      expect(settled, '第二个连接未被阻塞：行锁（FOR UPDATE）未生效').toBe(false);

      await c1.query('COMMIT');
      await pending;
      expect(settled, '第一个事务提交后，第二个连接应被放行').toBe(true);
      await c2.query('COMMIT');
    } finally {
      c1.release();
      c2.release();
    }
  });

  it('多连接并发竞争同一 version：恰好一个成功，且版本只前进一格', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_race') });

    // 8 路并发：全部基于同一旧 version 竞争。
    //
    // 用 8 路而不是 2 路，是为了让"丢失更新"无处可藏：若缺少 FOR UPDATE，
    // 多个连接可能都读到 version=1 并各自成功，导致状态被覆盖多次。
    // 2 路时偶发的串行执行会掩盖这个缺陷（见交付报告的变异记录）。
    const CONCURRENCY = 8;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        store.transition({
          transactionId: 'txn_race' as TransactionId,
          expectedStatus: 'built',
          expectedVersion: num('1'),
          toStatus: 'simulated',
          reason: `probe.race.${i}`,
        }),
      ),
    );

    const applied = results.filter((r) => r.kind === 'applied');
    const conflicts = results.filter((r) => r.kind === 'version_conflict');
    expect(applied, '必须恰好一个成功').toHaveLength(1);
    expect(conflicts).toHaveLength(CONCURRENCY - 1);

    // 数据库只前进一格，且只有一条审计行——这是"没有丢失更新"的直接证据。
    const raw = await rawRow('txn_race');
    expect(raw!.state_version).toBe('2');
    expect(await transitionCount('txn_race')).toBe(1);
  });

  it('TX-06: eight competing sign/abandon CAS operations cannot release a signed nonce', async () => {
    await resetRows();
    const id = 'txn_tx06_sign_abandon_pg_race';
    const transactionId = id as TransactionId;
    const nonce = num('77');
    const expectedHash = `0x${'bb'.repeat(32)}`;
    await seedNonceLease(id, nonce);
    await store.create({ record: makeRecord(id, {
      nonce,
      sequencingRef: { kind: 'nonce', value: nonce },
    }) });

    const nonceStore = new PostgresNonceStore(pool);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (async () => {
      if (index % 2 === 0) {
        return { kind: 'sign' as const, result: await store.transition({
          transactionId, expectedStatus: 'built', expectedVersion: num('1'),
          toStatus: 'signed', reason: 'sign', patch: { expectedHash },
        }) };
      }
      const result = await store.transition({
        transactionId, expectedStatus: 'built', expectedVersion: num('1'),
        toStatus: 'abandoned', reason: 'abandon',
      });
      // The production engine only releases after its own durable CAS succeeded.
      if (result.kind === 'applied') {
        const released = await nonceStore.releaseIfSafe({ chain, account: from, nonce, transactionId });
        return { kind: 'abandon' as const, result, released };
      }
      return { kind: 'abandon' as const, result };
    })()));

    const winners = results.filter(({ result }) => result.kind === 'applied');
    expect(winners).toHaveLength(1);
    expect(results.filter(({ result }) => result.kind === 'version_conflict')).toHaveLength(7);
    expect(await transitionCount(id)).toBe(1);
    const { rows } = await inspector.query<{ status: string; transaction_id: string }>(
      `SELECT status, transaction_id FROM ${SCHEMA}.nonce_leases
         WHERE chain_id=$1 AND account_address=$2 AND nonce=$3::numeric`,
      [chain, from.address, nonce],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.transaction_id).toBe(id);
    const status = (await rawRow(id))!.status;
    if (status === 'signed') {
      expect(winners[0]!.kind).toBe('sign');
      expect(rows[0]!.status).toBe('reserved');
      expect((await store.get(transactionId))?.expectedHash).toBe(expectedHash);
    } else {
      expect(status).toBe('abandoned');
      expect(winners[0]!.kind).toBe('abandon');
      expect(rows[0]!.status).toBe('released');
    }
  });

  it('DB-REPLAY-26: dropped 显式重播的并发 CAS 只推进一次且保留签名哈希', async () => {
    await resetRows();
    const id = 'txn_dropped_replay_race';
    const expectedHash = `0x${'bc'.repeat(32)}`;
    await store.create({ record: makeRecord(id, {
      status: 'dropped',
      expectedHash,
      unsignedPayload: '0x02f8',
    }) });

    // 8 个真实 PostgreSQL 连接争用同一个 dropped/version 快照。
    // 任何额外成功都会导致同一签名交易出现重复重播授权。
    const results = await Promise.all(Array.from({ length: 8 }, () => store.transition({
      transactionId: id as TransactionId,
      expectedStatus: 'dropped',
      expectedVersion: num('1'),
      toStatus: 'broadcast',
      reason: 'rebroadcast',
      patch: { expectedHash },
    })));
    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'version_conflict')).toHaveLength(7);
    expect(await rawRow(id)).toEqual({
      status: 'broadcast', state_version: '2', canonical_block_hash: null,
    });
    expect((await store.get(id as TransactionId))?.expectedHash).toBe(expectedHash);
    expect(await transitionCount(id)).toBe(1);
  });

  it('transition 审计写入失败时状态快照回滚（原子提交）', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_atomic') });

    // 安装探针约束，让审计 INSERT 必然失败；验证快照 UPDATE 被一起回滚。
    await inspector.query(
      `ALTER TABLE ${SCHEMA}.transaction_transitions
         ADD CONSTRAINT probe_reject_reason CHECK (reason <> 'probe.reject')`,
    );
    try {
      await expect(
        store.transition({
          transactionId: 'txn_atomic' as TransactionId,
          expectedStatus: 'built',
          expectedVersion: num('1'),
          toStatus: 'simulated',
          reason: 'probe.reject',
        }),
      ).rejects.toThrow(/probe_reject_reason|check constraint/iu);

      // 关键断言：快照必须保持原状。
      expect(await rawRow('txn_atomic')).toEqual({ status: 'built', state_version: '1', canonical_block_hash: null });
      expect(await transitionCount('txn_atomic')).toBe(0);
    } finally {
      await inspector.query(
        `ALTER TABLE ${SCHEMA}.transaction_transitions DROP CONSTRAINT IF EXISTS probe_reject_reason`,
      );
    }
  });

  it('listRecoverable 遵守批次上限并支持键集分页', async () => {
    await resetRows();
    for (let i = 0; i < 7; i += 1) {
      await store.create({
        record: makeRecord(`txn_rec_${i}`, { status: i % 2 === 0 ? 'pending' : 'finalized' }),
      });
    }

    const first = await store.listRecoverable({ limit: 3 });
    expect(first).toHaveLength(3);
    // 默认只返回非终态交易（finalized 属于终态）。
    expect(first.every((r) => r.status !== 'finalized')).toBe(true);

    const second = await store.listRecoverable({
      limit: 3,
      afterTransactionId: first[first.length - 1]!.transactionId,
    });
    // 键集分页：第二批不得重复第一批。
    const firstIds = new Set(first.map((r) => r.transactionId));
    expect(second.some((r) => firstIds.has(r.transactionId))).toBe(false);

    // 显式状态过滤。
    const finalized = await store.listRecoverable({ limit: 10, statuses: ['finalized'] });
    expect(finalized.every((r) => r.status === 'finalized')).toBe(true);
    expect(finalized.length).toBeGreaterThan(0);
  });

  it('listRecoverable 支持 updatedAfter 时间下界（ADR-023 的 dropped 有界观测）', async () => {
    await resetRows();
    // 造一条 updatedAt 明显偏早的 dropped 记录，以及一条新建的 dropped 记录。
    const oldUpdatedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
    await store.create({
      record: makeRecord('txn_old_dropped', {
        status: 'dropped',
        updatedAt: oldUpdatedAt as never,
      }),
    });
    // makeRecord 的默认时间戳是固定的 2026-10-04，必须显式给"现在"，否则两条都偏旧。
    const freshUpdatedAt = new Date().toISOString();
    await store.create({
      record: makeRecord('txn_new_dropped', {
        status: 'dropped',
        createdAt: freshUpdatedAt as never,
        updatedAt: freshUpdatedAt as never,
      }),
    });

    // 时间下界 = 6 小时前 → 只应返回新建的那条。
    const cutoff = new Date(Date.now() - 6 * 3600_000).toISOString() as never;
    const inWindow = await store.listRecoverable({
      limit: 10,
      statuses: ['dropped'],
      updatedAfter: cutoff,
    });
    expect(inWindow.map((r) => r.transactionId)).toEqual(['txn_new_dropped']);

    // 不带时间下界时两条都返回：证明过滤确实来自 updatedAfter，而不是别的条件。
    const all = await store.listRecoverable({ limit: 10, statuses: ['dropped'] });
    expect(all.map((r) => r.transactionId).sort()).toEqual([
      'txn_new_dropped',
      'txn_old_dropped',
    ]);
  });
});
