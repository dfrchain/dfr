//
// M1-D fault-injection acceptance (DFR-M1-D07).
//
// Authoritative sources: the D07 card in docs/development/m1-taskbook.md; ADR-019/020/021; m1-storage-model.
//
// Why a separate file: the **component-level** behavior of each fault point is already covered by unit tests (tracker/recovery/reorg/
// provider/confirm). D07 must prove these components stay correct when **combined** on real PostgreSQL,
// so this file uses real Stores + real concurrent connections, replacing only the chain RPC at the outermost layer.
//
// Five scenarios: process restart, Provider failover, lease loss, short reorg, confirmation timeout.
// Requires `DFR_TRANSACTION_DATABASE_URL`; only runs under `pnpm test:db`.
//
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DfrCore } from '@dfr/core';
import { EvmAdapter } from '@dfr/adapter-evm';
import { createStubFetch } from '@dfr/provider';
import { ChainRegistry } from '@dfr/registry';
import { RecoveryCoordinator, ReorgReconciler, TransactionEngine, TransactionMetrics } from '@dfr/transaction';
import type { ChainId, DecimalUint, Iso8601, TransactionId } from '@dfr/types';
import { createPostgresTransactionRuntime } from '../../packages/storage-postgres/src/index.js';

const DATABASE_URL = process.env['DFR_TRANSACTION_DATABASE_URL'];
const ENABLED = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;
const CHAIN = 'ethereum-sepolia' as ChainId;

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

function address(tag: string): string {
  return `0x${tag.padEnd(40, '0').slice(0, 40)}`;
}

function stubChain() {
  return {
    getPendingNonce: async (): Promise<DecimalUint> => '7' as DecimalUint,
    build: async ({ request }: { request: { chain: ChainId; nonce: DecimalUint } }) => ({
      schemaVersion: '1',
      chain: request.chain,
      payload: '0x02f86b0180808080942222222222222222222222222222222222222280c0',
      meta: { encoding: 'hex', requiresNonce: request.nonce },
    }),
    simulate: async () => ({ success: true, gasUsed: '21000' as DecimalUint }),
  };
}

describe.skipIf(!ENABLED)('M1-D fault-injection acceptance (DFR-M1-D07)', () => {
  it('process restart: after closing and rebuilding the Pool, non-terminal transactions can be rediscovered by the recovery scan, with state intact', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const first = await openRuntime();
    const engine = new TransactionEngine({
      stores: {
        transaction: first.stores.transaction,
        idempotency: first.stores.idempotency,
        nonce: first.stores.nonce,
        tracker: first.stores.tracker,
      },
      chain: stubChain() as never,
    });
    const built = await engine.build({
      request: {
        chain: CHAIN,
        from: { chain: CHAIN, address: address(suffix) },
        to: { chain: CHAIN, address: address('2') },
        value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' as DecimalUint },
      },
      idempotencyKey: `d07-restart-${suffix}`,
    });
    expect(built.status).toBe('built');

    // Create another unknown record whose broadcast outcome is uncertain: only that one is in scope for the recovery scan.
    const unknownId = `txn_d07_unknown_${suffix}` as TransactionId;
    const expectedHash = `0x${suffix.padEnd(64, '0').slice(0, 64)}`;
    // DB-03 / NEW-04: even a synthetic unknown record must be backed by a
    // real nonce lease. Never forge a nonce outside the production reserve API.
    const unknownLease = await first.stores.nonce.reserve({
      chain: CHAIN,
      account: { chain: CHAIN, address: address(suffix) },
      transactionId: unknownId,
      chainPendingNonce: '8' as DecimalUint,
      leaseTtlMs: 60_000,
    });
    if (unknownLease.kind === 'conflict') {
      throw new Error('fault-injection fixture failed to reserve its nonce');
    }
    await first.stores.transaction.create({
      record: {
        transactionId: unknownId,
        projectId: 'default',
        chain: CHAIN,
        requestFingerprint: 'c'.repeat(64),
        status: 'unknown',
        stateVersion: '0' as DecimalUint,
        from: { chain: CHAIN, address: address(suffix) },
        expectedHash,
        nonce: unknownLease.lease.nonce,
        sequencingRef: { kind: 'nonce', value: unknownLease.lease.nonce },
        createdAt: new Date().toISOString() as Iso8601,
        updatedAt: new Date().toISOString() as Iso8601,
      },
    });

    // Simulate a process exit: stop the engine background loop first, then close the whole Pool.
    engine.close();
    await first.close();
    opened.pop();

    const restarted = await openRuntime();
    const resolved: TransactionId[] = [];
    const coordinator = new RecoveryCoordinator({
      transactions: restarted.stores.transaction,
      idempotency: restarted.stores.idempotency,
      nonce: restarted.stores.nonce,
      trackerLeases: restarted.stores.tracker,
      resolveUnknown: async (transactionId) => { resolved.push(transactionId); },
      ownerToken: () => `recovery-${suffix}`,
    });
    // The recovery scan must run to completion safely (without throwing) and resolve the unknown records left behind before the restart.
    const recovered = await coordinator.run({ limit: 100 });
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(resolved).toContain(unknownId);

    // built transactions persist across the restart and their state is not wrongly changed by the recovery scan; but built is not a "recoverable state" (by design).
    const after = await restarted.stores.transaction.get(built.transactionId);
    expect(after?.status).toBe('built');
    const recoverable = await restarted.stores.transaction.listRecoverable({ limit: 500 });
    expect(recoverable.map((record) => record.transactionId)).toContain(unknownId);
    expect(recoverable.map((record) => record.transactionId)).not.toContain(built.transactionId);
  });

  it('lease loss: within a valid lease, a second owner must not take over; after release it may', async () => {
    const runtime = await openRuntime();
    const txHash = `0x${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`;

    const first = await runtime.stores.tracker.acquire({
      chain: CHAIN,
      txHash,
      ownerToken: 'owner-a',
      leaseTtlMs: 60_000,
    });
    expect(first.kind).toBe('acquired');

    const blocked = await runtime.stores.tracker.acquire({
      chain: CHAIN,
      txHash,
      ownerToken: 'owner-b',
      leaseTtlMs: 60_000,
    });
    expect(blocked.kind).toBe('held_by_other');

    const renewed = await runtime.stores.tracker.renew({
      chain: CHAIN,
      txHash,
      ownerToken: 'owner-b',
      leaseTtlMs: 60_000,
    });
    expect(renewed.kind).toBe('lost');

    const released = await runtime.stores.tracker.release({ chain: CHAIN, txHash, ownerToken: 'owner-a' });
    expect(released.kind).toBe('released');

    const second = await runtime.stores.tracker.acquire({
      chain: CHAIN,
      txHash,
      ownerToken: 'owner-b',
      leaseTtlMs: 60_000,
    });
    expect(second.kind).toBe('acquired');
  });

  it('short reorg: when the canonical hash changes, roll included back to pending and clear the anchors; when the hash is unchanged, do nothing', async () => {
    const runtime = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const timestamp = new Date().toISOString() as Iso8601;
    const anchoredHash = `0x${'b'.repeat(64)}`;
    const transactionId = `txn_d07_reorg_${suffix}` as TransactionId;
    const txHash = `0x${suffix.padEnd(64, '0').slice(0, 64)}`;

    await runtime.stores.transaction.create({
      record: {
        transactionId,
        projectId: 'default',
        chain: CHAIN,
        requestFingerprint: 'a'.repeat(64),
        status: 'included',
        stateVersion: '1' as DecimalUint,
        from: { chain: CHAIN, address: address(suffix) },
        txHash,
        blockRef: { kind: 'number', number: '100' as DecimalUint },
        canonicalBlockHash: anchoredHash,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });

    const metrics = new TransactionMetrics();
    const published: unknown[] = [];
    const reconcile = (canonicalHash: string) => new ReorgReconciler({
      transactions: runtime.stores.transaction,
      leases: runtime.stores.tracker,
      metrics,
      canonicalBlockHash: async () => canonicalHash,
      publish: (event) => { published.push(event); },
      ownerToken: () => `reorg-${suffix}`,
    });

    // Negative control: canonical hash unchanged → no rollback.
    await reconcile(anchoredHash).run({ limit: 100 });
    expect((await runtime.stores.transaction.get(transactionId))?.status).toBe('included');
    expect(published).toHaveLength(0);
    expect(metrics.renderPrometheus()).not.toContain('dfr_transaction_reorg_total');

    // Positive case: canonical hash changed → included → pending, with anchors cleared.
    await reconcile(`0x${'c'.repeat(64)}`).run({ limit: 100 });
    const rolledBack = await runtime.stores.transaction.get(transactionId);
    expect(rolledBack?.status).toBe('pending');
    expect(rolledBack?.canonicalBlockHash).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(metrics.renderPrometheus()).toContain('dfr_transaction_reorg_total');
  });

  it('confirmation timeout: when the target finality is not reached within the wait limit, return reached=false without rewriting the record', async () => {
    const runtime = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const txHash = `0x${suffix.padEnd(64, '0').slice(0, 64)}`;
    let clock = 0;
    let calls = 0;
    const engine = new TransactionEngine({
      stores: {
        transaction: runtime.stores.transaction,
        idempotency: runtime.stores.idempotency,
        nonce: runtime.stores.nonce,
        tracker: runtime.stores.tracker,
      },
      chain: {
        confirm: async () => {
          calls += 1;
          return {
            ref: { kind: 'hash', hash: txHash },
            status: 'pending',
            finality: 'unknown',
            requiredFinality: 'finalized',
            reached: calls > 1,
          };
        },
      } as never,
      // The clock jumps forward in big steps each time, so the wait loop reaches the deadline right after the first observation (without really sleeping).
      confirmationClock: () => (clock += 1_000_000),
      confirmationSleep: async () => undefined,
    });

    const confirmation = await engine.confirm({
      chain: CHAIN,
      txHash,
      minFinality: 'finalized',
      timeoutMs: 1_000,
    });
    expect(confirmation.reached).toBe(false);
    expect(confirmation.status).toBe('pending');
    expect(calls).toBeGreaterThanOrEqual(1);
    engine.close();
  });

  it('Provider failover: when the primary Provider returns 5xx, switch to the backup and return a result, transparent to the caller', async () => {
    const calledProviders: string[] = [];
    const runtime = await openRuntime();
    const registry = ChainRegistry.load({
      file: new URL('../../packages/registry/config/chains.yaml', import.meta.url).pathname,
      env: {
        DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://stub.local/sepolia-primary',
        DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_KEY: 'stub-primary',
        DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://stub.local/sepolia-secondary',
        DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_KEY: 'stub-secondary',
      },
    });
    const core = new DfrCore({
      registry,
      adapters: [{ id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) }],
      milestone: 'M1',
      // Fixed weighted selection: otherwise the backup Provider might be picked first and the primary Provider never called,
      // so "failover" would degrade into "direct success" (this case used to fail with ~25% probability for this reason).
      random: () => 0,
      // The primary Provider returns all 5xx; the backup returns the balance.
      fetchImpl: createStubFetch({
        onCall: (call) => { calledProviders.push(call.providerId); },
        behaviors: {
          'sepolia-primary': [{ kind: 'http', status: 503 }],
          'sepolia-secondary': [{ kind: 'result', value: '0x2a' }],
        },
      }),
      transactionStores: runtime.stores,
    });

    const ctx = { requestId: `req_${randomUUID().replaceAll('-', '').slice(0, 26)}`, signal: new AbortController().signal };
    const balance = await core.getBalance(
      { chain: CHAIN, account: { chain: CHAIN, address: address(randomUUID().replaceAll('-', '')) } },
      ctx as never,
    );
    expect(balance.amount).toBe('42');
    // The primary Provider is tried first and fails, then it switches to the backup -- this is "failover", not "primary never called".
    expect(calledProviders).toContain('sepolia-primary');
    expect(calledProviders).toContain('sepolia-secondary');
  });
});
