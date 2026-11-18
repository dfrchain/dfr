/**
 * Bounded `dropped` observation and convergence (ADR-023).
 *
 * `RecoveryCoordinator.reconcileDropped` keeps observing `dropped` records inside a bounded grace window,
 * so misjudgments can be corrected. This file locks:
 *   1. a dropped record inside the window is observed and can converge from dropped to included;
 *   2. a dropped record outside the window **does not enter the scan** (otherwise the "scan set only grows, RPCs run for nothing" problem returns);
 *   3. an `absent` observation does not change dropped (no repeated state writes).
 */
import { describe, expect, it } from 'vitest';
import { RecoveryCoordinator, type ChainBroadcastObservation } from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia' as never;
const TX_ID = 'txn_recovery_dropped' as never;
const HASH = `0x${'bb'.repeat(32)}`;
const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const HOUR = 3_600_000;

async function seedDropped(
  stores: ReturnType<typeof createInMemoryTransactionStores>,
  updatedAt: string,
  observation: ChainBroadcastObservation | (() => ChainBroadcastObservation),
) {
  await stores.transaction.create({
    record: {
      transactionId: TX_ID,
      projectId: 'default',
      chain: CHAIN,
      requestFingerprint: 'f'.repeat(64),
      status: 'dropped',
      stateVersion: '0',
      from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
      expectedHash: HASH,
      nonce: '7',
      createdAt: updatedAt,
      updatedAt,
    } as never,
  });
  const observed: string[] = [];
  const coordinator = new RecoveryCoordinator({
    transactions: stores.transaction,
    idempotency: stores.idempotency,
    nonce: stores.nonce,
    trackerLeases: stores.tracker,
    resolveUnknown: async (transactionId) => {
      observed.push(String(transactionId));
      // The real implementation observes via the Engine; here an injected port simulates "observed included".
      const obs = typeof observation === 'function' ? observation() : observation;
      if (obs.kind === 'included') {
        await stores.transaction.transition({
          transactionId,
          expectedStatus: 'dropped' as never,
          expectedVersion: '0' as never,
          toStatus: 'included' as never,
          reason: 'included' as never,
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
        });
      }
    },
    ownerToken: () => 'recovery-owner',
    droppedGraceMs: 6 * HOUR,
    clock: () => T0 + 1 * HOUR,
  });
  return { coordinator, observed };
}

describe('dropped bounded observation and convergence (ADR-023)', () => {
  it('a dropped record inside the window is observed and can converge to included', async () => {
    const stores = createInMemoryTransactionStores();
    const { coordinator, observed } = await seedDropped(
      stores,
      new Date(T0).toISOString(),
      { kind: 'included', txHash: HASH, blockRef: { kind: 'number', number: '100' } as never },
    );

    const corrected = await coordinator.reconcileDropped({ limit: 100 });

    expect(observed).toEqual([TX_ID]);
    expect(corrected).toBeGreaterThanOrEqual(1);
    expect((await stores.transaction.get(TX_ID))?.status).toBe('included');
  });

  it('a dropped record outside the window does not enter the scan (avoiding a scan set that only grows)', async () => {
    const stores = createInMemoryTransactionStores();
    // updatedAt = 10 hours ago, grace window is 6 hours → it should be excluded by the query condition.
    const { coordinator, observed } = await seedDropped(
      stores,
      new Date(T0 - 10 * HOUR).toISOString(),
      { kind: 'included', txHash: HASH },
    );

    const corrected = await coordinator.reconcileDropped({ limit: 100 });

    expect(observed).toEqual([]);
    expect(corrected).toBe(0);
    expect((await stores.transaction.get(TX_ID))?.status).toBe('dropped');
  });

  it('an absent observation keeps dropped and is not counted as a convergence', async () => {
    const stores = createInMemoryTransactionStores();
    const { coordinator, observed } = await seedDropped(stores, new Date(T0).toISOString(), {
      kind: 'absent',
    });

    const corrected = await coordinator.reconcileDropped({ limit: 100 });

    expect(observed).toEqual([TX_ID]);
    expect(corrected).toBe(0);
    expect((await stores.transaction.get(TX_ID))?.status).toBe('dropped');
  });

  it('an illegal limit fails closed', async () => {
    const stores = createInMemoryTransactionStores();
    const { coordinator } = await seedDropped(stores, new Date(T0).toISOString(), {
      kind: 'absent',
    });
    await expect(coordinator.reconcileDropped({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(coordinator.reconcileDropped({ limit: 501 })).rejects.toBeInstanceOf(RangeError);
  });
});
