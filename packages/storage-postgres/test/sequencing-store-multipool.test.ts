/**
 * PostgresSequencingStore 双 `pg.Pool` 争用测试（issue #22 门禁 2 残留项）。
 *
 * 默认跳过；`pnpm test:db` 会提供迁移/运行时两套 DSN。
 *
 * 为什么存在：门禁 2 的核心性质——"已 reserved→consumed 的签名广播租约
 * 不能被任何 worker 回收"——此前只由 (i) sweep 的 SQL 谓词
 * （`status='reserved' AND expires_at<=…`，consumed 结构性不可达）、
 * (ii) 单 Pool 多连接竞争、(iii) TX-05 的双池类比测试旁证。
 * 本文件补上缺失的一环：**两个独立 `pg.Pool`**（各自独立的连接集，
 * 模拟两个网关进程/worker）对同一数据库正面对撞，形状借鉴
 * `idempotency-store.test.ts` 的 TX-05 双池用例：
 *
 *   (a) consumed 租约跨池不可回收/过期/复活（TTL 过后 sweep 仍碰不到、
 *       releaseIfSafe 跨池拒绝、同 transactionId 重放跨池拒绝）；
 *   (b) CAS 完整性：同 transactionId 跨池并发 reserve 恰好一个 `reserved`、
 *       其余 `reused`、只落一行；markConsumed 与 releaseIfSafe 跨池对撞
 *       每轮恰好一个胜者（无 double-consume、无丢失更新）；
 *       双池并发 markConsumed 只推进一次（幂等路径不产生第二次 UPDATE）；
 *   (c) 一池的 sweep 绝不触碰另一池产生的 consumed，只回收过期的 reserved。
 *
 * 测试使用独立数据库，真实验证 PostgreSQL 行锁 / advisory lock / 唯一约束，
 * 而不是进程内互斥。
 */
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import type { ChainId, DecimalUint, TransactionId } from '@dfr/types';
import type { SequencingLeaseRef } from '@dfr/transaction';
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

const PRIVATE_DB = 'dfr_t_seq_multipool_test';
const SCHEMA = 'transaction_data';
const chain = 'solana-devnet' as ChainId;
const account = { chain, address: 'So11111111111111111111111111111111111111112' } as const;

/**
 * 一个形状合法的 Solana blockhash（base58，32 字节）。
 *
 * 公开链上引用，不含任何秘密；48 个 '1' 是 32 个零字节的 base58 表示。
 */
const BLOCKHASH = '1'.repeat(48) + '2345'; // secret-scan:allow public-blockhash-placeholder
const LAST_VALID = '495317734' as DecimalUint;

let admin: Client;
let inspector: Client;
let poolA: Pool;
let poolB: Pool;
let storeA: PostgresSequencingStore;
let storeB: PostgresSequencingStore;

function dsnFor(database: string): string {
  return ADMIN_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

function runtimeDsnFor(database: string): string {
  return RUNTIME_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

async function reset(): Promise<void> {
  await inspector.query(`TRUNCATE ${SCHEMA}.sequencing_leases`);
}

function blockhashToken(value = BLOCKHASH) {
  return { kind: 'blockhash' as const, value, lastValidBlockHeight: LAST_VALID };
}

async function reserveOn(
  store: PostgresSequencingStore,
  transactionId: string,
  options: { ttlMs?: number } = {},
) {
  return store.reserve({
    chain,
    account,
    transactionId: transactionId as TransactionId,
    token: blockhashToken(),
    leaseTtlMs: options.ttlMs ?? 60_000,
  });
}

function refFor(transactionId: string): SequencingLeaseRef {
  return {
    chain,
    account,
    transactionId: transactionId as TransactionId,
    tokenValue: BLOCKHASH,
  };
}

async function statusOf(transactionId: string): Promise<string | undefined> {
  const { rows } = await inspector.query<{ status: string }>(
    `SELECT status FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`,
    [transactionId],
  );
  return rows[0]?.status;
}

async function rowCount(transactionId: string): Promise<string> {
  const { rows } = await inspector.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`,
    [transactionId],
  );
  return rows[0]!.n;
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

  // 两个**独立**的 Pool = 两个互不知情的 worker 进程的连接集。
  poolA = new Pool({ connectionString: runtimeDsnFor(PRIVATE_DB), max: 10 });
  poolB = new Pool({ connectionString: runtimeDsnFor(PRIVATE_DB), max: 10 });
  inspector = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await inspector.connect();
  storeA = new PostgresSequencingStore(poolA);
  storeB = new PostgresSequencingStore(poolB);
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  if (inspector) await inspector.end();
  if (poolA) await poolA.end();
  if (poolB) await poolB.end();
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

describe.skipIf(!ENABLED)('PostgresSequencingStore 双 Pool 争用（TX-07 / issue #22 门禁 2）', () => {
  it('TX-07 双池：A 池 consumed 的租约在 TTL 过后不能被 B 池 sweep 回收、释放或重放复活', async () => {
    await reset();
    const txn = 'txn_mp_consumed_guard';
    const reserved = await reserveOn(storeA, txn, { ttlMs: 250 });
    expect(reserved.kind).toBe('reserved');
    const consumed = await storeA.markConsumed(refFor(txn));
    expect(consumed).toMatchObject({ kind: 'updated', lease: { status: 'consumed' } });

    // 租约 TTL 已过：行政过期只对 reserved 有意义，consumed 是审计事实。
    await delay(450);

    // 对方 Pool 的 sweep 碰不到它（表里只有这一行，回收数必须为 0）。
    await expect(storeB.releaseExpiredOrphaned({ limit: 100 })).resolves.toBe(0);
    expect(await statusOf(txn)).toBe('consumed');

    // 对方 Pool 也不能把它"安全释放"掉。
    const release = await storeB.releaseIfSafe(refFor(txn));
    expect(release).toMatchObject({ kind: 'forbidden', reason: 'already_consumed' });
    expect(await statusOf(txn)).toBe('consumed');

    // 同 transactionId 跨池重放也不能把 consumed 租约当有效租约拿回来。
    await expect(reserveOn(storeB, txn)).rejects.toThrow(/inactive/u);
    expect(await statusOf(txn)).toBe('consumed');

    // 本池 sweep 同样无-op。
    await expect(storeA.releaseExpiredOrphaned({ limit: 100 })).resolves.toBe(0);
    expect(await statusOf(txn)).toBe('consumed');
  });

  it('TX-07 双池：一池的 sweep 只回收过期的 reserved，绝不触碰两池产生的 consumed', async () => {
    await reset();
    // A 池 reserve、B 池 consume（跨池推进本身必须成立）。
    await reserveOn(storeA, 'txn_mp_sweep_consumed_a', { ttlMs: 250 });
    await expect(storeB.markConsumed(refFor('txn_mp_sweep_consumed_a'))).resolves.toMatchObject({
      kind: 'updated',
      lease: { status: 'consumed' },
    });
    // B 池自己的 consumed。
    await reserveOn(storeB, 'txn_mp_sweep_consumed_b', { ttlMs: 250 });
    await storeB.markConsumed(refFor('txn_mp_sweep_consumed_b'));
    // 对照组 1：已过期的 reserved（应被回收的那一行）。
    await reserveOn(storeA, 'txn_mp_sweep_reserved', { ttlMs: 250 });
    // 对照组 2：未过期的 reserved（sweep 同样不许碰）。
    await reserveOn(storeB, 'txn_mp_sweep_live', { ttlMs: 60_000 });

    await delay(450);

    // 由 A 池发起 sweep：恰好回收 1 行（过期的 reserved）。
    await expect(storeA.releaseExpiredOrphaned({ limit: 100 })).resolves.toBe(1);
    expect(await statusOf('txn_mp_sweep_consumed_a')).toBe('consumed');
    expect(await statusOf('txn_mp_sweep_consumed_b')).toBe('consumed');
    expect(await statusOf('txn_mp_sweep_reserved')).toBe('expired');
    expect(await statusOf('txn_mp_sweep_live')).toBe('reserved');

    // B 池再 sweep 一轮：无事可做，且 consumed 依旧纹丝不动。
    await expect(storeB.releaseExpiredOrphaned({ limit: 100 })).resolves.toBe(0);
    expect(await statusOf('txn_mp_sweep_consumed_a')).toBe('consumed');
    expect(await statusOf('txn_mp_sweep_consumed_b')).toBe('consumed');
  });

  it('TX-07 双池：同一 transactionId 跨池并发 reserve——恰好一个 reserved、其余 reused、只落一行', async () => {
    await reset();
    const txn = 'txn_mp_reserve_race';
    const contenders = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? storeA : storeB));
    const results = await Promise.all(contenders.map((store) => reserveOn(store, txn)));

    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'reused')).toHaveLength(9);
    // 所有人看到的是同一条租约（同一个 expiresAt = 同一行），不是各自一份。
    const expires = new Set(results.map((r) => r.lease.expiresAt));
    expect(expires.size).toBe(1);
    expect(await rowCount(txn)).toBe('1');
    expect(await statusOf(txn)).toBe('reserved');
  });

  it('TX-07 双池：markConsumed 与 releaseIfSafe 跨池正面对撞——每轮恰好一个胜者', async () => {
    await reset();
    for (let round = 0; round < 8; round += 1) {
      const txn = `txn_mp_cas_race_${round}`;
      // 交替由不同池 reserve、不同池担任 consume/release 两侧，排除单侧偏差。
      const reserver = round % 2 === 0 ? storeA : storeB;
      const consumer = round % 2 === 0 ? storeB : storeA;
      const releaser = round % 2 === 0 ? storeA : storeB;
      await reserveOn(reserver, txn);

      const [mark, release] = await Promise.all([
        consumer.markConsumed(refFor(txn)),
        releaser.releaseIfSafe(refFor(txn)),
      ]);

      const finalStatus = await statusOf(txn);
      if (mark.kind === 'updated') {
        // consume 胜：release 必须被 already_consumed 拒绝，状态停在 consumed。
        expect(release).toMatchObject({ kind: 'forbidden', reason: 'already_consumed' });
        expect(finalStatus).toBe('consumed');
      } else {
        // release 胜：mark 必须 not_found（B40 不得复活终态），状态停在 released。
        expect(mark.kind).toBe('not_found');
        expect(release.kind).toBe('released');
        expect(finalStatus).toBe('released');
      }
      expect(await rowCount(txn)).toBe('1');
    }
  });

  it('TX-07 双池：双池并发 markConsumed 同一租约——只推进一次，跨池重放不改 updated_at', async () => {
    await reset();
    const txn = 'txn_mp_consume_once';
    await reserveOn(storeA, txn);

    const attempts = [storeA, storeB, storeA, storeB, storeA, storeB];
    const results = await Promise.all(attempts.map((store) => store.markConsumed(refFor(txn))));
    for (const result of results) {
      expect(result).toMatchObject({ kind: 'updated', lease: { status: 'consumed' } });
    }
    expect(await rowCount(txn)).toBe('1');

    const { rows: before } = await inspector.query<{ updated_at: string }>(
      `SELECT updated_at::text AS updated_at FROM ${SCHEMA}.sequencing_leases
        WHERE transaction_id = $1`,
      [txn],
    );
    // 幂等路径只读不写：再从另一池 markConsumed，updated_at 必须逐字不变——
    // 证明状态只被推进过一次，没有 double-consume 式的第二次 UPDATE。
    await expect(storeB.markConsumed(refFor(txn))).resolves.toMatchObject({ kind: 'updated' });
    const { rows: after } = await inspector.query<{ updated_at: string }>(
      `SELECT updated_at::text AS updated_at FROM ${SCHEMA}.sequencing_leases
        WHERE transaction_id = $1`,
      [txn],
    );
    expect(after[0]!.updated_at).toBe(before[0]!.updated_at);
    expect(await statusOf(txn)).toBe('consumed');
  });
});
