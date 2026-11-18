/**
 * `tx.*` state-event outlet (a leftover M2 item: event wiring).
 *
 * transaction-lifecycle chapter 6: "every state change must emit an event". The engine's `applyTransition`
 * is the single point for all state transitions, so hooking here covers every path.
 *
 * Why an **injected callback** instead of letting the engine depend on `@dfr/events`: module boundaries require
 * `packages/transaction` to depend only on leaf utility packages (types/errors/metrics). The callback is isomorphic to the existing
 * `onStoreCall` — the engine knows nothing about the bus; the cursor is allocated by the composition root.
 */
import { describe, expect, it } from 'vitest';
import type { ChainId, DecimalUint, Iso8601, RequestId, TransactionId } from '@dfr/types';
import type {
  TransactionRecord,
  TransactionStore,
  TransitionTransactionInput,
} from '../src/stores.js';
import { TransactionEngine, type TransitionEventRecord } from '../src/engine.js';

const CHAIN = 'ethereum-sepolia' as ChainId;
const TX_ID = 'txn_evt_1' as TransactionId;
const REQ = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;

/** A controllable Store: records every transition call and returns applied. */
function makeStore(initial: TransactionRecord): {
  store: TransactionStore;
  transitions: TransitionTransactionInput[];
} {
  let current = initial;
  const transitions: TransitionTransactionInput[] = [];
  const store = {
    get: async () => current,
    create: async () => ({ kind: 'created', record: current }),
    transition: async (input: TransitionTransactionInput) => {
      transitions.push(input);
      current = {
        ...current,
        status: input.toStatus,
        stateVersion: (BigInt(current.stateVersion) + 1n).toString(10) as DecimalUint,
        ...(input.patch?.txHash !== undefined ? { txHash: input.patch.txHash } : {}),
      };
      return { kind: 'applied', record: current };
    },
    listRecoverable: async () => [],
    getByHash: async () => null,
  } as unknown as TransactionStore;
  return { store, transitions };
}

function record(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    transactionId: TX_ID,
    projectId: 'default',
    chain: CHAIN,
    requestFingerprint: 'a'.repeat(64),
    status: 'simulated',
    stateVersion: '1' as DecimalUint,
    from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
    unsignedPayload: '0x02f8',
    nonce: '1' as DecimalUint,
    createdAt: '2026-10-06T00:00:00.000Z' as Iso8601,
    updatedAt: '2026-10-06T00:00:00.000Z' as Iso8601,
    ...overrides,
  };
}

/** Only the minimal port needed for the engine to drive one broadcast (without touching the chain). */
function engine(
  store: TransactionStore,
  onTransition?: (record: TransitionEventRecord) => void,
): TransactionEngine {
  return new TransactionEngine({
    stores: { transaction: store, idempotency: {} as never, nonce: {} as never, tracker: {} as never },
    chain: {
      broadcast: async () => ({
        ref: { kind: 'hash', hash: `0x${'aa'.repeat(32)}` },
        status: 'broadcast',
        accepted: true,
        observedAt: '2026-10-06T00:00:01.000Z' as Iso8601,
      }),
    } as never,
    ...(onTransition !== undefined ? { onTransition } : {}),
  });
}

const SIGNED = {
  schemaVersion: '1',
  chain: CHAIN,
  unsigned: { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: {} },
  signedPayload: `0x${'ab'.repeat(100)}`,
  expectedHash: `0x${'aa'.repeat(32)}`,
} as never;

describe('tx.* state-event outlet', () => {
  it('every successful transition emits one event, containing "the committed facts"', async () => {
    const { store } = makeStore(record());
    const events: TransitionEventRecord[] = [];
    await engine(store, (e) => events.push(e)).broadcast({
      transactionId: TX_ID,
      signed: SIGNED,
      requestId: REQ,
    });

    // simulated → signed → broadcast, two hops.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ fromStatus: 'simulated', toStatus: 'signed', chain: CHAIN });
    expect(events[1]).toMatchObject({ fromStatus: 'signed', toStatus: 'broadcast' });
    // Each hop carries the post-transition version and the requestId (traceable to the concrete request).
    expect(events[0]!.stateVersion).toBe('2');
    expect(events[1]!.stateVersion).toBe('3');
    expect(events[0]!.requestId).toBe(REQ);
  });

  it('a throwing sink never affects the state transition (events are best-effort)', async () => {
    const { store, transitions } = makeStore(record());
    const e = engine(store, () => {
      throw new Error('sink boom');
    });
    // The call itself must succeed — otherwise "observation is down" would become "business is down".
    await expect(
      e.broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQ }),
    ).resolves.toMatchObject({ status: 'broadcast' });
    // And the state genuinely transitioned (not swallowed as a whole).
    expect(transitions.map((t) => t.toStatus)).toEqual(['signed', 'broadcast']);
  });

  it('no error when no sink is injected (the zero-overhead path)', async () => {
    const { store } = makeStore(record());
    await expect(
      engine(store).broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQ }),
    ).resolves.toMatchObject({ status: 'broadcast' });
  });
});
