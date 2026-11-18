/**
 * PostgresNonceStore contract test (DFR-M1-A11).
 *
 * Skipped by default; `pnpm test:db` provides the migration-identity DSN.
 * Tests use a separate database, genuinely verifying PostgreSQL row locks rather than in-process mutexes.
 */
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import type {
  AccountRef,
  ChainId,
  DecimalUint,
  TransactionId,
  TransactionStatus,
} from '@dfr/types';
import { PostgresNonceStore } from '../src/nonce-store.js';
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

const PRIVATE_DB = 'dfr_t_nonce_test';
const SCHEMA = 'transaction_data';
const chain = 'ethereum-sepolia' as ChainId;
const account: AccountRef = { chain, address: '0xnonce-account' };

let admin: Client;
let inspector: Client;
let pool: Pool;
let store: PostgresNonceStore;

function dsnFor(database: string): string {
  return ADMIN_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

function runtimeDsnFor(database: string): string {
  return RUNTIME_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

async function reset(): Promise<void> {
  // Since M1-C00, nonce_leases no longer has a foreign key to transactions (ADR-018),
  // so CASCADE no longer cleans it up along the way — it must be listed explicitly, or the previous case's
  // lease would be read by the next case as a "replay with the same transactionId".
  await inspector.query(
    `TRUNCATE ${SCHEMA}.nonce_leases, ${SCHEMA}.transactions, ${SCHEMA}.nonce_accounts CASCADE`,
  );
}

async function createTransaction(
  id: string,
  status: TransactionStatus = 'built',
  address = account.address,
): Promise<TransactionId> {
  await inspector.query(
    `INSERT INTO ${SCHEMA}.transactions
       (id, project_id, chain_id, request_fingerprint, status, from_address)
     VALUES ($1, 'default', $2, $3, $4, $5)`,
    [id, chain, id.padEnd(64, 'f').slice(0, 64), status, address],
  );
  return id as TransactionId;
}

async function reserve(
  transactionId: TransactionId,
  chainPendingNonce = '0' as DecimalUint,
) {
  return store.reserve({
    chain,
    account,
    transactionId,
    chainPendingNonce,
    leaseTtlMs: 60_000,
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
  store = new PostgresNonceStore(pool);
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  if (inspector) await inspector.end();
  if (pool) await pool.end();
  if (admin) {
    // The Store pool uses the least-privilege dfr_runtime role; the migrator may not terminate another role.
    // After pool.end(), the server may take a few milliseconds to remove backends, so poll read-only until connections reach zero,
    // then let the database owner DROP normally; do not widen test-role permissions.
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

describe.skipIf(!ENABLED)('PostgresNonceStore (DFR-M1-A11)', () => {
  it('the first reserve takes max(chain pending, local watermark) and returns only decimal strings', async () => {
    await reset();
    const transactionId = await createTransaction('txn_nonce_first');
    const result = await reserve(transactionId, '9007199254740993' as DecimalUint);

    expect(result.kind).toBe('reserved');
    expect(result.lease).toMatchObject({
      chain,
      account,
      transactionId,
      nonce: '9007199254740993',
      status: 'reserved',
    });
    expect(typeof result.lease.nonce).toBe('string');

    const { rows } = await inspector.query<{ next_nonce: string }>(
      `SELECT next_nonce::text FROM ${SCHEMA}.nonce_accounts
        WHERE chain_id=$1 AND account_address=$2`,
      [chain, account.address],
    );
    expect(rows[0]!.next_nonce).toBe('9007199254740994');
  });

  it('20 independent connections reserve concurrently: nonces for the same account are unique and consecutive', async () => {
    await reset();
    // The parent transaction only prepares data, written sequentially, to avoid concurrent queries on the same pg.Client.
    const ids: TransactionId[] = [];
    for (let index = 0; index < 20; index += 1) {
      ids.push(await createTransaction(`txn_nonce_c_${index}`));
    }

    const results = await Promise.all(ids.map((id) => reserve(id, '7' as DecimalUint)));
    expect(results.every((result) => result.kind === 'reserved')).toBe(true);
    const nonces = results.map((result) => BigInt(result.lease.nonce)).sort((a, b) => (a < b ? -1 : 1));
    expect(nonces).toEqual(Array.from({ length: 20 }, (_, index) => BigInt(index + 7)));
    expect(new Set(nonces.map(String)).size).toBe(20);
  });

  it('concurrent replays with the same transactionId keep only one lease and do not increment the nonce', async () => {
    await reset();
    const transactionId = await createTransaction('txn_nonce_replay');
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(transactionId)));

    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'reused')).toHaveLength(7);
    expect(new Set(results.map((result) => result.lease.nonce))).toEqual(new Set(['0']));

    const { rows } = await inspector.query<{ leases: string; next_nonce: string }>(
      `SELECT
         (SELECT count(*)::text FROM ${SCHEMA}.nonce_leases WHERE transaction_id=$1) AS leases,
         (SELECT next_nonce::text FROM ${SCHEMA}.nonce_accounts
           WHERE chain_id=$2 AND account_address=$3) AS next_nonce`,
      [transactionId, chain, account.address],
    );
    expect(rows[0]).toEqual({ leases: '1', next_nonce: '1' });
  });

  it('DB-01: repeated transactionId with expired or released nonce cannot be reused', async () => {
    for (const status of ['expired', 'released'] as const) {
      await reset();
      const id = 'txn_invalid_replay' as TransactionId;
      const first = await reserve(id);
      expect(first.kind).toBe('reserved');
      await inspector.query(
        `UPDATE ${SCHEMA}.nonce_leases
            SET status = $2, expires_at = clock_timestamp() - interval '1 second'
          WHERE transaction_id = $1`,
        [id, status],
      );
      const replay = await reserve(id);
      expect(replay).toMatchObject({
        kind: 'conflict',
        lease: { transactionId: id, status },
      });
      const { rows } = await inspector.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${SCHEMA}.nonce_leases WHERE transaction_id = $1`,
        [id],
      );
      expect(rows[0]?.count).toBe('1');
    }
  });

  it('DB-01: repeated transactionId cannot reuse a lease behind chain pending nonce', async () => {
    await reset();
    const id = 'txn_chain_nonce_advanced' as TransactionId;
    expect((await reserve(id, '0' as DecimalUint)).kind).toBe('reserved');
    const replay = await reserve(id, '1' as DecimalUint);
    expect(replay).toMatchObject({ kind: 'conflict', lease: { transactionId: id, nonce: '0' } });
  });

  it('DB-01: repeated transactionId with a different account cannot take the original lease', async () => {
    await reset();
    const id = 'txn_account_mismatch_replay' as TransactionId;
    expect((await reserve(id)).kind).toBe('reserved');
    const otherAccount: AccountRef = { chain, address: '0xother-account' };
    const replay = await store.reserve({
      chain, account: otherAccount, transactionId: id,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: 60_000,
    });
    expect(replay).toMatchObject({ kind: 'conflict', lease: { account } });
  });

  it('when the local watermark wrongly points at a taken nonce, returns conflict without overwriting the original lease', async () => {
    await reset();
    const ownerId = await createTransaction('txn_nonce_conflict_owner');
    const contenderId = await createTransaction('txn_nonce_conflict_contender');
    await inspector.query(
      `INSERT INTO ${SCHEMA}.nonce_accounts (chain_id, account_address, next_nonce)
       VALUES ($1, $2, 5)`,
      [chain, account.address],
    );
    await inspector.query(
      `INSERT INTO ${SCHEMA}.nonce_leases
         (chain_id, account_address, nonce, transaction_id, status, expires_at)
       VALUES ($1, $2, 5, $3, 'reserved', clock_timestamp() + interval '1 minute')`,
      [chain, account.address, ownerId],
    );

    const conflict = await reserve(contenderId, '5' as DecimalUint);
    expect(conflict).toMatchObject({
      kind: 'conflict',
      lease: { nonce: '5', transactionId: ownerId, status: 'reserved' },
    });
    const { rows } = await inspector.query<{ transaction_id: string }>(
      `SELECT transaction_id FROM ${SCHEMA}.nonce_leases
        WHERE chain_id=$1 AND account_address=$2 AND nonce=5`,
      [chain, account.address],
    );
    expect(rows[0]!.transaction_id).toBe(ownerId);
  });

  it('reserve no longer reads the transaction row chain/from (ADR-018): that check moved to create', async () => {
    await reset();
    // Old behavior: reserve locked the transaction row first and required from to match. That precondition contradicted the engine order
    // (reserve → chain.build → create): every build in a real deployment would fail,
    // so it was removed in DFR-M1-C00.
    // The contract did not loosen: lease-account ↔ transaction-record from consistency is enforced fail-closed by
    // PostgresTransactionStore.create;
    // see the negative case in transaction-store.test.ts
    // "create with an existing lease for the same transactionId whose chain/from mismatch → fail-closed".
    const transactionId = await createTransaction('txn_nonce_row_mismatch', 'built', '0xother');
    const result = await reserve(transactionId);
    expect(result.kind).toBe('reserved');
    expect(result.lease.nonce).toBe('0');
  });

  it('a nonce can still be allocated before the transaction row is created (DFR-M1-C00: reserve precedes create)', async () => {
    await reset();
    // The engine order is reserve → chain.build → create. If reserve required the transaction row to exist first,
    // every build in a real deployment would fail; this case pins that ordering contract.
    const result = await reserve('txn_c00_no_row_yet' as TransactionId, '7' as DecimalUint);
    expect(result.kind).toBe('reserved');
    expect(result.lease.nonce).toBe('7');

    const leases = await inspector.query<{ transaction_id: string; nonce: string }>(
      `SELECT transaction_id, nonce::text AS nonce FROM ${SCHEMA}.nonce_leases`,
    );
    expect(leases.rows).toEqual([{ transaction_id: 'txn_c00_no_row_yet', nonce: '7' }]);

    // The transaction row still does not exist: nonce allocation does not depend on it.
    const tx = await inspector.query(
      `SELECT 1 FROM ${SCHEMA}.transactions WHERE id = $1`,
      ['txn_c00_no_row_yet'],
    );
    expect(tx.rowCount).toBe(0);
  });

  it('a lease can still be safely released before the transaction row is created (build failed before create)', async () => {
    await reset();
    // Since ADR-018, reserve precedes create, so the "build fails → release the unsigned lease" path
    // runs when the transaction row does not exist. Not releasing would leave an orphaned lease that can never be reclaimed.
    const reserved = await reserve('txn_c00_release_before_create' as TransactionId, '3' as DecimalUint);
    expect(reserved.kind).toBe('reserved');

    const released = await store.releaseIfSafe({
      chain,
      account,
      nonce: reserved.lease.nonce,
      transactionId: reserved.lease.transactionId,
    });
    expect(released).toMatchObject({ kind: 'released', lease: { status: 'released' } });

    // ADR-030: a released lease with no transaction row was **never signed** and can be safely reused;
    // the watermark falls back to that nonce, and the next reserve gets '3' again.
    // (Before the fix this expected '4' — exactly the behavior that left a permanent gap on the real chain.)
    const next = await reserve('txn_c00_after_release' as TransactionId, '3' as DecimalUint);
    expect(next.lease.nonce).toBe('3');
    expect(next.lease.transactionId).toBe('txn_c00_after_release');
  });

  it('ADR-030: after a failed build releases an unsigned nonce, the next build reuses the same nonce (no gap left)', async () => {
    await reset();
    // The sequence E03 hit on the real chain: reserve(0) → chain.build fails → release → reserve gets 1,
    // leaving nonce 0 as a permanent gap, with later transactions stuck in the mempool's queued zone and unable to heal.
    const first = await store.reserve({
      chain,
      account,
      transactionId: 'txn_gap_first' as TransactionId,
      chainPendingNonce: '0' as DecimalUint,
      leaseTtlMs: 60_000,
    });
    expect(first).toMatchObject({ kind: 'reserved', lease: { nonce: '0' } });

    await store.releaseIfSafe({ chain, account, nonce: '0' as DecimalUint,
      transactionId: 'txn_gap_first' as TransactionId });

    const second = await store.reserve({
      chain,
      account,
      transactionId: 'txn_gap_second' as TransactionId,
      chainPendingNonce: '0' as DecimalUint,
      leaseTtlMs: 60_000,
    });
    expect(second).toMatchObject({ kind: 'reserved', lease: { nonce: '0' } });
    expect(second.lease.transactionId).toBe('txn_gap_second');
  });

  it('ADR-030: a released lease with a transaction row is not reused (conservative, avoids broadcasting the same nonce twice)', async () => {
    await reset();
    const firstId = await createTransaction('txn_gap_row_1');
    const first = await reserve(firstId);
    expect(first.lease.nonce).toBe('0');
    const released = await store.releaseIfSafe({ chain, account, nonce: '0' as DecimalUint,
      transactionId: firstId });
    expect(released.kind).toBe('released');

    // The transaction row exists (built) — even though released, its nonce cannot be reused: the record may still be broadcast.
    const secondId = await createTransaction('txn_gap_row_2');
    const second = await reserve(secondId);
    expect(second.lease.nonce).toBe('1');
  });

  it('TX-05/B38: new reservation reclaims an expired unsigned orphan without waiting for periodic sweep', async () => {
    await reset();
    const first = await store.reserve({
      chain, account, transactionId: 'txn_b38_orphan_first' as TransactionId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
    });
    expect(first).toMatchObject({ kind: 'reserved', lease: { nonce: '0' } });
    // There is NO transaction row and NO call to releaseExpiredOrphaned.
    const next = await reserve('txn_b38_orphan_next' as TransactionId);
    expect(next).toMatchObject({ kind: 'reserved', lease: { nonce: '0', transactionId: 'txn_b38_orphan_next' } });
    const { rows } = await inspector.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${SCHEMA}.nonce_leases WHERE chain_id=$1 AND account_address=$2`,
      [chain, account.address],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('TX-05/B38: expired unsigned terminal abandoned is reclaimable but signed/hash-bearing is not', async () => {
    for (const prior of ['abandoned', 'reverted'] as const) {
      await reset();
      const id = await createTransaction(`txn_b38_${prior}_unsigned`, prior);
      const old = await store.reserve({
        chain, account, transactionId: id,
        chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
      });
      expect(old.lease.nonce).toBe('0');
      const next = await reserve(`txn_b38_${prior}_next` as TransactionId);
      expect(next.lease.nonce).toBe('0');
    }
    await reset();
    const signed = await createTransaction('txn_b38_corrupted_abandoned', 'abandoned');
    const held = await store.reserve({
      chain, account, transactionId: signed,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
    });
    await inspector.query(
      `UPDATE ${SCHEMA}.transactions SET expected_hash=$2 WHERE id=$1`,
      [signed, '0x' + '77'.repeat(32)],
    );
    const next = await reserve('txn_b38_hash_protected' as TransactionId);
    expect(held.lease.nonce).toBe('0');
    expect(next.lease.nonce).toBe('1');
  });

  it('TX-05/B38: unexpired orphan, active built tx, and advanced chain nonce are never inline-reclaimed', async () => {
    await reset();
    const unexpired = await reserve('txn_b38_unexpired' as TransactionId);
    const other = await reserve('txn_b38_unexpired_contender' as TransactionId);
    expect(unexpired.lease.nonce).toBe('0');
    expect(other.lease.nonce).toBe('1');

    await reset();
    const built = await createTransaction('txn_b38_built', 'built');
    const expired = await store.reserve({
      chain, account, transactionId: built,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
    });
    const next = await reserve('txn_b38_built_contender' as TransactionId);
    expect(expired.lease.nonce).toBe('0');
    expect(next.lease.nonce).toBe('1');

    await reset();
    await store.reserve({
      chain, account, transactionId: 'txn_b38_chain_floor_old' as TransactionId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
    });
    const higher = await reserve('txn_b38_chain_floor_next' as TransactionId, '1' as DecimalUint);
    expect(higher.lease.nonce).toBe('1');
  });

  it('TX-05/B38: independent concurrent reservations can reclaim one expired hole only once', async () => {
    await reset();
    await store.reserve({
      chain, account, transactionId: 'txn_b38_parallel_orphan' as TransactionId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => reserve(`txn_b38_parallel_${i}` as TransactionId)),
    );
    expect(results.every((result) => result.kind === 'reserved')).toBe(true);
    expect(results.map((result) => Number(result.lease.nonce)).sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('ADR-030: unsigned orphans reclaimed by restart recovery also leave no permanent gap', async () => {
    await reset();
    const orphan = await store.reserve({
      chain,
      account,
      transactionId: 'txn_orphan_gap' as TransactionId,
      chainPendingNonce: '0' as DecimalUint,
      leaseTtlMs: -1,
    });
    expect(orphan).toMatchObject({ kind: 'reserved', lease: { nonce: '0' } });

    await expect(store.releaseExpiredOrphaned({ limit: 10 })).resolves.toBe(1);

    const next = await store.reserve({
      chain,
      account,
      transactionId: 'txn_orphan_after' as TransactionId,
      chainPendingNonce: '0' as DecimalUint,
      leaseTtlMs: 60_000,
    });
    expect(next).toMatchObject({ kind: 'reserved', lease: { nonce: '0' } });
  });

  it('recovery reclaims an expired reserved lease with no transaction row (since ADR-030, that nonce may be reused)', async () => {
    await reset();
    const orphan = await store.reserve({
      chain,
      account,
      transactionId: 'txn_d03_orphan' as TransactionId,
      chainPendingNonce: '0' as DecimalUint,
      leaseTtlMs: -1,
    });
    expect(orphan.kind).toBe('reserved');

    await expect(store.releaseExpiredOrphaned({ limit: 1 })).resolves.toBe(1);
    const { rows } = await inspector.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.nonce_leases WHERE transaction_id = $1`,
      ['txn_d03_orphan'],
    );
    expect(rows[0]!.status).toBe('released');

    // ADR-030: a never-signed orphan nonce with no transaction row no longer causes a permanent gap;
    // the next reserve reuses it (the old expectation was '1' — exactly the gap defect on the real chain).
    const next = await reserve('txn_d03_after_orphan' as TransactionId, '0' as DecimalUint);
    expect(next.lease.nonce).toBe('0');
    expect(next.lease.transactionId).toBe('txn_d03_after_orphan');
  });

  it('a built lease can be safely released, but the M1 watermark stays monotonic and never reclaims old nonces', async () => {
    await reset();
    const firstId = await createTransaction('txn_nonce_release_1');
    const first = await reserve(firstId);
    const released = await store.releaseIfSafe({ chain, account, nonce: first.lease.nonce,
      transactionId: firstId });
    expect(released.kind).toBe('released');

    const secondId = await createTransaction('txn_nonce_release_2');
    const second = await reserve(secondId);
    expect(second.kind).toBe('reserved');
    expect(second.lease.nonce).toBe('1');
    expect(second.lease.transactionId).toBe(secondId);
  });

  it('TX-02: a CAS-abandoned unsigned transaction can release its nonce after state transition', async () => {
    await reset();
    const id = await createTransaction('txn_b34_cas_abandoned', 'abandoned');
    const held = await reserve(id);
    const released = await store.releaseIfSafe({
      chain, account, nonce: held.lease.nonce, transactionId: id,
    });
    expect(released.kind).toBe('released');
    const next = await reserve('txn_b34_after_abandoned' as TransactionId);
    expect(next.lease.nonce).toBe(held.lease.nonce);
  });

  it('TX-02: a signed hash must NEVER be released even if status is corrupted to abandoned', async () => {
    await reset();
    const id = await createTransaction('txn_b34_false_abandoned', 'abandoned');
    const held = await reserve(id);
    await inspector.query(
      `UPDATE ${SCHEMA}.transactions SET expected_hash=$2 WHERE id=$1`,
      [id, '0x' + 'ab'.repeat(32)],
    );
    const result = await store.releaseIfSafe({
      chain, account, nonce: held.lease.nonce, transactionId: id,
    });
    expect(result.kind).toBe('forbidden');
    const { rows } = await inspector.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.nonce_leases WHERE transaction_id=$1`, [id],
    );
    expect(rows[0]?.status).toBe('reserved');
  });

  it('TX-02: a released nonce whose abandoned owner has a signed hash must not be reissued', async () => {
    await reset();
    const owner = await createTransaction('txn_b34_poisoned_abandoned', 'abandoned');
    const held = await reserve(owner);
    await inspector.query(
      `UPDATE ${SCHEMA}.transactions SET expected_hash=$2 WHERE id=$1`,
      [owner, '0x' + 'ab'.repeat(32)],
    );
    // Simulate a legacy lease release or bad import; never trust status alone.
    await inspector.query(
      `UPDATE ${SCHEMA}.nonce_leases SET status='released' WHERE transaction_id=$1`,
      [owner],
    );
    const next = await reserve('txn_b34_fresh_after_poisoned' as TransactionId);
    expect(next.lease.nonce).toBe('1');
    expect(held.lease.nonce).toBe('0');
  });

  it('TX-02: restart TTL recovers unsigned abandoned leases but not signed abandoned leases', async () => {
    await reset();
    const unsignedId = await createTransaction('txn_b34_expired_abandoned', 'abandoned');
    const unsignedLease = await reserve(unsignedId);
    const signedId = await createTransaction('txn_b34_expired_signed_abandoned', 'abandoned');
    const signedLease = await reserve(signedId);
    await inspector.query(
      `UPDATE ${SCHEMA}.transactions SET tx_hash=$2 WHERE id=$1`,
      [signedId, '0x' + 'cd'.repeat(32)],
    );
    await inspector.query(
      `UPDATE ${SCHEMA}.nonce_leases SET expires_at=clock_timestamp() - INTERVAL '1 second'
         WHERE transaction_id = ANY($1::text[])`,
      [[unsignedId, signedId]],
    );
    expect(await store.releaseExpiredOrphaned({ limit: 10 })).toBe(1);
    const { rows } = await inspector.query<{ transaction_id: string; status: string }>(
      `SELECT transaction_id, status FROM ${SCHEMA}.nonce_leases ORDER BY transaction_id`,
    );
    expect(rows).toEqual([
      { transaction_id: unsignedId, status: 'released' },
      { transaction_id: signedId, status: 'reserved' },
    ]);
    expect(unsignedLease.lease.nonce).toBe('0');
    expect(signedLease.lease.nonce).toBe('1');
  });

  it('TX-01: startup reconciliation releases expired simulation-reverted lease after interruption', async () => {
    await reset();
    const firstId = await createTransaction('txn_reverted_restart');
    const lease = await store.reserve({
      chain, account, transactionId: firstId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
    });
    expect(lease.lease.nonce).toBe('0');
    await inspector.query(`UPDATE ${SCHEMA}.transactions SET status='reverted' WHERE id=$1`, [firstId]);

    // Simulate a crash after storing terminal reverted but before releaseIfSafe.
    expect(await store.releaseExpiredOrphaned({ limit: 10 })).toBe(1);
    const nextId = await createTransaction('txn_reverted_restart_next');
    expect((await reserve(nextId)).lease.nonce).toBe('0');
  });

  it('TX-01: startup must not release a reverted but signed or broadcast nonce', async () => {
    await reset();
    const signedId = await createTransaction('txn_reverted_signed_restart');
    const signedLease = await store.reserve({
      chain, account, transactionId: signedId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
    });
    await inspector.query(
      `UPDATE ${SCHEMA}.transactions SET status='reverted', expected_hash=$2 WHERE id=$1`,
      [signedId, '0x' + 'cd'.repeat(32)],
    );
    const onchainId = await createTransaction('txn_reverted_broadcast_restart');
    const onchainLease = await store.reserve({
      chain, account, transactionId: onchainId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: -1,
    });
    await store.markBroadcast({
      chain, account, nonce: onchainLease.lease.nonce, transactionId: onchainId,
    });
    await inspector.query(`UPDATE ${SCHEMA}.transactions SET status='reverted' WHERE id=$1`, [onchainId]);

    expect(await store.releaseExpiredOrphaned({ limit: 10 })).toBe(0);
    const nextId = await createTransaction('txn_reverted_protected_next');
    expect((await reserve(nextId)).lease.nonce).toBe('2');
    expect(signedLease.lease.nonce).toBe('0');
    expect(onchainLease.lease.nonce).toBe('1');
  });

  it('TX-01: TTL reconciliation keeps active unsigned simulation leases reserved', async () => {
    await reset();
    const id = await createTransaction('txn_active_simulation');
    const lease = await reserve(id);
    expect(lease.lease.nonce).toBe('0');
    await inspector.query(`UPDATE ${SCHEMA}.transactions SET status='reverted' WHERE id=$1`, [id]);

    expect(await store.releaseExpiredOrphaned({ limit: 10 })).toBe(0);
    const secondId = await createTransaction('txn_active_simulation_next');
    expect((await reserve(secondId)).lease.nonce).toBe('1');
  });

  it('TX-01: reverted before signing releases and safely reuses the nonce', async () => {
    await reset();
    const firstId = await createTransaction('txn_simulation_reverted');
    const first = await reserve(firstId);
    expect(first.lease.nonce).toBe('0');

    await inspector.query(`UPDATE ${SCHEMA}.transactions SET status='reverted' WHERE id=$1`, [firstId]);
    const released = await store.releaseIfSafe({
      chain, account, nonce: first.lease.nonce, transactionId: firstId,
    });
    expect(released.kind).toBe('released');

    const secondId = await createTransaction('txn_after_simulation_reverted');
    const second = await reserve(secondId);
    expect(second.lease.nonce).toBe('0');
    expect(second.lease.transactionId).toBe(secondId);
  });

  it('TX-01: reverted after signing must never release or reuse the nonce', async () => {
    await reset();
    const signedId = await createTransaction('txn_execution_reverted');
    const first = await reserve(signedId);
    await inspector.query(
      `UPDATE ${SCHEMA}.transactions SET status='reverted', expected_hash=$2 WHERE id=$1`,
      [signedId, '0x' + 'ab'.repeat(32)],
    );
    const denied = await store.releaseIfSafe({
      chain, account, nonce: first.lease.nonce, transactionId: signedId,
    });
    expect(denied).toMatchObject({ kind: 'forbidden', reason: 'signed_or_broadcast' });
    const nextId = await createTransaction('txn_after_execution_reverted');
    expect((await reserve(nextId)).lease.nonce).toBe('1');
  });

  it('TX-01: even reverted with no hash cannot release a broadcast-marked lease', async () => {
    await reset();
    const id = await createTransaction('txn_reverted_broadcast_lease');
    const first = await reserve(id);
    await store.markBroadcast({
      chain, account, nonce: first.lease.nonce, transactionId: id,
    });
    await inspector.query(`UPDATE ${SCHEMA}.transactions SET status='reverted' WHERE id=$1`, [id]);
    const denied = await store.releaseIfSafe({
      chain, account, nonce: first.lease.nonce, transactionId: id,
    });
    expect(denied).toMatchObject({ kind: 'forbidden', reason: 'signed_or_broadcast' });
  });

  it('NEW-06: releaseIfSafe only releases a reserved lease', async () => {
    await reset();
    const id = await createTransaction('txn_nonreserved_reverted');
    const first = await reserve(id);
    await inspector.query(`UPDATE ${SCHEMA}.transactions SET status='reverted' WHERE id=$1`, [id]);
    await inspector.query(
      `UPDATE ${SCHEMA}.nonce_leases SET status='expired' WHERE transaction_id=$1`,
      [id],
    );

    const denied = await store.releaseIfSafe({
      chain, account, nonce: first.lease.nonce, transactionId: id,
    });
    expect(denied).toMatchObject({ kind: 'forbidden', reason: 'signed_or_broadcast' });
    const { rows } = await inspector.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.nonce_leases WHERE transaction_id=$1`, [id],
    );
    expect(rows[0]?.status).toBe('expired');
  });

  it('once a transaction is signed, automatic release is refused and the nonce is not reused by later transactions', async () => {
    await reset();
    const signedId = await createTransaction('txn_nonce_signed');
    const signedLease = await reserve(signedId);
    await inspector.query(
      `UPDATE ${SCHEMA}.transactions SET status='signed' WHERE id=$1`,
      [signedId],
    );

    const denied = await store.releaseIfSafe({ chain, account, nonce: signedLease.lease.nonce,
      transactionId: signedId });
    expect(denied).toMatchObject({ kind: 'forbidden', reason: 'signed_or_broadcast' });

    const nextId = await createTransaction('txn_nonce_after_signed');
    const next = await reserve(nextId);
    expect(next.lease.nonce).toBe('1');
  });

  it('once a lease is broadcast, release and reuse are refused even if the transaction snapshot is still built', async () => {
    await reset();
    const transactionId = await createTransaction('txn_nonce_broadcast');
    const original = await reserve(transactionId);
    const broadcast = await store.markBroadcast({ chain, account, nonce: original.lease.nonce,
      transactionId });
    expect(broadcast).toMatchObject({ kind: 'updated', lease: { status: 'broadcast' } });

    const denied = await store.releaseIfSafe({ chain, account, nonce: original.lease.nonce,
      transactionId });
    expect(denied).toMatchObject({ kind: 'forbidden', reason: 'signed_or_broadcast' });

    const nextId = await createTransaction('txn_nonce_after_broadcast');
    const next = await reserve(nextId);
    expect(next.lease.nonce).toBe('1');
  });

  it('when releaseIfSafe races a late broadcast, the final state never rests at released', async () => {
    await reset();
    const transactionId = await createTransaction('txn_nonce_release_race');
    const original = await reserve(transactionId);
    const ref = { chain, account, nonce: original.lease.nonce, transactionId };

    const [released, broadcast] = await Promise.all([
      store.releaseIfSafe(ref),
      store.markBroadcast(ref),
    ]);
    expect(['released', 'forbidden']).toContain(released.kind);
    expect(broadcast).toMatchObject({ kind: 'updated', lease: { status: 'broadcast' } });

    const { rows } = await inspector.query<{ status: string }>(
      `SELECT status FROM ${SCHEMA}.nonce_leases
        WHERE chain_id=$1 AND account_address=$2 AND nonce=$3::numeric`,
      [chain, account.address, original.lease.nonce],
    );
    expect(rows[0]!.status).toBe('broadcast');
  });

  it('markConsumed advances monotonically and repeated calls stay idempotent, never downgrading back to broadcast', async () => {
    await reset();
    const transactionId = await createTransaction('txn_nonce_consumed');
    const original = await reserve(transactionId);
    const ref = { chain, account, nonce: original.lease.nonce, transactionId };

    expect(await store.markConsumed(ref)).toMatchObject({
      kind: 'updated',
      lease: { status: 'consumed' },
    });
    expect(await store.markBroadcast(ref)).toMatchObject({
      kind: 'updated',
      lease: { status: 'consumed' },
    });
    expect(await store.markConsumed(ref)).toMatchObject({
      kind: 'updated',
      lease: { status: 'consumed' },
    });
  });

  it('B39: ownerless mutation after nonce rebind cannot release, broadcast or consume the new owner', async () => {
    for (const mutation of ['release', 'broadcast', 'consume'] as const) {
      await reset();
      const old = await store.reserve({
        chain, account, transactionId: 'txn_b39_old' as TransactionId,
        chainPendingNonce: '0' as DecimalUint, leaseTtlMs: 60_000,
      });
      expect((await store.releaseIfSafe({
        chain, account, nonce: old.lease.nonce, transactionId: 'txn_b39_old' as TransactionId,
      })).kind).toBe('released');
      const owner = await createTransaction('txn_b39_new_owner', 'built');
      const next = await reserve(owner);
      expect(next.lease.nonce).toBe(old.lease.nonce);
      // Intentionally bypass TypeScript to emulate an older JS client.
      const incompleteRef = { chain, account, nonce: old.lease.nonce } as never;
      const result = mutation === 'release'
        ? await store.releaseIfSafe(incompleteRef)
        : mutation === 'broadcast'
          ? await store.markBroadcast(incompleteRef)
          : await store.markConsumed(incompleteRef);
      expect(result.kind, `unsafe ownerless ${mutation} changed a newly rebound nonce`).toBe('not_found');
      const { rows } = await inspector.query<{ status: string; transaction_id: string }>(
        `SELECT status, transaction_id FROM ${SCHEMA}.nonce_leases
         WHERE chain_id=$1 AND account_address=$2 AND nonce=$3::numeric`,
        [chain, account.address, next.lease.nonce],
      );
      expect(rows[0]).toEqual({ status: 'reserved', transaction_id: owner });
    }
  });

  it('ADR-030 ABA negative case: a late release/advance must not affect the new lease of a reused nonce', async () => {
    await reset();
    // 1) Transaction A gets nonce 0, then build fails and it releases (no transaction row).
    const a = await store.reserve({
      chain, account, transactionId: 'txn_aba_a' as TransactionId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: 60_000,
    });
    expect(a).toMatchObject({ kind: 'reserved', lease: { nonce: '0' } });
    await store.releaseIfSafe({ chain, account, nonce: '0' as DecimalUint, transactionId: 'txn_aba_a' as TransactionId });

    // 2) ADR-030: transaction B reuses nonce 0.
    const b = await store.reserve({
      chain, account, transactionId: 'txn_aba_b' as TransactionId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: 60_000,
    });
    expect(b).toMatchObject({ kind: 'reserved', lease: { nonce: '0' } });
    expect(b.lease.transactionId).toBe('txn_aba_b');

    // 3) Late A releases/advances again with its **stale** reference: it must be refused, and B's lease is unaffected.
    const staleRelease = await store.releaseIfSafe({
      chain, account, nonce: '0' as DecimalUint, transactionId: 'txn_aba_a' as TransactionId,
    });
    expect(staleRelease).toMatchObject({ kind: 'forbidden', reason: 'not_owner' });

    const staleAdvance = await store.markBroadcast({
      chain, account, nonce: '0' as DecimalUint, transactionId: 'txn_aba_a' as TransactionId,
    });
    expect(staleAdvance).toEqual({ kind: 'not_found' });

    const { rows } = await inspector.query<{ transaction_id: string; status: string }>(
      `SELECT transaction_id, status FROM ${SCHEMA}.nonce_leases
        WHERE chain_id=$1 AND account_address=$2 AND nonce=0`,
      [chain, account.address],
    );
    expect(rows[0]).toEqual({ transaction_id: 'txn_aba_b', status: 'reserved' });
  });

  it('ADR-030: after a released gap below the watermark is reused, the watermark does not advance (it stays a monotonic upper bound)', async () => {
    await reset();
    await store.reserve({
      chain, account, transactionId: 'txn_wm_first' as TransactionId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: 60_000,
    });
    await store.releaseIfSafe({ chain, account, nonce: '0' as DecimalUint, transactionId: 'txn_wm_first' as TransactionId });

    await store.reserve({
      chain, account, transactionId: 'txn_wm_second' as TransactionId,
      chainPendingNonce: '0' as DecimalUint, leaseTtlMs: 60_000,
    });
    const { rows } = await inspector.query<{ next_nonce: string }>(
      `SELECT next_nonce::text AS next_nonce FROM ${SCHEMA}.nonce_accounts
        WHERE chain_id=$1 AND account_address=$2`,
      [chain, account.address],
    );
    // Reuse does not advance the watermark: it stays 1 (the upper bound from the first reserve), and the gap is filled.
    expect(rows[0]!.next_nonce).toBe('1');
  });

  it('advancing or releasing an unknown lease stably returns not_found', async () => {
    await reset();
    const ref = { chain, account, nonce: '404' as DecimalUint,
      transactionId: 'txn_not_exist' as TransactionId };
    expect(await store.markBroadcast(ref)).toEqual({ kind: 'not_found' });
    expect(await store.markConsumed(ref)).toEqual({ kind: 'not_found' });
    expect(await store.releaseIfSafe(ref)).toEqual({ kind: 'not_found' });
  });
});
