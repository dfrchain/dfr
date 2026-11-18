/**
 * PostgresTransactionStore contract test (DFR-M1-A09).
 *
 * Authoritative sources: docs/architecture/m1-storage-model.md sections 4/5, ADR-015 §5.
 *
 * Skipped by **default**; enable explicitly (`pnpm test:db` exports the DSN):
 *
 *   DFR_TRANSACTION_MIGRATION_DATABASE_URL=postgres://dfr_migrator:...@127.0.0.1:55432/dfr_m1_test \
 *   pnpm vitest run packages/storage-postgres/test/transaction-store.test.ts
 *
 * This file **builds its own throwaway database** (`dfr_t_store_test`) and closes connections before deleting it at the end.
 * Reason: the schema contract test runs `DROP SCHEMA transaction_data CASCADE`,
 * so sharing one database would let the two test files break each other (vitest runs files in parallel by default).
 *
 * The two key verifications the task card requires:
 *   1. Two connections race on the same version, and exactly one succeeds (CAS works);
 *   2. When the transition audit write fails, the state snapshot must roll back.
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

/** Migration-identity DSN: used to create the database, run migrations, and install test probe constraints. */
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
/** Raw connection to the private database: used to assert the real database state directly, bypassing the Store. */
let inspector: Client;
let pool: Pool;
let store: PostgresTransactionStore;

function dsnFor(database: string): string {
  // Replace the DSN's database name with the target database; keep everything else unchanged.
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

/** Read raw rows bypassing the Store, to verify "what really happened in the database". */
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
    throw new Error(`refusing to run against non-test database "${rows[0]!.db}" (database name must end with _test)`);
  }

  await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${PRIVATE_DB}`);

  // Apply the real migrations on the private database, so tests target the real schema.
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
  // DROP DATABASE requires no active connections: release the pool first, then delete from the admin connection.
  if (inspector) await inspector.end();
  if (pool) await pool.end();
  if (admin) {
    // After the pool closes, the server may still have a few leftover backends; terminate them first, then DROP,
    // to avoid noisy 57P01 errors on pg clients when FORCE cuts connections.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [PRIVATE_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB} WITH (FORCE)`);
    await admin.end();
  }
}, 60_000);

describe.skipIf(!ENABLED)('PostgresTransactionStore (DFR-M1-A09)', () => {
  it('create → get round trip: field mapping is correct and the version is a decimal string', async () => {
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
    // nonce must be a decimal string, never a number (float/precision red line).
    expect(typeof loaded!.nonce).toBe('string');
    expect(loaded!.nonce).toBe('7');
    expect(loaded!.from.address).toBe(from.address);
    expect(loaded!.to?.address).toBe(to.address);
    expect(loaded!.payloadEncoding).toBe('hex');
    expect(loaded!.minFinality).toBe('finalized');
    expect(loaded!.blockRef).toEqual({ kind: 'tag', tag: 'latest' });
    expect(loaded!.canonicalBlockHash).toBe('0x' + 'cd'.repeat(32));
    // Times must be ISO 8601 strings.
    expect(loaded!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('get returns null when missing (not undefined)', async () => {
    expect(await store.get('txn_missing' as TransactionId)).toBeNull();
  });

  it('getByHash scopes to a chain and can hit a broadcast hash or expectedHash', async () => {
    await resetRows();
    const expectedHash = `0x${'ab'.repeat(32)}`;
    const txHash = `0x${'cd'.repeat(32)}`;
    await store.create({ record: makeRecord('txn_by_hash', { expectedHash, txHash }) });

    await expect(store.getByHash(chain, txHash)).resolves.toMatchObject({ transactionId: 'txn_by_hash' });
    await expect(store.getByHash(chain, expectedHash)).resolves.toMatchObject({ transactionId: 'txn_by_hash' });
    await expect(store.getByHash('base-sepolia' as ChainId, txHash)).resolves.toBeNull();
    await expect(store.getByHash(chain, `0x${'ef'.repeat(32)}`)).resolves.toBeNull();
  });

  it('a repeated create returns already_exists without overwriting the existing record', async () => {
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

  it('ADR-033: a non-EVM (Solana blockhash) record can persist sequencing_ref, and round-trips consistently', async () => {
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
    // Solana records have no EVM nonce column.
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
      } })).rejects.toThrow(/sequencing|blockhash|lease/u);
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

  it('ADR-033: an EVM record's sequencing_ref(nonce) must be consistent with its nonce column', async () => {
    await resetRows();
    // Consistent and holding a valid lease: allowed. Since DB-01, field consistency alone is not enough.
    await seedNonceLease('txn_ref_ok', '5');
    await expect(
      store.create({ record: makeRecord('txn_ref_ok', { nonce: num('5'), sequencingRef: { kind: 'nonce', value: num('5') } }) }),
    ).resolves.toMatchObject({ kind: 'created' });
    // Inconsistent: fail-closed.
    await expect(
      store.create({ record: makeRecord('txn_ref_bad', { nonce: num('5'), sequencingRef: { kind: 'nonce', value: num('6') } }) }),
    ).rejects.toThrow(/sequencing_ref/u);
    // Reference present but no nonce column: fail-closed.
    await expect(
      store.create({ record: makeRecord('txn_ref_nononce', { sequencingRef: { kind: 'nonce', value: num('1') } }) }),
    ).rejects.toThrow(/no nonce/u);
  });

  it('DB-01: production EVM create refuses a missing or reclaimed lease', async () => {
    await resetRows();
    const id = 'txn_expired_owner';
    const record = makeRecord(id, { nonce: num('8'), sequencingRef: { kind: 'nonce', value: num('8') } });

    await expect(store.create({ record })).rejects.toThrow(/lease|watermark/u);
    expect(await store.get(id as TransactionId)).toBeNull();

    await seedNonceLease(id, '8', { owner: 'txn_new_owner' });
    await expect(store.create({ record })).rejects.toThrow(/lease/u);
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
      }) })).rejects.toThrow(/lease/u);
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

  it('create with an existing lease for the same transactionId whose chain/from mismatch → fail-closed', async () => {
    await resetRows();
    const id = 'txn_lease_mismatch';
    // First place a lease that does not match the record (since M1-C00, leases no longer require the transaction row to exist first).
    await inspector.query(
      `INSERT INTO ${SCHEMA}.nonce_leases
         (chain_id, account_address, nonce, transaction_id, status, expires_at)
       VALUES ($1, '0xother', 9, $2, 'reserved', now() + interval '1 minute')`,
      [chain, id],
    );

    await expect(store.create({ record: makeRecord(id, { nonce: num('9'), sequencingRef: { kind: 'nonce', value: num('9') } }) })).rejects.toThrow(
      /lease/u,
    );
    // The record must not be persisted: otherwise a silent inconsistency like "record and lease point at different accounts" would appear.
    expect(await store.get(id as TransactionId)).toBeNull();
  });

  it('transition succeeds: state advances, version +1, and an audit row is written', async () => {
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

    // The audit row and the snapshot must exist together (same transaction).
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

  it('a transition carrying a patch also updates the allowlisted fields', async () => {
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

  it('a reorg rollback clears the stale blockRef and canonical hash in the same CAS', async () => {
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

  it('transition with a mismatched version → version_conflict, returning the current record', async () => {
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
    // The database is unchanged.
    expect(await rawRow('txn_vc')).toEqual({ status: 'built', state_version: '5', canonical_block_hash: null });
  });

  it('transition with a mismatched status → status_conflict', async () => {
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

  it('transition for an unknown transaction → not_found', async () => {
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

  it('row-lock determinism check: while the first transaction holds FOR UPDATE, the second connection must wait', async () => {
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

      // Give the second connection enough time to try to acquire the lock; if row locking were broken it would complete immediately.
      await new Promise((r) => setTimeout(r, 400));
      expect(settled, 'the second connection was not blocked: the row lock (FOR UPDATE) did not take effect').toBe(false);

      await c1.query('COMMIT');
      await pending;
      expect(settled, 'after the first transaction commits, the second connection should be released').toBe(true);
      await c2.query('COMMIT');
    } finally {
      c1.release();
      c2.release();
    }
  });

  it('many connections race on the same version: exactly one succeeds, and the version advances by only one', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_race') });

    // 8-way concurrency: all race on the same old version.
    //
    // 8-way rather than 2-way, so "lost updates" have nowhere to hide: without FOR UPDATE,
    // several connections might all read version=1 and succeed individually, overwriting the state multiple times.
    // With 2-way, occasional serial execution would mask this defect (see the mutation record in the delivery report).
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
    expect(applied, 'exactly one must succeed').toHaveLength(1);
    expect(conflicts).toHaveLength(CONCURRENCY - 1);

    // The database advances by only one, with only one audit row — direct evidence of "no lost updates".
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

  it('DB-REPLAY-26: concurrent CAS replays of an explicit dropped replay advance only once and keep the signature hash', async () => {
    await resetRows();
    const id = 'txn_dropped_replay_race';
    const expectedHash = `0x${'bc'.repeat(32)}`;
    await store.create({ record: makeRecord(id, {
      status: 'dropped',
      expectedHash,
      unsignedPayload: '0x02f8',
    }) });

    // 8 real PostgreSQL connections contend over the same dropped/version snapshot.
    // Any extra success would authorize a duplicate replay of the same signed transaction.
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

  it('when the transition audit write fails, the state snapshot rolls back (atomic commit)', async () => {
    await resetRows();
    await store.create({ record: makeRecord('txn_atomic') });

    // Install a probe constraint so the audit INSERT must fail; verify the snapshot UPDATE rolls back with it.
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

      // Key assertion: the snapshot must stay unchanged.
      expect(await rawRow('txn_atomic')).toEqual({ status: 'built', state_version: '1', canonical_block_hash: null });
      expect(await transitionCount('txn_atomic')).toBe(0);
    } finally {
      await inspector.query(
        `ALTER TABLE ${SCHEMA}.transaction_transitions DROP CONSTRAINT IF EXISTS probe_reject_reason`,
      );
    }
  });

  it('listRecoverable respects the batch cap and supports keyset pagination', async () => {
    await resetRows();
    for (let i = 0; i < 7; i += 1) {
      await store.create({
        record: makeRecord(`txn_rec_${i}`, { status: i % 2 === 0 ? 'pending' : 'finalized' }),
      });
    }

    const first = await store.listRecoverable({ limit: 3 });
    expect(first).toHaveLength(3);
    // By default only non-terminal transactions are returned (finalized is terminal).
    expect(first.every((r) => r.status !== 'finalized')).toBe(true);

    const second = await store.listRecoverable({
      limit: 3,
      afterTransactionId: first[first.length - 1]!.transactionId,
    });
    // Keyset pagination: the second batch must not repeat the first.
    const firstIds = new Set(first.map((r) => r.transactionId));
    expect(second.some((r) => firstIds.has(r.transactionId))).toBe(false);

    // Explicit state filtering.
    const finalized = await store.listRecoverable({ limit: 10, statuses: ['finalized'] });
    expect(finalized.every((r) => r.status === 'finalized')).toBe(true);
    expect(finalized.length).toBeGreaterThan(0);
  });

  it('listRecoverable supports the updatedAfter time lower bound (ADR-023 bounded observation of dropped)', async () => {
    await resetRows();
    // Create one dropped record with a clearly old updatedAt, and one newly created dropped record.
    const oldUpdatedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
    await store.create({
      record: makeRecord('txn_old_dropped', {
        status: 'dropped',
        updatedAt: oldUpdatedAt as never,
      }),
    });
    // makeRecord's default timestamp is fixed at 2026-10-04, so "now" must be passed explicitly, or both records would be old.
    const freshUpdatedAt = new Date().toISOString();
    await store.create({
      record: makeRecord('txn_new_dropped', {
        status: 'dropped',
        createdAt: freshUpdatedAt as never,
        updatedAt: freshUpdatedAt as never,
      }),
    });

    // Time lower bound = 6 hours ago → only the newly created record should be returned.
    const cutoff = new Date(Date.now() - 6 * 3600_000).toISOString() as never;
    const inWindow = await store.listRecoverable({
      limit: 10,
      statuses: ['dropped'],
      updatedAfter: cutoff,
    });
    expect(inWindow.map((r) => r.transactionId)).toEqual(['txn_new_dropped']);

    // Without a time lower bound, both are returned: proof the filtering really comes from updatedAfter, not something else.
    const all = await store.listRecoverable({ limit: 10, statuses: ['dropped'] });
    expect(all.map((r) => r.transactionId).sort()).toEqual([
      'txn_new_dropped',
      'txn_old_dropped',
    ]);
  });
});
