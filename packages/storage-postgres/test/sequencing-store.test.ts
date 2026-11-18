/**
 * PostgresSequencingStore contract test (DFR-M3-A01, ADR-032 option A).
 *
 * Skipped by default; `pnpm test:db` provides the migration-identity DSN.
 * Tests use a separate database, genuinely verifying PostgreSQL row locks / advisory locks / unique constraints,
 * rather than in-process mutexes.
 *
 * Key differences from the nonce-store tests (exactly the semantics ADR-032 pins down):
 *   - Many transactions **may share one blockhash** (so a unique constraint on token_value would be wrong);
 *   - Lease identity is the transactionId, and references must carry it;
 *   - Expiry reclamation follows the **lease TTL**, unrelated to the blockhash's on-chain validity (lastValidBlockHeight).
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
 * A well-formed Solana blockhash (base58, 32 bytes).
 *
 * A public on-chain reference containing no secrets; 48 '1's are the base58 representation of 32 zero bytes.
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
  // 0006 has no foreign key, so CASCADE does not clean up this table — it must be listed explicitly.
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
    throw new Error(`refusing to run against non-test database "${rows[0]!.db}" (database name must end with _test)`);
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

describe.skipIf(!ENABLED)('PostgresSequencingStore (DFR-M3-A01)', () => {
  it('reserve persists the blockhash and chain height, returning token and height as strings (no number)', async () => {
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

  it('many transactions can share one blockhash — the token is not the identity, the transactionId is', async () => {
    await reset();
    const first = await reserve('txn_seq_share_a');
    const second = await reserve('txn_seq_share_b', { token: blockhashToken() });

    expect(first.kind).toBe('reserved');
    expect(second.kind).toBe('reserved');
    // Both rows exist with the same token_value — impossible under NonceStore semantics and required under Solana semantics.
    const { rows } = await inspector.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA}.sequencing_leases
        WHERE chain_id = $1 AND account_address = $2 AND token_value = $3`,
      [chain, account.address, BLOCKHASH],
    );
    expect(rows[0]!.count).toBe('2');

    // Consuming one does not affect the other lease's state.
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

  it('20 independent connections reserve concurrently and all succeed (blockhashes are not mutually exclusive), one lease per transaction', async () => {
    await reset();
    const ids = Array.from({ length: 20 }, (_, index) => `txn_seq_c_${index}`);
    const results = await Promise.all(ids.map((id) => reserve(id)));

    expect(results.every((result) => result.kind === 'reserved')).toBe(true);
    const { rows } = await inspector.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA}.sequencing_leases`,
    );
    expect(rows[0]!.count).toBe('20');
    // All share the same token: a blockhash is not a mutex.
    expect(new Set(results.map((r) => r.lease.token.value))).toEqual(new Set([BLOCKHASH]));
  });

  it('concurrent replays with the same transactionId keep only one lease and return reused', async () => {
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

  it('B40: a released/consumed/TTL-expired blockhash lease must not be returned as a valid lease on a replay with the same transactionId', async () => {
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

  it('B40: a replay of the original transaction carrying a different token/chain height must not reuse the old blockhash', async () => {
    await reset();
    await reserve('txn_seq_b40_changed_token');
    await expect(reserve('txn_seq_b40_changed_token', {
      token: blockhashToken(BLOCKHASH_B),
    })).rejects.toThrow(/sequencing.*replay|inactive.*lease/u);
    await expect(reserve('txn_seq_b40_changed_token', {
      token: { kind: 'blockhash', value: BLOCKHASH, lastValidBlockHeight: '495317735' as DecimalUint },
    })).rejects.toThrow(/sequencing.*replay|inactive.*lease/u);
  });

  it('B40: markConsumed must not revive released/expired terminal leases', async () => {
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

  it('B40: a replay of the same transaction within the TTL with an identical token may still be legally reused', async () => {
    await reset();
    const first = await reserve('txn_seq_b40_active');
    const again = await reserve('txn_seq_b40_active');
    expect(first.kind).toBe('reserved');
    expect(again.kind).toBe('reused');
    expect(again.lease).toEqual(first.lease);
  });

  it('markConsumed is idempotent and advances only this row even when the token is shared with others', async () => {
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

    // Unknown transactionId → not_found (never silently succeed).
    await expect(
      store.markConsumed({
        chain,
        account,
        transactionId: 'txn_seq_missing' as TransactionId,
        tokenValue: BLOCKHASH,
      }),
    ).resolves.toEqual({ kind: 'not_found' });

    // Reference token inconsistent with the lease → not_found (fail closed when the reference is inconsistent).
    await expect(
      store.markConsumed({
        chain,
        account,
        transactionId: 'txn_seq_consume' as TransactionId,
        tokenValue: BLOCKHASH_B,
      }),
    ).resolves.toEqual({ kind: 'not_found' });
  });

  it('releaseIfSafe: reserved can be released; consumed is refused (already_consumed)', async () => {
    await reset();
    await reserve('txn_seq_release_ok');
    const released = await store.releaseIfSafe({
      chain,
      account,
      transactionId: 'txn_seq_release_ok' as TransactionId,
      tokenValue: BLOCKHASH,
    });
    expect(released).toMatchObject({ kind: 'released', lease: { status: 'released' } });

    // Idempotent: releasing again still returns released.
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

  it('releaseIfSafe: mismatched reference token → forbidden{not_owner}, lease state unchanged', async () => {
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

  it('releaseExpiredOrphaned reclaims only TTL-expired reserved rows; consumed is never reclaimed', async () => {
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

  it('releaseExpiredOrphaned refuses an out-of-range limit (no unbounded scans)', async () => {
    await expect(store.releaseExpiredOrphaned({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.releaseExpiredOrphaned({ limit: 501 })).rejects.toBeInstanceOf(RangeError);
    await expect(store.releaseExpiredOrphaned({ limit: 1.5 })).rejects.toBeInstanceOf(RangeError);
  });

  it('reserve refuses non-blockhash tokens (M3 serves only Solana)', async () => {
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

  it('reserve refuses a mismatched account.chain and chain', async () => {
    await reset();
    await expect(
      store.reserve({
        chain,
        account: { chain: 'ethereum-sepolia' as ChainId, address: account.address },
        transactionId: 'txn_seq_mismatch' as TransactionId,
        token: blockhashToken(),
        leaseTtlMs: 60_000,
      }),
    ).rejects.toThrow(/does not match/u);
  });
});
