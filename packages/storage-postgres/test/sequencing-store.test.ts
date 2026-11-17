/**
 * PostgresSequencingStore 契约测试（DFR-M3-A01，ADR-032 方案 A）。
 *
 * 默认跳过；`pnpm test:db` 会提供迁移身份 DSN。
 * 测试使用独立数据库，真实验证 PostgreSQL 行锁 / advisory lock / 唯一约束，
 * 而不是进程内互斥。
 *
 * 与 nonce-store 测试的关键区别（这正是 ADR-032 要固定的语义）：
 *   - 多笔交易**可以共享同一个 blockhash**（因此按 token_value 建唯一约束是错的）；
 *   - 租约身份是 transactionId，引用必须带它；
 *   - 过期回收按**租约 TTL**，与 blockhash 的链上有效期（lastValidBlockHeight）无关。
 */
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import type { ChainId, DecimalUint, TransactionId } from '@dfr/types';
import { PostgresSequencingStore } from '../src/sequencing-store.js';
import { loadMigrations, runMigrations } from '../src/migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

const ADMIN_DSN = process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
const RUNTIME_DSN = process.env['DFR_TRANSACTION_DATABASE_URL'];
const ENABLED =
  typeof ADMIN_DSN === 'string' &&
  ADMIN_DSN.length > 0 &&
  typeof RUNTIME_DSN === 'string' &&
  RUNTIME_DSN.length > 0;

const PRIVATE_DB = 'dfr_t_sequencing_test';
const SCHEMA = 'transaction_data';
const chain = 'solana-devnet' as ChainId;
const account = { chain, address: 'So11111111111111111111111111111111111111112' } as const;

/**
 * 一个形状合法的 Solana blockhash（base58，32 字节）。
 *
 * 公开链上引用，不含任何秘密；48 个 '1' 是 32 个零字节的 base58 表示。
 */
const BLOCKHASH = '1'.repeat(48) + '2345'; // secret-scan:allow public-blockhash-placeholder
const BLOCKHASH_B = '2'.repeat(48) + '3456'; // secret-scan:allow public-blockhash-placeholder
const LAST_VALID = '495317734' as DecimalUint;

let admin: Client;
let inspector: Client;
let pool: Pool;
let store: PostgresSequencingStore;

function dsnFor(database: string): string {
  return ADMIN_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

function runtimeDsnFor(database: string): string {
  return RUNTIME_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

async function reset(): Promise<void> {
  // 0006 无外键，CASCADE 不会连带清理本表——必须显式列出。
  await inspector.query(`TRUNCATE ${SCHEMA}.sequencing_leases`);
}

function blockhashToken(value = BLOCKHASH) {
  return { kind: 'blockhash' as const, value, lastValidBlockHeight: LAST_VALID };
}

async function reserve(
  transactionId: string,
  options: { token?: ReturnType<typeof blockhashToken>; ttlMs?: number } = {},
) {
  return store.reserve({
    chain,
    account,
    transactionId: transactionId as TransactionId,
    token: options.token ?? blockhashToken(),
    leaseTtlMs: options.ttlMs ?? 60_000,
  });
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

  const setup = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await setup.connect();
  await runMigrations({ client: setup, migrations: loadMigrations(migrationsDir) });
  await setup.end();

  pool = new Pool({ connectionString: runtimeDsnFor(PRIVATE_DB), max: 25 });
  inspector = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await inspector.connect();
  store = new PostgresSequencingStore(pool);
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  if (inspector) await inspector.end();
  if (pool) await pool.end();
  if (admin) {
    // Store 池使用最小权限 dfr_runtime；migrator 无权终止另一角色，
    // 因此只读轮询到连接归零，再由数据库 owner 普通 DROP。
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { rows } = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1`,
        [PRIVATE_DB],
      );
      if (rows[0]!.count === '0') break;
      await delay(10);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB}`);
    await admin.end();
  }
}, 60_000);

describe.skipIf(!ENABLED)('PostgresSequencingStore（DFR-M3-A01）', () => {
  it('reserve 落库 blockhash 与链高，token 与高度都以字符串返回（禁 number）', async () => {
    await reset();
    const result = await reserve('txn_seq_first');
    expect(result.kind).toBe('reserved');
    expect(result.lease).toMatchObject({
      chain,
      account,
      transactionId: 'txn_seq_first',
      status: 'reserved',
    });
    expect(result.lease.token).toEqual({
      kind: 'blockhash',
      value: BLOCKHASH,
      lastValidBlockHeight: LAST_VALID,
    });
    if (result.lease.token.kind !== 'blockhash') throw new Error('expected blockhash token');
    expect(typeof result.lease.token.lastValidBlockHeight).toBe('string');

    const { rows } = await inspector.query<{ n: string; h: string }>(
      `SELECT token_value AS n, last_valid_block_height::text AS h
         FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`,
      ['txn_seq_first'],
    );
    expect(rows[0]).toEqual({ n: BLOCKHASH, h: LAST_VALID });
  });

  it('多笔交易可共享同一个 blockhash——token 不是身份，transactionId 才是', async () => {
    await reset();
    const first = await reserve('txn_seq_share_a');
    const second = await reserve('txn_seq_share_b', { token: blockhashToken() });

    expect(first.kind).toBe('reserved');
    expect(second.kind).toBe('reserved');
    // 两行都在，token_value 相同——这正是 NonceStore 语义下不可能、Solana 下必需的情形。
    const { rows } = await inspector.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA}.sequencing_leases
        WHERE chain_id = $1 AND account_address = $2 AND token_value = $3`,
      [chain, account.address, BLOCKHASH],
    );
    expect(rows[0]!.count).toBe('2');

    // 消耗其一，不影响另一条租约的状态。
    await store.markConsumed({
      chain,
      account,
      transactionId: 'txn_seq_share_a' as TransactionId,
      tokenValue: BLOCKHASH,
    });
    const other = await inspector.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`,
      ['txn_seq_share_b'],
    );
    expect(other.rows[0]!.status).toBe('reserved');
  });

  it('20 个独立连接并发 reserve 全部成功（blockhash 不互斥），每笔一条租约', async () => {
    await reset();
    const ids = Array.from({ length: 20 }, (_, index) => `txn_seq_c_${index}`);
    const results = await Promise.all(ids.map((id) => reserve(id)));

    expect(results.every((result) => result.kind === 'reserved')).toBe(true);
    const { rows } = await inspector.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA}.sequencing_leases`,
    );
    expect(rows[0]!.count).toBe('20');
    // 全部共享同一 token：blockhash 不是互斥量。
    expect(new Set(results.map((r) => r.lease.token.value))).toEqual(new Set([BLOCKHASH]));
  });

  it('同一 transactionId 并发重放只保留一条租约并返回 reused', async () => {
    await reset();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserve('txn_seq_replay')),
    );

    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'reused')).toHaveLength(7);
    const { rows } = await inspector.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`,
      ['txn_seq_replay'],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('B40：已释放/已消耗/TTL 过期的 blockhash 租约，不得在同 transactionId 重放时作为有效租约返回', async () => {
    for (const state of ['released', 'consumed', 'expired'] as const) {
      await reset();
      const id = `txn_seq_b40_replay_${state}`;
      await reserve(id, { ttlMs: state === 'expired' ? -1 : 60_000 });
      if (state === 'released') {
        expect((await store.releaseIfSafe({
          chain, account, transactionId: id as TransactionId, tokenValue: BLOCKHASH,
        })).kind).toBe('released');
      } else if (state === 'consumed') {
        expect((await store.markConsumed({
          chain, account, transactionId: id as TransactionId, tokenValue: BLOCKHASH,
        })).kind).toBe('updated');
      }
      await expect(reserve(id)).rejects.toThrow(/sequencing.*replay|inactive.*lease/u);
      const { rows } = await inspector.query<{ status: string }>(
        `SELECT status FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`, [id],
      );
      expect(rows[0]?.status).toBe(state === 'expired' ? 'reserved' : state);
    }
  });

  it('B40：原交易重放若携带不同 token/链高，不得复用过去的 blockhash', async () => {
    await reset();
    await reserve('txn_seq_b40_changed_token');
    await expect(reserve('txn_seq_b40_changed_token', {
      token: blockhashToken(BLOCKHASH_B),
    })).rejects.toThrow(/sequencing.*replay|inactive.*lease/u);
    await expect(reserve('txn_seq_b40_changed_token', {
      token: { kind: 'blockhash', value: BLOCKHASH, lastValidBlockHeight: '495317735' as DecimalUint },
    })).rejects.toThrow(/sequencing.*replay|inactive.*lease/u);
  });

  it('B40：markConsumed 不得复活 released/expired 终态租约', async () => {
    for (const state of ['released', 'expired'] as const) {
      await reset();
      const id = `txn_seq_b40_consume_${state}`;
      await reserve(id, { ttlMs: state === 'expired' ? -1 : 60_000 });
      if (state === 'released') {
        await store.releaseIfSafe({
          chain, account, transactionId: id as TransactionId, tokenValue: BLOCKHASH,
        });
      } else {
        expect(await store.releaseExpiredOrphaned({ limit: 10 })).toBe(1);
      }
      await expect(store.markConsumed({
        chain, account, transactionId: id as TransactionId, tokenValue: BLOCKHASH,
      })).resolves.toEqual({ kind: 'not_found' });
      const { rows } = await inspector.query<{ status: string }>(
        `SELECT status FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`, [id],
      );
      expect(rows[0]?.status).toBe(state);
    }
  });

  it('B40：TTL 内且 token 完全一致的同一交易重放仍可合法复用', async () => {
    await reset();
    const first = await reserve('txn_seq_b40_active');
    const again = await reserve('txn_seq_b40_active');
    expect(first.kind).toBe('reserved');
    expect(again.kind).toBe('reused');
    expect(again.lease).toEqual(first.lease);
  });

  it('markConsumed 幂等，且即便 token 已被别家共享也只推进本行', async () => {
    await reset();
    await reserve('txn_seq_consume');
    const ref = {
      chain,
      account,
      transactionId: 'txn_seq_consume' as TransactionId,
      tokenValue: BLOCKHASH,
    };

    const first = await store.markConsumed(ref);
    expect(first).toMatchObject({ kind: 'updated', lease: { status: 'consumed' } });
    const second = await store.markConsumed(ref);
    expect(second).toMatchObject({ kind: 'updated', lease: { status: 'consumed' } });

    // 未知 transactionId → not_found（不静默成功）。
    await expect(
      store.markConsumed({
        chain,
        account,
        transactionId: 'txn_seq_missing' as TransactionId,
        tokenValue: BLOCKHASH,
      }),
    ).resolves.toEqual({ kind: 'not_found' });

    // 引用 token 与租约不一致 → not_found（引用不自洽时 fail-closed）。
    await expect(
      store.markConsumed({
        chain,
        account,
        transactionId: 'txn_seq_consume' as TransactionId,
        tokenValue: BLOCKHASH_B,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it('releaseIfSafe：reserved 可释放；consumed 拒绝（already_consumed）', async () => {
    await reset();
    await reserve('txn_seq_release_ok');
    const released = await store.releaseIfSafe({
      chain,
      account,
      transactionId: 'txn_seq_release_ok' as TransactionId,
      tokenValue: BLOCKHASH,
    });
    expect(released).toMatchObject({ kind: 'released', lease: { status: 'released' } });

    // 幂等：再释放仍返回 released。
    const again = await store.releaseIfSafe({
      chain,
      account,
      transactionId: 'txn_seq_release_ok' as TransactionId,
      tokenValue: BLOCKHASH,
    });
    expect(again).toMatchObject({ kind: 'released', lease: { status: 'released' } });

    await reserve('txn_seq_release_consumed');
    await store.markConsumed({
      chain,
      account,
      transactionId: 'txn_seq_release_consumed' as TransactionId,
      tokenValue: BLOCKHASH,
    });
    const denied = await store.releaseIfSafe({
      chain,
      account,
      transactionId: 'txn_seq_release_consumed' as TransactionId,
      tokenValue: BLOCKHASH,
    });
    expect(denied).toMatchObject({ kind: 'forbidden', reason: 'already_consumed' });
  });

  it('releaseIfSafe：引用 token 不匹配 → forbidden{not_owner}，租约状态不变', async () => {
    await reset();
    await reserve('txn_seq_not_owner');
    const denied = await store.releaseIfSafe({
      chain,
      account,
      transactionId: 'txn_seq_not_owner' as TransactionId,
      tokenValue: BLOCKHASH_B,
    });
    expect(denied).toMatchObject({ kind: 'forbidden', reason: 'not_owner' });

    const { rows } = await inspector.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`,
      ['txn_seq_not_owner'],
    );
    expect(rows[0]!.status).toBe('reserved');
  });

  it('releaseExpiredOrphaned 只回收 TTL 已过的 reserved，consumed 永不回收', async () => {
    await reset();
    await reserve('txn_seq_orphan', { ttlMs: -1 });
    await reserve('txn_seq_live');
    await reserve('txn_seq_consumed', { ttlMs: -1 });
    await store.markConsumed({
      chain,
      account,
      transactionId: 'txn_seq_consumed' as TransactionId,
      tokenValue: BLOCKHASH,
    });

    await expect(store.releaseExpiredOrphaned({ limit: 10 })).resolves.toBe(1);
    const { rows } = await inspector.query<{ transaction_id: string; status: string }>(
      `SELECT transaction_id, status FROM ${SCHEMA}.sequencing_leases ORDER BY transaction_id`,
    );
    expect(rows).toEqual([
      { transaction_id: 'txn_seq_consumed', status: 'consumed' },
      { transaction_id: 'txn_seq_live', status: 'reserved' },
      { transaction_id: 'txn_seq_orphan', status: 'expired' },
    ]);
  });

  it('releaseExpiredOrphaned 的 limit 越界即拒绝（不做无界扫描）', async () => {
    await expect(store.releaseExpiredOrphaned({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.releaseExpiredOrphaned({ limit: 501 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.releaseExpiredOrphaned({ limit: 1.5 })).rejects.toBeInstanceOf(RangeError);
  });

  it('reserve 拒绝非 blockhash token（M3 只服务 Solana）', async () => {
    await reset();
    await expect(
      store.reserve({
        chain,
        account,
        transactionId: 'txn_seq_nonce_kind' as TransactionId,
        token: { kind: 'nonce', value: '1' as DecimalUint },
        leaseTtlMs: 60_000,
      }),
    ).rejects.toThrow(/blockhash/u);
  });

  it('reserve 拒绝 account.chain 与 chain 不一致', async () => {
    await reset();
    await expect(
      store.reserve({
        chain,
        account: { chain: 'ethereum-sepolia' as ChainId, address: account.address },
        transactionId: 'txn_seq_mismatch' as TransactionId,
        token: blockhashToken(),
        leaseTtlMs: 60_000,
      }),
    ).rejects.toThrow(/不一致/u);
  });
});
