/**
 * PostgresSequencingStore dual-`pg.Pool` contention test (issue #22 gate 2 leftover).
 *
 * Skipped by default; `pnpm test:db` provides both the migration and runtime DSNs.
 *
 * Why it exists: gate 2's core property — "a signed broadcast lease that has gone reserved→consumed
 * cannot be reclaimed by any worker" — was previously only evidenced by (i) the sweep's SQL predicate
 * (`status='reserved' AND expires_at<=…`, under which consumed is structurally unreachable),
 * (ii) single-Pool multi-connection contention, and (iii) TX-05's dual-pool analogy test.
 * This file supplies the missing link: **two independent `pg.Pool`s** (each with its own connection set,
 * simulating two gateway processes/workers) colliding head-on against the same database, shaped after
 * the TX-05 dual-pool case in `idempotency-store.test.ts`:
 *
 *   (a) consumed leases cannot be reclaimed/expired/revived across pools (after the TTL passes the sweep still cannot touch them,
 *       releaseIfSafe refuses across pools, and replays with the same transactionId are refused across pools);
 *   (b) CAS integrity: concurrent cross-pool reserves with the same transactionId yield exactly one `reserved`,
 *       the rest `reused`, and only one row lands; cross-pool collisions of markConsumed and releaseIfSafe yield
 *       exactly one winner per round (no double-consume, no lost updates);
 *       concurrent dual-pool markConsumed advances only once (the idempotent path produces no second UPDATE);
 *   (c) one pool's sweep never touches the other pool's consumed rows, reclaiming only expired reserved rows.
 *
 * Tests use a separate database, genuinely verifying PostgreSQL row locks / advisory locks / unique constraints,
 * rather than in-process mutexes.
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
 * A well-formed Solana blockhash (base58, 32 bytes).
 *
 * A public on-chain reference containing no secrets; 48 '1's are the base58 representation of 32 zero bytes.
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
    throw new Error(`refusing to run against non-test database "${rows[0]!.db}" (database name must end with _test)`);
  }

  await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${PRIVATE_DB}`);

  const setup = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await setup.connect();
  await runMigrations({ client: setup, migrations: loadMigrations(migrationsDir) });
  await setup.end();

  // Two **independent** Pools = the connection sets of two worker processes unaware of each other.
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
    // The Store pool uses the least-privilege dfr_runtime role; the migrator may not terminate another role,
    // so poll read-only until connections reach zero, then let the database owner DROP normally.
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

describe.skipIf(!ENABLED)('PostgresSequencingStore dual-Pool contention (TX-07 / issue #22 gate 2)', () => {
  it('TX-07 dual-pool: a lease consumed by pool A cannot be sweep-reclaimed, released, or replay-revived by pool B after the TTL passes', async () => {
    await reset();
    const txn = 'txn_mp_consumed_guard';
    const reserved = await reserveOn(storeA, txn, { ttlMs: 250 });
    expect(reserved.kind).toBe('reserved');
    const consumed = await storeA.markConsumed(refFor(txn));
    expect(consumed).toMatchObject({ kind: 'updated', lease: { status: 'consumed' } });

    // The lease TTL has passed: administrative expiry is only meaningful for reserved; consumed is an audit fact.
    await delay(450);

    // The other pool's sweep cannot touch it (this is the only row in the table, so the reclaimed count must be 0).
    await expect(storeB.releaseExpiredOrphaned({ limit: 100 })).resolves.toBe(0);
    expect(await statusOf(txn)).toBe('consumed');

    // The other pool cannot "safely release" it either.
    const release = await storeB.releaseIfSafe(refFor(txn));
    expect(release).toMatchObject({ kind: 'forbidden', reason: 'already_consumed' });
    expect(await statusOf(txn)).toBe('consumed');

    // A cross-pool replay with the same transactionId cannot bring the consumed lease back as a valid lease either.
    await expect(reserveOn(storeB, txn)).rejects.toThrow(/inactive/u);
    expect(await statusOf(txn)).toBe('consumed');

    // This pool's own sweep is likewise a no-op.
    await expect(storeA.releaseExpiredOrphaned({ limit: 100 })).resolves.toBe(0);
    expect(await statusOf(txn)).toBe('consumed');
  });

  it('TX-07 dual-pool: one pool's sweep reclaims only expired reserved rows and never touches consumed rows from either pool', async () => {
    await reset();
    // Pool A reserves, pool B consumes (cross-pool advancement itself must work).
    await reserveOn(storeA, 'txn_mp_sweep_consumed_a', { ttlMs: 250 });
    await expect(storeB.markConsumed(refFor('txn_mp_sweep_consumed_a'))).resolves.toMatchObject({
      kind: 'updated',
      lease: { status: 'consumed' },
    });
    // Pool B's own consumed row.
    await reserveOn(storeB, 'txn_mp_sweep_consumed_b', { ttlMs: 250 });
    await storeB.markConsumed(refFor('txn_mp_sweep_consumed_b'));
    // Control group 1: an expired reserved row (the one that should be reclaimed).
    await reserveOn(storeA, 'txn_mp_sweep_reserved', { ttlMs: 250 });
    // Control group 2: an unexpired reserved row (the sweep must not touch it either).
    await reserveOn(storeB, 'txn_mp_sweep_live', { ttlMs: 60_000 });

    await delay(450);

    // Pool A runs the sweep: exactly 1 row reclaimed (the expired reserved one).
    await expect(storeA.releaseExpiredOrphaned({ limit: 100 })).resolves.toBe(1);
    expect(await statusOf('txn_mp_sweep_consumed_a')).toBe('consumed');
    expect(await statusOf('txn_mp_sweep_consumed_b')).toBe('consumed');
    expect(await statusOf('txn_mp_sweep_reserved')).toBe('expired');
    expect(await statusOf('txn_mp_sweep_live')).toBe('reserved');

    // Pool B sweeps another round: nothing to do, and consumed stays untouched.
    await expect(storeB.releaseExpiredOrphaned({ limit: 100 })).resolves.toBe(0);
    expect(await statusOf('txn_mp_sweep_consumed_a')).toBe('consumed');
    expect(await statusOf('txn_mp_sweep_consumed_b')).toBe('consumed');
  });

  it('TX-07 dual-pool: concurrent cross-pool reserves with the same transactionId — exactly one reserved, the rest reused, only one row lands', async () => {
    await reset();
    const txn = 'txn_mp_reserve_race';
    const contenders = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? storeA : storeB));
    const results = await Promise.all(contenders.map((store) => reserveOn(store, txn)));

    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'reused')).toHaveLength(9);
    // Everyone sees the same lease (the same expiresAt = the same row), not one each.
    const expires = new Set(results.map((r) => r.lease.expiresAt));
    expect(expires.size).toBe(1);
    expect(await rowCount(txn)).toBe('1');
    expect(await statusOf(txn)).toBe('reserved');
  });

  it('TX-07 dual-pool: head-on cross-pool collisions of markConsumed and releaseIfSafe — exactly one winner per round', async () => {
    await reset();
    for (let round = 0; round < 8; round += 1) {
      const txn = `txn_mp_cas_race_${round}`;
      // Alternate which pool reserves and which pool takes the consume/release sides, ruling out single-sided bias.
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
        // Consume wins: release must be refused with already_consumed, and the state stays consumed.
        expect(release).toMatchObject({ kind: 'forbidden', reason: 'already_consumed' });
        expect(finalStatus).toBe('consumed');
      } else {
        // Release wins: mark must be not_found (B40 must not revive a terminal state), and the state stays released.
        expect(mark.kind).toBe('not_found');
        expect(release.kind).toBe('released');
        expect(finalStatus).toBe('released');
      }
      expect(await rowCount(txn)).toBe('1');
    }
  });

  it('TX-07 dual-pool: concurrent dual-pool markConsumed on the same lease — advances only once, and a cross-pool replay does not change updated_at', async () => {
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
    // The idempotent path is read-only: marking consumed again from the other pool must leave updated_at byte-identical —
    // proof the state was advanced only once, with no double-consume-style second UPDATE.
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
