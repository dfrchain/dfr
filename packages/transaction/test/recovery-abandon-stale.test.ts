/**
 * RecoveryCoordinator.abandonStaleUnbroadcast 契约测试（ADR-037 方案 C）。
 *
 * 权威来源：`docs/adr/ADR-037-abandoned-built-transaction-reclaim.md`。
 *
 * 这是**兜底**：方案 A 的显式 abandon 只在调用方记得时有效；崩溃/中断/忘记时靠本巡检自愈。
 * 最重要的负对照：`signed` 及以上**永不**被本巡检触碰（那会回收已签名交易的 nonce）。
 */
import { describe, expect, it } from 'vitest';
import type { ChainId, Iso8601 } from '@dfr/types';
import type {
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLeaseStore,
  TransactionRecord,
  TransactionStore,
} from '../src/stores.js';
import { RecoveryCoordinator } from '../src/recovery.js';

const CHAIN = 'ethereum-sepolia' as ChainId;
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const OLD = '2026-10-07T10:00:00.000Z' as Iso8601; // 2 小时前（> 30 分钟窗口）
const FRESH = '2026-10-07T11:59:00.000Z' as Iso8601; // 1 分钟前

function record(overrides: Partial<TransactionRecord>): TransactionRecord {
  return {
    transactionId: 'txn_1',
    projectId: 'default',
    chain: CHAIN,
    requestFingerprint: 'fp',
    status: 'built',
    stateVersion: '1',
    from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
    unsignedPayload: '0x02',
    payloadEncoding: 'hex',
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  } as TransactionRecord;
}

interface Harness {
  coordinator: RecoveryCoordinator;
  transitions: Array<{ transactionId: string; toStatus: string; reason: string }>;
  releases: Array<{ nonce?: string | undefined; transactionId?: string | undefined }>;
}

function harness(
  records: readonly TransactionRecord[],
  options: { abandonBuiltAfterMs?: number } = {},
): Harness {
  const transitions: Harness['transitions'] = [];
  const releases: Harness['releases'] = [];
  const transactions = {
    listRecoverable: async (input: { statuses?: readonly string[]; updatedBefore?: string }) => {
      // 替身按"状态 + 窗口上界"过滤，模拟 SQL 的行为（而不是把全部记录都返回）。
      return records.filter((r) => {
        if (input.statuses !== undefined && !input.statuses.includes(r.status)) return false;
        if (input.updatedBefore !== undefined && r.updatedAt > input.updatedBefore) return false;
        return true;
      });
    },
    transition: async (input: { transactionId: string; toStatus: string; reason: string }) => {
      transitions.push({ transactionId: input.transactionId, toStatus: input.toStatus, reason: input.reason });
      return { kind: 'applied' as const, record: record({ status: 'abandoned' }) };
    },
  } as unknown as TransactionStore;

  const coordinator = new RecoveryCoordinator({
    transactions,
    idempotency: { pruneExpired: async () => 0 } as unknown as IdempotencyStore,
    nonce: {
      releaseExpiredOrphaned: async () => 0,
      releaseIfSafe: async (ref: { nonce: string; transactionId?: string }) => {
        releases.push({ nonce: ref.nonce, transactionId: ref.transactionId });
        return { kind: 'released' as const, lease: {} as never };
      },
    } as unknown as NonceStore,
    trackerLeases: { listRecoverable: async () => [] } as unknown as TrackerLeaseStore,
    resolveUnknown: async () => undefined,
    ownerToken: () => 'recovery-owner',
    clock: () => NOW,
    ...(options.abandonBuiltAfterMs !== undefined
      ? { abandonBuiltAfterMs: options.abandonBuiltAfterMs }
      : {}),
  });
  return { coordinator, transitions, releases };
}

describe('RecoveryCoordinator.abandonStaleUnbroadcast（ADR-037 方案 C）', () => {
  it('超窗的 built 被自动作废：先完成 abandoned CAS、再安全释放租约', async () => {
    const h = harness([record({ nonce: '20' as never })], { abandonBuiltAfterMs: 30 * 60_000 });

    const abandoned = await h.coordinator.abandonStaleUnbroadcast({ limit: 10 });

    expect(abandoned).toBe(1);
    expect(h.releases).toEqual([{ nonce: '20', transactionId: 'txn_1' }]);
    expect(h.transitions).toEqual([
      { transactionId: 'txn_1', toStatus: 'abandoned', reason: 'abandon.stale' },
    ]);
  });

  it('超窗的 simulated 同样被作废（两者都未签名）', async () => {
    const h = harness([record({ status: 'simulated', nonce: '21' as never })], {
      abandonBuiltAfterMs: 30 * 60_000,
    });
    expect(await h.coordinator.abandonStaleUnbroadcast({ limit: 10 })).toBe(1);
    expect(h.transitions[0]!.toStatus).toBe('abandoned');
  });

  it('★ 负对照：signed 及以上**永不**被本巡检触碰', async () => {
    const h = harness(
      [
        record({ transactionId: 'txn_signed' as never, status: 'signed', nonce: '30' as never }),
        record({ transactionId: 'txn_broadcast' as never, status: 'broadcast', nonce: '31' as never }),
        record({ transactionId: 'txn_included' as never, status: 'included', nonce: '32' as never }),
      ],
      { abandonBuiltAfterMs: 30 * 60_000 },
    );

    const abandoned = await h.coordinator.abandonStaleUnbroadcast({ limit: 10 });

    expect(abandoned).toBe(0);
    expect(h.transitions).toEqual([]);
    // 关键：一次租约释放都没有发生。
    expect(h.releases).toEqual([]);
  });

  it('窗口内（刚 build）的记录不被回收', async () => {
    const h = harness([record({ updatedAt: FRESH, nonce: '40' as never })], {
      abandonBuiltAfterMs: 30 * 60_000,
    });
    expect(await h.coordinator.abandonStaleUnbroadcast({ limit: 10 })).toBe(0);
    expect(h.transitions).toEqual([]);
  });

  it('未配置窗口 = 关闭本巡检（显式，而不是用某个默认值）', async () => {
    const h = harness([record({ nonce: '50' as never })]); // 不传 abandonBuiltAfterMs
    expect(await h.coordinator.abandonStaleUnbroadcast({ limit: 10 })).toBe(0);
    expect(h.transitions).toEqual([]);
  });

  it('TX-02: a concurrent sign CAS loser must NEVER release its nonce', async () => {
    const operations: string[] = [];
    const source = record({ nonce: '91' as never, stateVersion: '3' as never });
    const store = {
      listRecoverable: async () => [source],
      transition: async () => {
        operations.push('CAS:conflict:signed');
        return { kind: 'version_conflict', current: record({ status: 'signed', stateVersion: '4' as never }) };
      },
    } as unknown as TransactionStore;
    const coordinator = new RecoveryCoordinator({
      transactions: store,
      idempotency: { pruneExpired: async () => 0 } as unknown as IdempotencyStore,
      nonce: {
        releaseIfSafe: async () => {
          operations.push('release:UNSAFE');
          return { kind: 'released' };
        },
      } as unknown as NonceStore,
      trackerLeases: {} as TrackerLeaseStore,
      resolveUnknown: async () => undefined,
      ownerToken: () => 'worker',
      clock: () => NOW,
      abandonBuiltAfterMs: 30 * 60_000,
    });
    expect(await coordinator.abandonStaleUnbroadcast({ limit: 4 })).toBe(0);
    expect(operations).toEqual(['CAS:conflict:signed']);
  });

  it('TX-02: transition CAS must succeed BEFORE an EVM nonce or Solana blockhash lease is released', async () => {
    for (const kind of ['nonce', 'blockhash'] as const) {
      const operations: string[] = [];
      const base = record({
        transactionId: `txn_abandon_${kind}` as never,
        ...(kind === 'nonce'
          ? { nonce: '77' as never }
          : { sequencingRef: { kind: 'blockhash', value: 'blockhash-value', lastValidBlockHeight: '100' as never } }),
      });
      const coordinator = new RecoveryCoordinator({
        transactions: {
          listRecoverable: async () => [base],
          transition: async () => {
            operations.push('CAS:abandoned');
            return { kind: 'applied', record: record({ ...base, status: 'abandoned' }) };
          },
        } as unknown as TransactionStore,
        idempotency: {} as IdempotencyStore,
        nonce: {
          releaseIfSafe: async () => {
            operations.push('release:nonce');
            return { kind: 'released' };
          },
        } as unknown as NonceStore,
        sequencing: {
          releaseIfSafe: async () => {
            operations.push('release:blockhash');
            return { kind: 'released' };
          },
        } as unknown as SequencingStore,
        trackerLeases: {} as TrackerLeaseStore,
        resolveUnknown: async () => undefined,
        ownerToken: () => 'worker',
        clock: () => NOW,
        abandonBuiltAfterMs: 30 * 60_000,
      });
      expect(await coordinator.abandonStaleUnbroadcast({ limit: 4 })).toBe(1);
      expect(operations).toEqual(['CAS:abandoned', `release:${kind}`]);
    }
  });

  it('TX-02: a successful durable abandon counts even if lease cleanup fails', async () => {
    const base = record({ nonce: '22' as never });
    const coordinator = new RecoveryCoordinator({
      transactions: {
        listRecoverable: async () => [base],
        transition: async () => ({ kind: 'applied', record: record({ status: 'abandoned' }) }),
      } as unknown as TransactionStore,
      idempotency: {} as IdempotencyStore,
      nonce: { releaseIfSafe: async () => { throw new Error('temporary db lease cleanup outage'); } } as unknown as NonceStore,
      trackerLeases: {} as TrackerLeaseStore,
      resolveUnknown: async () => undefined,
      ownerToken: () => 'worker',
      clock: () => NOW,
      abandonBuiltAfterMs: 30 * 60_000,
    });
    expect(await coordinator.abandonStaleUnbroadcast({ limit: 4 })).toBe(1);
  });

  it.each([0, -1, 1, 59_999, Number.NaN, Number.POSITIVE_INFINITY, 604_800_001])(
    'B34: unsafe stale-abandon interval %s is rejected before scanning or lease mutation',
    async (afterMs) => {
      const h = harness([record({ nonce: '88' as never })], { abandonBuiltAfterMs: afterMs });
      await expect(h.coordinator.abandonStaleUnbroadcast({ limit: 5 })).rejects.toThrow(RangeError);
      expect(h.transitions).toEqual([]);
      expect(h.releases).toEqual([]);
    },
  );

  it('limit 越界 fail-closed', async () => {
    const h = harness([], { abandonBuiltAfterMs: 30 * 60_000 });
    await expect(h.coordinator.abandonStaleUnbroadcast({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(h.coordinator.abandonStaleUnbroadcast({ limit: 501 })).rejects.toThrow(RangeError);
  });
});
