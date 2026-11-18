/**
 * PostgresIdempotencyStore contract test (DFR-M1-A10).
 *
 * Authoritative sources: docs/architecture/m1-storage-model.md section 3.3, ADR-015.
 *
 * Skipped by **default**; `pnpm test:db` exports the required DSN.
 *
 * Like the transaction-store test, it builds its own throwaway database (`dfr_t_idem_test`):
 * different test files sharing one database would break each other via schema DROP / TRUNCATE.
 *
 * The two key verifications the task card requires:
 *   1. Two connections begin concurrently, and exactly one acquires;
 *   2. A different fingerprint never overwrites the original record.
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
    throw new Error(`refusing to run against non-test database "${rows[0]!.db}" (database name must end with _test)`);
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
    // Server-side backends do not exit instantly after pool.end(). Wait for connections to drain naturally;
    // do not FORCE/terminate pg clients that are still closing (that produces an unhandled 57P01 error).
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

describe.skipIf(!ENABLED)('PostgresIdempotencyStore (DFR-M1-A10)', () => {
  it('first begin → acquired, record is in_flight', async () => {
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

  it('same key + fingerprint, unfinished → in_flight with a positive retryAfterMs', async () => {
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
      // The lease is 60s, so the remaining time should be close to but not equal to 0.
      expect(second.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('after complete, same key + fingerprint → replayed', async () => {
    await reset();
    // idempotency_records.transaction_id has an FK, so create the parent transaction row first.
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

  it('same key, different fingerprint → conflict, and the original record is never overwritten', async () => {
    await reset();
    await store.begin({ scope: scope('k-conflict'), fingerprint: F1, ownerToken: 'o1', leaseTtlMs: 60_000 });

    const conflicting = await store.begin({
      scope: scope('k-conflict'),
      fingerprint: F2,
      ownerToken: 'o2',
      leaseTtlMs: 60_000,
    });
    expect(conflicting.kind).toBe('conflict');

    // Key assertion: the original record (fingerprint and owner) is unchanged.
    expect(await rawRow('k-conflict')).toMatchObject({ fingerprint: F1, owner_token: 'o1' });
  });

  it('complete with a mismatched owner token → lost_ownership, result is discarded', async () => {
    await reset();
    await store.begin({ scope: scope('k-lost'), fingerprint: F1, ownerToken: 'o1', leaseTtlMs: 60_000 });
    const stale = await store.complete({
      scope: scope('k-lost'),
      ownerToken: 'stale-owner',
      statusCode: 202,
    });
    expect(stale.kind).toBe('lost_ownership');
    // The record is still in_flight, and the owner is unchanged.
    expect(await rawRow('k-lost')).toMatchObject({ state: 'in_flight', owner_token: 'o1' });
  });

  it('complete with an unknown scope → not_found', async () => {
    await reset();
    const result = await store.complete({
      scope: scope('k-none'),
      ownerToken: 'o1',
      statusCode: 202,
    });
    expect(result.kind).toBe('not_found');
  });

  it('after the lease expires, a new owner can take over (acquired) and replace the owner token', async () => {
    await reset();
    // The TTL must be legal and positive; build an already-expired lease with the test database clock.
    // Negative TTLs may no longer be passed: the safety boundary fails closed explicitly at the begin() entry point.
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

    // The old owner has lost ownership and can no longer complete.
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

  it('concurrent begin from many connections: exactly one acquired, the rest in_flight', async () => {
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

    // Exactly one row should exist.
    const { rows } = await inspector.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${SCHEMA}.idempotency_records
        WHERE key = 'k-concurrent'`,
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('get returns the record; missing returns null', async () => {
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

  it('pruneExpired follows the record retention period (expires_at), not the lease, and respects the batch cap', async () => {
    await reset();

    // 1) Lease expired but retention period not reached: must **not** be cleaned up.
    //    This assertion pins down the two distinct concepts "lease expired (takeover allowed)" and "record expired (cleanup allowed)" in the test.
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
    // 3) Two valid records.
    for (let i = 0; i < 2; i += 1) {
      await store.begin({
        scope: scope(`k-live-${i}`),
        fingerprint: F1,
        ownerToken: `l${i}`,
        leaseTtlMs: 60_000,
      });
    }

    // Batch cap of 2: the first pass deletes only 2 rows.
    expect(await store.pruneExpired({ limit: 2 })).toBe(2);
    // The second pass deletes the remaining 1 row.
    expect(await store.pruneExpired({ limit: 2 })).toBe(1);
    // Valid records are unaffected.
    expect(await store.get(scope('k-live-0'))).not.toBeNull();
    expect(await store.get(scope('k-expired-0'))).toBeNull();
    // Records with expired leases are still there (within retention).
    expect(await store.get(scope('k-lease-expired-only'))).not.toBeNull();
  });
});
