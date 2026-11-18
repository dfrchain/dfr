/**
 * M1 real persistence: ops reconciliation channel for stranded Solana `signed` records (issue #22 gate 4, ADR-040).
 *
 * Difference from `packages/transaction/test/recovery.test.ts` (in-memory stand-in unit test): this file uses a
 * **real PostgreSQL Store** to assemble the `RecoveryCoordinator`, verifying the ops channel holds under real
 * CAS / tracker lease / sequencing lease semantics:
 *
 *   - stale Solana `signed` records can be manually named and moved to `unknown`;
 *   - fresh records of the same kind are rejected (`not_stale`), state unchanged;
 *   - EVM records are out of scope for this channel (`not_applicable`), and the existing `recoverStaleSigned`
 *     sweep behaves the same on real PG;
 *   - the channel has no broadcast path at all: the `RecoveryCoordinator`'s dependencies contain no chain port,
 *     after migration the record's `txHash` is still empty and its state only reaches `unknown`; the only external effect is
 *     a read-only resolution callback (this test receives it with a recording stand-in and asserts the call).
 *
 * Requires `DFR_TRANSACTION_DATABASE_URL`, so it only runs under `pnpm test:db`.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RecoveryCoordinator } from '@dfr/transaction';
import type { AccountRef, ChainId, DecimalUint, TransactionId } from '@dfr/types';
import { createPostgresTransactionRuntime } from '../../packages/storage-postgres/src/index.js';

const DATABASE_URL = process.env.DFR_TRANSACTION_DATABASE_URL;
const ENABLED = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;
const SOL = 'solana-devnet' as ChainId;
const EVM = 'ethereum-sepolia' as ChainId;
const BLOCKHASH = '11111111111111111111111111111111';

type Runtime = Awaited<ReturnType<typeof createPostgresTransactionRuntime>>;
const opened: Runtime[] = [];

async function openRuntime(): Promise<Runtime> {
  const runtime = await createPostgresTransactionRuntime({ databaseUrl: DATABASE_URL! });
  opened.push(runtime);
  return runtime;
}

afterEach(async () => {
  while (opened.length > 0) {
    const runtime = opened.pop();
    if (runtime !== undefined) await runtime.close();
  }
});

function sequencingOf(runtime: Runtime) {
  const { sequencing } = runtime.stores;
  if (sequencing === undefined) {
    throw new Error('postgres runtime must assemble the sequencing store');
  }
  return sequencing;
}

function coordinatorFor(runtime: Runtime, observed: TransactionId[]) {
  return new RecoveryCoordinator({
    transactions: runtime.stores.transaction,
    idempotency: runtime.stores.idempotency,
    nonce: runtime.stores.nonce,
    sequencing: sequencingOf(runtime),
    trackerLeases: runtime.stores.tracker,
    resolveUnknown: async (transactionId) => {
      observed.push(transactionId);
    },
    ownerToken: () => `ops-${randomUUID()}`,
  });
}

/** Persist a Solana `signed` record: reserve sequencing lease → create(built) → sign. */
async function seedSolanaSigned(runtime: Runtime): Promise<{
  transactionId: TransactionId;
  account: AccountRef;
  signature: string;
}> {
  const suffix = randomUUID().replaceAll('-', '');
  const transactionId = `txn_gate4_sol_${suffix}` as TransactionId;
  const account: AccountRef = {
    chain: SOL,
    address: 'So11111111111111111111111111111111111111112',
  };
  const signature = `sig${suffix}`;
  const token = {
    kind: 'blockhash' as const,
    value: BLOCKHASH,
    lastValidBlockHeight: '495317734' as DecimalUint,
  };
  const lease = await sequencingOf(runtime).reserve({
    chain: SOL, account, transactionId, token, leaseTtlMs: 120_000,
  });
  expect(lease.kind).toBe('reserved');
  const now = new Date().toISOString();
  const created = await runtime.stores.transaction.create({
    record: {
      transactionId, projectId: 'default', chain: SOL,
      requestFingerprint: 'a'.repeat(64),
      status: 'built', stateVersion: '0' as DecimalUint, from: account,
      sequencingRef: token,
      unsignedPayload: 'AQID', payloadEncoding: 'base64',
      createdAt: now as never, updatedAt: now as never,
    },
  });
  expect(created.kind).toBe('created');
  const signed = await runtime.stores.transaction.transition({
    transactionId, expectedStatus: 'built', expectedVersion: '0' as DecimalUint,
    toStatus: 'signed', reason: 'sign', patch: { expectedHash: signature },
  });
  expect(signed.kind).toBe('applied');
  return { transactionId, account, signature };
}

/** Persist an EVM `signed` record (same B37 order: reserve nonce → create → sign). */
async function seedEvmSigned(runtime: Runtime): Promise<{ transactionId: TransactionId }> {
  const suffix = randomUUID().replaceAll('-', '');
  const transactionId = `txn_gate4_evm_${suffix}` as TransactionId;
  const account: AccountRef = {
    chain: EVM,
    address: `0x${suffix.padEnd(40, '0').slice(0, 40)}`,
  };
  const lease = await runtime.stores.nonce.reserve({
    chain: EVM, account, transactionId,
    chainPendingNonce: '7' as DecimalUint, leaseTtlMs: 120_000,
  });
  expect(lease.kind).toBe('reserved');
  if (lease.kind !== 'reserved') throw new Error('unreachable');
  const now = new Date().toISOString();
  const created = await runtime.stores.transaction.create({
    record: {
      transactionId, projectId: 'default', chain: EVM,
      requestFingerprint: 'b'.repeat(64),
      status: 'simulated', stateVersion: '0' as DecimalUint, from: account,
      nonce: lease.lease.nonce,
      sequencingRef: { kind: 'nonce', value: lease.lease.nonce },
      unsignedPayload: '0x02f8', payloadEncoding: 'hex',
      createdAt: now as never, updatedAt: now as never,
    },
  });
  expect(created.kind).toBe('created');
  const signed = await runtime.stores.transaction.transition({
    transactionId, expectedStatus: 'simulated', expectedVersion: '0' as DecimalUint,
    toStatus: 'signed', reason: 'sign', patch: { expectedHash: `0x${suffix}` },
  });
  expect(signed.kind).toBe('applied');
  return { transactionId };
}

describe.skipIf(!ENABLED)('M1 real persistence: signed stranding reconciliation (issue #22 gate 4 / ADR-040)', () => {
  it('stale Solana signed records can be moved to unknown by the ops channel (real CAS + lease fencing)', async () => {
    const runtime = await openRuntime();
    const { transactionId } = await seedSolanaSigned(runtime);
    const observed: TransactionId[] = [];
    const coordinator = coordinatorFor(runtime, observed);

    // Use the injected clock to push the record past the staleness window (updatedAt is the persist time, now = +10 minutes).
    const outcome = await coordinator.reconcileStrandedSigned({
      transactionId, staleAfterMs: 300_000, now: Date.now() + 10 * 60_000,
    });
    expect(outcome).toBe('transitioned');

    const after = await runtime.stores.transaction.get(transactionId);
    expect(after?.status).toBe('unknown');
    // Advance only one step: version 0(built) → 1(sign) → 2(unknown), never passing through broadcast.
    expect(after?.stateVersion).toBe('2');
    expect(after?.txHash).toBeUndefined();
    // The only external effect is one read-only resolution callback; the channel does not touch the sequencing lease (the
    // sequencingRef in the record stays as-is, and the lease row is left for TTL reclamation -- this record is a variant of
    // "crashed after signing, before markConsumed", and the lease is still reserved).
    expect(observed).toEqual([transactionId]);
    expect(after?.sequencingRef?.kind).toBe('blockhash');
  });

  it('fresh Solana signed records are rejected (not_stale), state stays signed', async () => {
    const runtime = await openRuntime();
    const { transactionId } = await seedSolanaSigned(runtime);
    const observed: TransactionId[] = [];
    const coordinator = coordinatorFor(runtime, observed);

    const outcome = await coordinator.reconcileStrandedSigned({
      transactionId, staleAfterMs: 300_000, now: Date.now(),
    });
    expect(outcome).toBe('not_stale');

    const after = await runtime.stores.transaction.get(transactionId);
    expect(after?.status).toBe('signed');
    expect(after?.stateVersion).toBe('1');
    expect(observed).toEqual([]);
  });

  it('EVM records are out of scope for the ops channel (not_applicable), and the existing recoverStaleSigned sweep behaves the same', async () => {
    const runtime = await openRuntime();
    const { transactionId } = await seedEvmSigned(runtime);
    const observed: TransactionId[] = [];
    const coordinator = coordinatorFor(runtime, observed);
    const future = Date.now() + 10 * 60_000;

    await expect(coordinator.reconcileStrandedSigned({
      transactionId, staleAfterMs: 300_000, now: future,
    })).resolves.toBe('not_applicable');
    expect((await runtime.stores.transaction.get(transactionId))?.status).toBe('signed');

    // The same record is then repaired by the existing EVM sweep with the original semantics: signed → unknown + read-only resolution.
    // The shared runner library may contain stale EVM records left by other suites; only assert that this record is repaired.
    const repaired = await coordinator.recoverStaleSigned({
      limit: 10, staleAfterMs: 300_000, now: future,
    });
    expect(repaired).toBeGreaterThanOrEqual(1);
    expect((await runtime.stores.transaction.get(transactionId))?.status).toBe('unknown');
    expect(observed).toContain(transactionId);
  });
});
