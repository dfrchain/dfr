import { describe, expect, it } from 'vitest';
import type { ChainId, DecimalUint, Iso8601, TransactionId } from '@dfr/types';
import type { ChainEvent, ReorgEventPayload } from '@dfr/types';
import type {
  TrackerLease,
  TrackerLeaseStore,
  TransactionRecord,
  TransactionStore,
  TransitionTransactionInput,
} from '../src/stores.js';
import { ReorgReconciler } from '../src/tracker.js';

const chain = 'ethereum-sepolia' as ChainId;
const record: TransactionRecord = {
  transactionId: 'txn_reorg_1' as TransactionId,
  projectId: 'default',
  chain,
  requestFingerprint: 'a'.repeat(64),
  status: 'included',
  stateVersion: '4' as DecimalUint,
  from: { chain, address: '0x1111111111111111111111111111111111111111' },
  txHash: `0x${'a'.repeat(64)}`,
  blockRef: { kind: 'number', number: '100' as DecimalUint },
  canonicalBlockHash: `0x${'b'.repeat(64)}`,
  createdAt: '2026-10-05T00:00:00.000Z' as Iso8601,
  updatedAt: '2026-10-05T00:00:00.000Z' as Iso8601,
};
const lease: TrackerLease = {
  chain,
  txHash: record.txHash!,
  ownerToken: 'owner',
  leaseExpiresAt: '2026-10-05T00:00:30.000Z' as Iso8601,
  heartbeatAt: '2026-10-05T00:00:00.000Z' as Iso8601,
};
const newHash = `0x${'c'.repeat(64)}`;

function leaseStore(overrides: Partial<TrackerLeaseStore> = {}): TrackerLeaseStore {
  return {
    acquire: async () => ({ kind: 'acquired', lease }),
    renew: async () => ({ kind: 'renewed', lease }),
    release: async () => ({ kind: 'released' }),
    listRecoverable: async () => [],
    ...overrides,
  };
}

function harness(options: {
  current?: TransactionRecord;
  canonicalHash?: string | null;
  held?: boolean;
  leaseLost?: boolean;
  casConflict?: boolean;
} = {}) {
  let current = options.current ?? record;
  const transitions: TransitionTransactionInput[] = [];
  const events: ChainEvent<ReorgEventPayload>[] = [];
  let observes = 0;
  const transactions = {
    listRecoverable: async () => current.status === 'included' ? [current] : [],
    transition: async (input: TransitionTransactionInput) => {
      transitions.push(input);
      if (options.casConflict === true) {
        return { kind: 'status_conflict' as const, current: { ...current, status: 'pending' as const } };
      }
      const {
        blockRef: previousBlockRef,
        canonicalBlockHash: previousCanonicalBlockHash,
        ...currentWithoutAnchors
      } = current;
      const next: TransactionRecord = {
        ...currentWithoutAnchors,
        status: input.toStatus,
        stateVersion: (BigInt(current.stateVersion) + 1n).toString(10) as DecimalUint,
        ...(input.patch?.blockRef !== undefined
          ? input.patch.blockRef === null ? {} : { blockRef: input.patch.blockRef }
          : previousBlockRef !== undefined ? { blockRef: previousBlockRef } : {}),
        ...(input.patch?.canonicalBlockHash !== undefined
          ? input.patch.canonicalBlockHash === null ? {} : { canonicalBlockHash: input.patch.canonicalBlockHash }
          : previousCanonicalBlockHash !== undefined ? { canonicalBlockHash: previousCanonicalBlockHash } : {}),
      };
      current = next;
      return { kind: 'applied' as const, record: current };
    },
  } as unknown as TransactionStore;
  const leases = leaseStore({
    acquire: async () => options.held === true
      ? { kind: 'held_by_other', lease }
      : { kind: 'acquired', lease },
    renew: async () => options.leaseLost === true
      ? { kind: 'lost' }
      : { kind: 'renewed', lease },
  });
  const reconciler = new ReorgReconciler({
    transactions,
    leases,
    canonicalBlockHash: async (input) => {
      observes += 1;
      expect(input.blockRef).toEqual({ kind: 'number', number: '100' });
      return options.canonicalHash === undefined ? newHash : options.canonicalHash;
    },
    publish: async (event) => { events.push(event); },
    ownerToken: () => 'owner',
  });
  return { reconciler, transitions, events, get current() { return current; }, get observes() { return observes; } };
}

describe('ReorgReconciler', () => {
  it('when the canonical hash changes, roll back included→pending with CAS and publish chain.reorg', async () => {
    const h = harness();
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(1);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0]).toMatchObject({
      expectedStatus: 'included',
      expectedVersion: '4',
      toStatus: 'pending',
      reason: 'reorg',
      patch: { blockRef: null, canonicalBlockHash: null },
    });
    expect(h.current.status).toBe('pending');
    expect(h.current.blockRef).toBeUndefined();
    expect(h.current.canonicalBlockHash).toBeUndefined();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'chain.reorg',
      chain,
      payload: {
        oldBlockRef: { kind: 'hash', hash: record.canonicalBlockHash },
        newBlockRef: { kind: 'hash', hash: newHash },
        affectedTransactions: [record.txHash],
      },
    });
  });

  it('when the canonical hash agrees, change no state and emit no event', async () => {
    const h = harness({ canonicalHash: record.canonicalBlockHash! });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('when the canonical block is temporarily unreadable, keep the state and retry later', async () => {
    const h = harness({ canonicalHash: null });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.current.status).toBe('included');
    expect(h.events).toHaveLength(0);
  });

  it('when another owner holds the tracker lease, do not query blocks, migrate, or emit events', async () => {
    const h = harness({ held: true });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.observes).toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('with no historical canonical hash, do not guess, query the chain, or roll back', async () => {
    const { canonicalBlockHash: omittedAnchor, ...withoutAnchor } = record;
    void omittedAnchor;
    const h = harness({ current: withoutAnchor });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.observes).toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('stop immediately after losing the renewal lease; do not observe or write', async () => {
    const h = harness({ leaseLost: true });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.observes).toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('on a state CAS conflict, discard the stale observation and emit no reorg event', async () => {
    const h = harness({ casConflict: true });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.transitions).toHaveLength(1);
    expect(h.events).toHaveLength(0);
  });

  it('do not scan confirmed or finalized records', async () => {
    const h = harness({ current: { ...record, status: 'finalized' } });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.observes).toBe(0);
    expect(h.transitions).toHaveLength(0);
  });
});
