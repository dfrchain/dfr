/**
 * `unknown` timing out into `dropped`, and `dropped` convergence (ADR-023 / TODO-011).
 *
 * Background: ADR-019 assigned `unknown → dropped` to D03, but D03 never implemented it, so this edge had
 * **no code path triggering it at all**. The consequence: a transaction whose broadcast result is indeterminate and never found on-chain stays in
 * `unknown` forever: queried again and again inside the recovery scan set, and its nonce lease is never released.
 *
 * This file locks ADR-023's four rules:
 *   1. observation `absent` with silence not yet at `dropTimeoutMs` → **stay `unknown`** (never judge dropped early);
 *   2. observation `absent` with the timeout passed → move to `dropped`;
 *   3. observation `included`/`pending`/`replaced` → **observation wins**: even after the timeout, never judge dropped;
 *   4. a `dropped` record can be corrected back to `included`/`pending`/`replaced` by later observations inside the grace window.
 */
import { describe, expect, it } from 'vitest';
import { TransactionEngine, type ChainBroadcastObservation } from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia' as never;
const TX_ID = 'txn_drop_test' as never;
const EXPECTED_HASH = `0x${'aa'.repeat(32)}`;

/** A controllable clock: `dropClock` decides "now", and therefore whether dropTimeoutMs has been crossed. */
function harness(options: { nowMs: number; dropTimeoutMs?: number; observation: ChainBroadcastObservation | (() => ChainBroadcastObservation) }) {
  const stores = createInMemoryTransactionStores();
  let clockMs = options.nowMs;
  const engine = new TransactionEngine({
    stores,
    chain: {
      getPendingNonce: async () => '7' as never,
      build: async () => ({
        schemaVersion: '1',
        chain: CHAIN,
        payload: '0x02f8',
        meta: { encoding: 'hex', requiresNonce: '7' },
      }),
      broadcast: async () => ({ accepted: true, ref: { kind: 'hash', hash: EXPECTED_HASH }, observedAt: new Date(clockMs).toISOString() }),
      observe: async () =>
        typeof options.observation === 'function' ? options.observation() : options.observation,
    } as never,
    newTransactionId: () => TX_ID,
    dropClock: () => clockMs,
    ...(options.dropTimeoutMs !== undefined ? { dropTimeoutMs: options.dropTimeoutMs } : {}),
  });
  return { engine, stores, setClock: (ms: number) => { clockMs = ms; } };
}

/** Construct a `unknown` record directly: avoid depending on the broadcast path and focus on the timeout semantics themselves. */
async function seedUnknown(stores: ReturnType<typeof createInMemoryTransactionStores>, updatedAt: string) {
  await stores.transaction.create({
    record: {
      transactionId: TX_ID,
      projectId: 'default',
      chain: CHAIN,
      requestFingerprint: 'f'.repeat(64),
      status: 'unknown',
      stateVersion: '0',
      from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
      expectedHash: EXPECTED_HASH,
      nonce: '7',
      createdAt: updatedAt,
      updatedAt,
    } as never,
  });
}

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const ABSENT: ChainBroadcastObservation = { kind: 'absent' };

describe('unknown timing out into dropped (ADR-023)', () => {
  it('observation absent but dropTimeoutMs not reached → stay unknown (never judge dropped early)', async () => {
    const h = harness({ nowMs: T0 + 60_000, dropTimeoutMs: 1_800_000, observation: ABSENT });
    await seedUnknown(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('unknown');
  });

  it('observation absent with the timeout passed → move to dropped', async () => {
    const h = harness({ nowMs: T0 + 1_800_000, dropTimeoutMs: 1_800_000, observation: ABSENT });
    await seedUnknown(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('dropped');
  });

  it('observation included wins over the timeout: even after the timeout, judge included, never dropped', async () => {
    const h = harness({
      nowMs: T0 + 10_000_000,
      dropTimeoutMs: 1_800_000,
      observation: {
        kind: 'included',
        txHash: EXPECTED_HASH,
        blockRef: { kind: 'number', number: '100' } as never,
      },
    });
    await seedUnknown(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('included');
  });

  it('observation pending wins over the timeout → pending', async () => {
    const h = harness({
      nowMs: T0 + 10_000_000,
      dropTimeoutMs: 1_800_000,
      observation: { kind: 'pending', txHash: EXPECTED_HASH },
    });
    await seedUnknown(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('pending');
  });

  it('observation unavailable (observe throws) → stay unknown; do not misjudge dropped', async () => {
    const stores = createInMemoryTransactionStores();
    const engine = new TransactionEngine({
      stores,
      chain: {
        observe: async () => {
          throw new Error('rpc down');
        },
      } as never,
      newTransactionId: () => TX_ID,
      dropClock: () => T0 + 10_000_000,
      dropTimeoutMs: 1_800_000,
    });
    await seedUnknown(stores, new Date(T0).toISOString());

    const record = await engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('unknown');
  });
});

describe('dropped convergence (ADR-023, correcting misjudgments)', () => {
  async function seedDropped(stores: ReturnType<typeof createInMemoryTransactionStores>, updatedAt: string) {
    await seedUnknown(stores, updatedAt);
    await stores.transaction.transition({
      transactionId: TX_ID,
      expectedStatus: 'unknown' as never,
      expectedVersion: '0' as never,
      toStatus: 'dropped' as never,
      reason: 'dropped' as never,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    });
  }

  it('dropped + observation included → correct to included (otherwise a confirmed transaction would be reported as "dropped")', async () => {
    const h = harness({
      nowMs: T0 + 3_600_000,
      observation: {
        kind: 'included',
        txHash: EXPECTED_HASH,
        blockRef: { kind: 'number', number: '100' } as never,
      },
    });
    await seedDropped(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('included');
  });

  it('dropped + observation pending → correct to pending', async () => {
    const h = harness({
      nowMs: T0 + 3_600_000,
      observation: { kind: 'pending', txHash: EXPECTED_HASH },
    });
    await seedDropped(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('pending');
  });

  it('dropped + observation replaced → correct to replaced', async () => {
    const h = harness({
      nowMs: T0 + 3_600_000,
      observation: { kind: 'replaced', nonce: '7' },
    });
    await seedDropped(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('replaced');
  });

  it('dropped + observation absent → stay dropped (do not rewrite state repeatedly)', async () => {
    const h = harness({ nowMs: T0 + 3_600_000, observation: ABSENT });
    await seedDropped(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('dropped');
  });

  it('terminal states are unaffected: non-unknown/dropped records are returned as-is', async () => {
    const h = harness({ nowMs: T0, observation: ABSENT });
    await h.stores.transaction.create({
      record: {
        transactionId: TX_ID,
        projectId: 'default',
        chain: CHAIN,
        requestFingerprint: 'f'.repeat(64),
        status: 'finalized',
        stateVersion: '0',
        from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
        createdAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
      } as never,
    });
    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });
    expect(record?.status).toBe('finalized');
  });
});
