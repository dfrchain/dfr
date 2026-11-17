/**
 * PostgresIdempotencyStore 契约测试（DFR-M1-A10）。
 *
 * 权威来源：docs/architecture/m1-storage-model.md 第 3.3 节、ADR-015。
 *
 * 默认**跳过**；`pnpm test:db` 会导出所需 DSN。
 *
 * 与 transaction-store 测试同样自建一次性数据库（`dfr_t_idem_test`）：
 * 不同测试文件共用数据库会因 schema DROP / TRUNCATE 互相破坏。
 *
 * 任务卡要求的两个关键验证：
 *   1. 两个连接并发 begin，只有一个 acquire；
 *   2. 不同 fingerprint 永不覆盖原记录。
 */
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import type { ChainId, TransactionId } from '@dfr/types';
import type { IdempotencyScope } from '@dfr/transaction';
import { PostgresIdempotencyStore } from '../src/idempotency-store.js';
import { loadMigrations, runMigrations } from '../src/migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');

const ADMIN_DSN = process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
const ENABLED = typeof ADMIN_DSN === 'string' && ADMIN_DSN.length > 0;

const PRIVATE_DB = 'dfr_t_idem_test';
const SCHEMA = 'transaction_data';
const chain = 'ethereum-sepolia' as ChainId;

let admin: Client;
let inspector: Client;
let pool: Pool;
let store: PostgresIdempotencyStore;

function dsnFor(database: string): string {
  return ADMIN_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

function scope(key: string): IdempotencyScope {
  return { projectId: 'default', chain, key };
}

describe('idempotency duration fail-closed guards', () => {
  const noDatabase = {} as Pool;

  it('rejects invalid record TTL before any SQL', () => {
    for (const recordTtlMs of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new PostgresIdempotencyStore(noDatabase, { recordTtlMs })).toThrow(RangeError);
    }
  });

  it('rejects invalid lease TTL without issuing SQL', async () => {
    const isolated = new PostgresIdempotencyStore(noDatabase);
    for (const leaseTtlMs of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        isolated.begin({ scope: scope('invalid-lease'), fingerprint: F1, ownerToken: 'x', leaseTtlMs }),
      ).rejects.toThrow(RangeError);
    }
  });
});

const F1 = 'f'.repeat(64);
const F2 = 'e'.repeat(64);

async function reset(): Promise<void> {
  await inspector.query(`TRUNCATE ${SCHEMA}.idempotency_records CASCADE`);
}

async function rawRow(key: string): Promise<
  { fingerprint: string; state: string; owner_token: string } | undefined
> {
  const { rows } = await inspector.query<{
    fingerprint: string;
    state: string;
    owner_token: string;
  }>(
    `SELECT fingerprint, state, owner_token FROM ${SCHEMA}.idempotency_records
      WHERE project_id='default' AND chain_id=$1 AND key=$2`,
    [chain, key],
  );
  return rows[0];
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

  pool = new Pool({ connectionString: dsnFor(PRIVATE_DB), max: 10 });
  inspector = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await inspector.connect();
  store = new PostgresIdempotencyStore(pool);
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  if (inspector) await inspector.end();
  if (pool) await pool.end();
  if (admin) {
    // pool.end() 后服务器端 backend 的退出不是瞬时的。等待连接自然归零，
    // 不用 FORCE/terminate 强杀仍在关闭的 pg client（会产生 57P01 未处理异常）。
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

describe.skipIf(!ENABLED)('PostgresIdempotencyStore（DFR-M1-A10）', () => {
  it('首次 begin → acquired，记录为 in_flight', async () => {
    await reset();
    const result = await store.begin({
      scope: scope('k-acquire'),
      fingerprint: F1,
      ownerToken: 'owner-1',
      leaseTtlMs: 30_000,
    });
    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') {
      expect(result.record.state).toBe('in_flight');
      expect(result.record.ownerToken).toBe('owner-1');
    }
    expect(await rawRow('k-acquire')).toMatchObject({ fingerprint: F1, state: 'in_flight' });
  });

  it('同键同指纹未完成 → in_flight 且给出正数 retryAfterMs', async () => {
    await reset();
    await store.begin({ scope: scope('k-inflight'), fingerprint: F1, ownerToken: 'o1', leaseTtlMs: 60_000 });
    const second = await store.begin({
      scope: scope('k-inflight'),
      fingerprint: F1,
      ownerToken: 'o2',
      leaseTtlMs: 60_000,
    });
    expect(second.kind).toBe('in_flight');
    if (second.kind === 'in_flight') {
      expect(second.retryAfterMs).toBeGreaterThan(0);
      // 租约 60s，剩余时间应接近但不等于 0。
      expect(second.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('complete 后同键同指纹 → replayed', async () => {
    await reset();
    // idempotency_records.transaction_id 有 FK，先建父交易行。
    await inspector.query(
      `INSERT INTO ${SCHEMA}.transactions
         (id, project_id, chain_id, request_fingerprint, status, from_address)
       VALUES ('txn_x', 'default', $1, $2, 'broadcast', '0xabc')
       ON CONFLICT (id) DO NOTHING`,
      [chain, 'a'.repeat(64)],
    );
    await store.begin({ scope: scope('k-replay'), fingerprint: F1, ownerToken: 'o1', leaseTtlMs: 60_000 });
    const done = await store.complete({
      scope: scope('k-replay'),
      ownerToken: 'o1',
      statusCode: 202,
      responseBody: { transactionId: 'txn_x' },
      transactionId: 'txn_x' as TransactionId,
    });
    expect(done.kind).toBe('completed');

    const replay = await store.begin({
      scope: scope('k-replay'),
      fingerprint: F1,
      ownerToken: 'o2',
      leaseTtlMs: 60_000,
    });
    expect(replay.kind).toBe('replayed');
    if (replay.kind === 'replayed') {
      expect(replay.record.statusCode).toBe(202);
      expect(replay.record.transactionId).toBe('txn_x');
      expect(replay.record.responseBody).toEqual({ transactionId: 'txn_x' });
    }
  });

  it('同键不同指纹 → conflict，且原记录永不被覆盖', async () => {
    await reset();
    await store.begin({ scope: scope('k-conflict'), fingerprint: F1, ownerToken: 'o1', leaseTtlMs: 60_000 });

    const conflicting = await store.begin({
      scope: scope('k-conflict'),
      fingerprint: F2,
      ownerToken: 'o2',
      leaseTtlMs: 60_000,
    });
    expect(conflicting.kind).toBe('conflict');

    // 关键断言：原记录（fingerprint 与 owner）未被改动。
    expect(await rawRow('k-conflict')).toMatchObject({ fingerprint: F1, owner_token: 'o1' });
  });

  it('complete 时 owner token 不匹配 → lost_ownership，结果被丢弃', async () => {
    await reset();
    await store.begin({ scope: scope('k-lost'), fingerprint: F1, ownerToken: 'o1', leaseTtlMs: 60_000 });
    const stale = await store.complete({
      scope: scope('k-lost'),
      ownerToken: 'stale-owner',
      statusCode: 202,
    });
    expect(stale.kind).toBe('lost_ownership');
    // 记录仍为 in_flight，且 owner 未变。
    expect(await rawRow('k-lost')).toMatchObject({ state: 'in_flight', owner_token: 'o1' });
  });

  it('complete 未知 scope → not_found', async () => {
    await reset();
    const result = await store.complete({
      scope: scope('k-none'),
      ownerToken: 'o1',
      statusCode: 202,
    });
    expect(result.kind).toBe('not_found');
  });

  it('租约过期后新 owner 可接管（acquired），并换掉 owner token', async () => {
    await reset();
    // TTL 必须合法且为正数；用测试库时钟构造已过期的租约。
    // 不能再传负 TTL：安全边界在 begin() 入口明确 fail-closed。
    await store.begin({ scope: scope('k-takeover'), fingerprint: F1, ownerToken: 'old', leaseTtlMs: 60_000 });
    const expired = await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records
          SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE project_id = 'default' AND chain_id = $1 AND key = $2`,
      [chain, 'k-takeover'],
    );
    expect(expired.rowCount).toBe(1);

    const taken = await store.begin({
      scope: scope('k-takeover'),
      fingerprint: F1,
      ownerToken: 'new',
      leaseTtlMs: 60_000,
    });
    expect(taken.kind).toBe('acquired');
    expect(await rawRow('k-takeover')).toMatchObject({ state: 'in_flight', owner_token: 'new' });

    // 旧 owner 已失去所有权，不能再完成。
    const stale = await store.complete({
      scope: scope('k-takeover'),
      ownerToken: 'old',
      statusCode: 202,
    });
    expect(stale.kind).toBe('lost_ownership');
  });

  it('TX-05: an expired owner must not complete an abandoned in_flight lease even before takeover', async () => {
    await reset();
    await store.begin({ scope: scope('k-expired-complete'), fingerprint: F1, ownerToken: 'stale', leaseTtlMs: 60_000 });
    await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records
          SET lease_expires_at = clock_timestamp() - INTERVAL '2 seconds'
        WHERE key = 'k-expired-complete'`,
    );
    const result = await store.complete({
      scope: scope('k-expired-complete'), ownerToken: 'stale', statusCode: 201,
    });
    expect(result.kind).toBe('lost_ownership');
    expect(await rawRow('k-expired-complete')).toMatchObject({
      state: 'in_flight', owner_token: 'stale',
    });
  });

  it('TX-05: separate PostgreSQL pools contend for one expired claim; exactly one wins and stale worker is fenced', async () => {
    await reset();
    const key = 'k-two-pools-expired';
    await store.begin({ scope: scope(key), fingerprint: F1, ownerToken: 'stale', leaseTtlMs: 60_000 });
    await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records SET lease_expires_at = clock_timestamp() - INTERVAL '2 seconds'
         WHERE key = $1`, [key],
    );
    const otherPool = new Pool({ connectionString: dsnFor(PRIVATE_DB), max: 5 });
    try {
      const other = new PostgresIdempotencyStore(otherPool);
      const contenders = Array.from({ length: 12 }, (_, i) => ({
        owner: `contender-${i}`, store: i % 2 === 0 ? store : other,
      }));
      const results = await Promise.all(contenders.map((c) =>
        c.store.begin({ scope: scope(key), fingerprint: F1, ownerToken: c.owner, leaseTtlMs: 60_000 }),
      ));
      expect(results.filter((r) => r.kind === 'acquired')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'in_flight')).toHaveLength(11);
      const winner = results.find((r) => r.kind === 'acquired');
      expect(winner?.kind).toBe('acquired');
      if (winner?.kind !== 'acquired') throw new Error('no winning owner');
      const currentOwner = winner.record.ownerToken;
      expect(await rawRow(key)).toMatchObject({ owner_token: currentOwner, state: 'in_flight' });

      const stale = await store.complete({ scope: scope(key), ownerToken: 'stale', statusCode: 202 });
      expect(stale.kind).toBe('lost_ownership');

      const loser = contenders.find((c) => c.owner !== currentOwner)!;
      const denied = await loser.store.complete({ scope: scope(key), ownerToken: loser.owner, statusCode: 202 });
      expect(denied.kind).toBe('lost_ownership');

      const won = await other.complete({ scope: scope(key), ownerToken: currentOwner, statusCode: 201 });
      expect(won.kind).toBe('completed');

      const replay = await store.begin({ scope: scope(key), fingerprint: F1, ownerToken: 'later', leaseTtlMs: 60_000 });
      expect(replay.kind).toBe('replayed');
      const { rows } = await inspector.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${SCHEMA}.idempotency_records WHERE key = $1`, [key],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await otherPool.end();
    }
  });

  it('TX-05: a durable transaction binding survives owner lease expiry and two-pool recovery without duplicate acquire', async () => {
    await reset();
    const key = 'k-durable-before-complete';
    const txId = 'txn_tx05_durable';
    await store.begin({ scope: scope(key), fingerprint: F1, ownerToken: 'crashed', leaseTtlMs: 60_000 });
    await inspector.query(
      `INSERT INTO ${SCHEMA}.transactions
        (id, project_id, chain_id, request_fingerprint, status, from_address, unsigned_payload, payload_encoding)
       VALUES ($1, 'default', $2, $3, 'built', '0xabc', '0x01', 'hex')`,
      [txId, chain, F1],
    );
    await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records
         SET transaction_id = $2, lease_expires_at = clock_timestamp() - INTERVAL '2 seconds'
       WHERE key = $1`, [key, txId],
    );
    const otherPool = new Pool({ connectionString: dsnFor(PRIVATE_DB), max: 3 });
    try {
      const otherStore = new PostgresIdempotencyStore(otherPool);
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? store : otherStore).begin({
            scope: scope(key), fingerprint: F1, ownerToken: `restarted-${i}`, leaseTtlMs: 60_000,
          }),
        ),
      );
      expect(attempts.every((result) => result.kind === 'replayed')).toBe(true);
      for (const result of attempts) {
        if (result.kind === 'replayed') {
          expect(result.record.transactionId).toBe(txId);
        }
      }
      expect(await rawRow(key)).toMatchObject({ state: 'completed', owner_token: 'crashed' });
      const { rows } = await inspector.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${SCHEMA}.transactions WHERE id = $1`, [txId],
      );
      expect(rows[0]?.n).toBe('1');
    } finally {
      await otherPool.end();
    }
  });

  it('多连接并发 begin：恰好一个 acquired，其余 in_flight', async () => {
    await reset();
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.begin({
          scope: scope('k-concurrent'),
          fingerprint: F1,
          ownerToken: `owner-${i}`,
          leaseTtlMs: 60_000,
        }),
      ),
    );
    expect(results.filter((r) => r.kind === 'acquired')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'in_flight')).toHaveLength(N - 1);

    // 只应存在一行。
    const { rows } = await inspector.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SCHEMA}.idempotency_records
        WHERE key = 'k-concurrent'`,
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('get 返回记录；未找到返回 null', async () => {
    await reset();
    expect(await store.get(scope('k-missing'))).toBeNull();
    await store.begin({ scope: scope('k-get'), fingerprint: F1, ownerToken: 'o1', leaseTtlMs: 60_000 });
    const found = await store.get(scope('k-get'));
    expect(found).not.toBeNull();
    expect(found!.fingerprint).toBe(F1);
  });

  it('TX-05: pruning must not erase an expired in-flight key with durable transaction binding', async () => {
    await reset();
    const key = 'k-prune-bound-active';
    const txId = 'txn_prune_active';
    await store.begin({ scope: scope(key), fingerprint: F1, ownerToken: 'crashed-before-complete', leaseTtlMs: 60_000 });
    await inspector.query(
      `INSERT INTO ${SCHEMA}.transactions
         (id, project_id, chain_id, request_fingerprint, status, from_address, unsigned_payload, payload_encoding)
       VALUES ($1, 'default', $2, $3, 'built', '0xabc', '0x01', 'hex')`,
      [txId, chain, F1],
    );
    await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records
          SET transaction_id = $2,
              lease_expires_at = clock_timestamp() - INTERVAL '2 seconds',
              expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE key = $1`, [key, txId],
    );

    // The old TTL-only SQL removed the lease, turning a single durable
    // transaction into a fresh key that could create a second transaction.
    expect(await store.pruneExpired({ limit: 100 })).toBe(0);
    const otherPool = new Pool({ connectionString: dsnFor(PRIVATE_DB), max: 2 });
    try {
      const anotherWorker = new PostgresIdempotencyStore(otherPool);
      const result = await anotherWorker.begin({
        scope: scope(key), fingerprint: F1, ownerToken: 'restarted-worker', leaseTtlMs: 60_000,
      });
      expect(result.kind).toBe('replayed');
      if (result.kind === 'replayed') expect(result.record.transactionId).toBe(txId);
      expect(await rawRow(key)).toMatchObject({ state: 'completed' });
    } finally {
      await otherPool.end();
    }
  });

  it('TX-05: expiry cleanup cannot erase a pending key even before a transaction ID was persisted', async () => {
    await reset();
    const key = 'k-prune-still-in-flight';
    await store.begin({ scope: scope(key), fingerprint: F1, ownerToken: 'slow-worker', leaseTtlMs: 60_000 });
    await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records
         SET expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE key = $1`, [key],
    );
    expect(await store.pruneExpired({ limit: 10 })).toBe(0);
    const result = await store.begin({
      scope: scope(key), fingerprint: F1, ownerToken: 'another-worker', leaseTtlMs: 60_000,
    });
    expect(result.kind).toBe('in_flight');
    expect(await rawRow(key)).toMatchObject({ owner_token: 'slow-worker' });

    // Once that lease expires too, a new worker must use the original
    // fingerprint-locked row and conditional SQL takeover, never a fresh INSERT.
    await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records
         SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE key = $1`, [key],
    );
    expect(await store.pruneExpired({ limit: 10 })).toBe(0);
    const takenOver = await store.begin({
      scope: scope(key), fingerprint: F1, ownerToken: 'recovered-worker', leaseTtlMs: 60_000,
    });
    expect(takenOver.kind).toBe('acquired');
    expect(await rawRow(key)).toMatchObject({ owner_token: 'recovered-worker' });
    const { rows } = await inspector.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SCHEMA}.idempotency_records WHERE key = $1`, [key],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('pruneExpired 依据记录保留期（expires_at）而非租约，并遵守批次上限', async () => {
    await reset();

    // ① 租约已过期但记录保留期未到：**不得**被清理。
    //    这条断言把"租约过期（可接管）"与"记录过期（可清理）"两个概念钉死在测试里。
    await store.begin({
      scope: scope('k-lease-expired-only'),
      fingerprint: F1,
      ownerToken: 'o0',
      leaseTtlMs: 60_000,
    });
    const expiredLease = await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records
          SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE project_id = 'default' AND chain_id = $1 AND key = $2`,
      [chain, 'k-lease-expired-only'],
    );
    expect(expiredLease.rowCount).toBe(1);
    expect(await store.pruneExpired({ limit: 10 })).toBe(0);
    expect(await store.get(scope('k-lease-expired-only'))).not.toBeNull();

    // ② Only completed records can be cleaned up after their retention
    // deadline. Nonterminal records must remain recoverable, even past TTL.
    const expiredStore = new PostgresIdempotencyStore(pool, { recordTtlMs: 60_000 });
    const expiredKeys = Array.from({ length: 3 }, (_, i) => `k-expired-${i}`);
    for (let i = 0; i < expiredKeys.length; i += 1) {
      await expiredStore.begin({
        scope: scope(expiredKeys[i]!),
        fingerprint: F1,
        ownerToken: `o${i}`,
        leaseTtlMs: 60_000,
      });
      const completed = await expiredStore.complete({
        scope: scope(expiredKeys[i]!),
        ownerToken: `o${i}`,
        statusCode: 201,
        responseBody: { ok: true },
      });
      expect(completed.kind).toBe('completed');
    }
    const expiredRecords = await inspector.query(
      `UPDATE ${SCHEMA}.idempotency_records
          SET expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE project_id = 'default' AND chain_id = $1 AND key = ANY($2::text[])`,
      [chain, expiredKeys],
    );
    expect(expiredRecords.rowCount).toBe(3);
    // ③ 两条有效记录。
    for (let i = 0; i < 2; i += 1) {
      await store.begin({
        scope: scope(`k-live-${i}`),
        fingerprint: F1,
        ownerToken: `l${i}`,
        leaseTtlMs: 60_000,
      });
    }

    // 批次上限 2：第一次只删 2 条。
    expect(await store.pruneExpired({ limit: 2 })).toBe(2);
    // 第二次删掉剩余 1 条。
    expect(await store.pruneExpired({ limit: 2 })).toBe(1);
    // 有效记录不受影响。
    expect(await store.get(scope('k-live-0'))).not.toBeNull();
    expect(await store.get(scope('k-expired-0'))).toBeNull();
    // 租约过期的记录仍然在（保留期内）。
    expect(await store.get(scope('k-lease-expired-only'))).not.toBeNull();
  });
});
