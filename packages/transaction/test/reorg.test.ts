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
  it('canonical hash 改变时以 CAS 回退 included→pending 并发布 chain.reorg', async () => {
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

  it('canonical hash 一致时不改状态也不发事件', async () => {
    const h = harness({ canonicalHash: record.canonicalBlockHash! });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('canonical 区块暂时不可读时保持状态，稍后重试', async () => {
    const h = harness({ canonicalHash: null });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.current.status).toBe('included');
    expect(h.events).toHaveLength(0);
  });

  it('其他 owner 持有 tracker lease 时不查区块、不迁移、不发事件', async () => {
    const h = harness({ held: true });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.observes).toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('缺少历史 canonical hash 时不猜测、不查链、不回退', async () => {
    const { canonicalBlockHash: omittedAnchor, ...withoutAnchor } = record;
    void omittedAnchor;
    const h = harness({ current: withoutAnchor });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.observes).toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('续租丢失后立即停止，不观测或写入', async () => {
    const h = harness({ leaseLost: true });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.observes).toBe(0);
    expect(h.transitions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it('状态 CAS 冲突时丢弃旧观测，不发重组事件', async () => {
    const h = harness({ casConflict: true });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.transitions).toHaveLength(1);
    expect(h.events).toHaveLength(0);
  });

  it('不扫描 confirmed 或 finalized 记录', async () => {
    const h = harness({ current: { ...record, status: 'finalized' } });
    await expect(h.reconciler.run({ limit: 10 })).resolves.toBe(0);
    expect(h.observes).toBe(0);
    expect(h.transitions).toHaveLength(0);
  });
});
