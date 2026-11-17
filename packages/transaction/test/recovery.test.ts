import { describe, expect, it } from 'vitest';
import type { ChainId, DecimalUint, Iso8601 } from '@dfr/types';
import type {
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLease,
  TrackerLeaseStore,
  TransactionRecord,
  TransactionStore,
} from '../src/stores.js';
import { RecoveryCoordinator } from '../src/recovery.js';

const lease: TrackerLease = {
  chain: 'ethereum-sepolia' as ChainId,
  txHash: '0xexpected',
  ownerToken: 'recovery-owner',
  leaseExpiresAt: '2026-01-01T00:00:30.000Z' as Iso8601,
  heartbeatAt: '2026-01-01T00:00:00.000Z' as Iso8601,
};

function leases(overrides: Partial<TrackerLeaseStore> = {}): TrackerLeaseStore {
  return {
    acquire: async () => ({ kind: 'acquired', lease }),
    renew: async () => ({ kind: 'renewed', lease }),
    release: async () => ({ kind: 'released' }),
    listRecoverable: async () => [],
    ...overrides,
  };
}

function idempotency(pruned: number[] = []): IdempotencyStore {
  return { pruneExpired: async () => { pruned.push(1); return 0; } } as unknown as IdempotencyStore;
}

function nonce(released: number[] = []): NonceStore {
  return { releaseExpiredOrphaned: async () => { released.push(1); return 0; } } as unknown as NonceStore;
}

function sequencing(released: number[] = []): SequencingStore {
  return {
    releaseExpiredOrphaned: async () => { released.push(1); return 0; },
  } as unknown as SequencingStore;
}

describe('RecoveryCoordinator', () => {
  it('分页扫描且只在获得租约后解析 unknown，不触发广播', async () => {
    const records = [
      { transactionId: 'txn_1', chain: 'ethereum-sepolia', status: 'unknown', expectedHash: '0xexpected' },
      { transactionId: 'txn_2', status: 'pending' },
    ] as TransactionRecord[];
    const seen: string[] = [];
    const operations: string[] = [];
    const store = {
      listRecoverable: async ({ afterTransactionId }: { afterTransactionId?: string }) =>
        afterTransactionId === undefined ? records : [],
    } as Pick<TransactionStore, 'listRecoverable'>;
    const coordinator = new RecoveryCoordinator({
      transactions: store as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases({
        acquire: async (input) => { operations.push(`acquire:${input.txHash}`); return { kind: 'acquired', lease }; },
        release: async (input) => { operations.push(`release:${input.txHash}`); return { kind: 'released' }; },
      }),
      resolveUnknown: async (id) => { seen.push(id); },
      ownerToken: () => 'recovery-owner',
    });
    await expect(coordinator.run({ limit: 2 })).resolves.toBe(1);
    expect(seen).toEqual(['txn_1']);
    expect(operations).toEqual(['acquire:0xexpected', 'release:0xexpected']);
  });

  it('TX-02: stale signed EVM record is durably marked unknown before read-only observation', async () => {
    const record = {
      transactionId: 'txn_signed_crash',
      chain: 'ethereum-sepolia',
      status: 'signed',
      nonce: '8',
      expectedHash: '0xsignedhash',
      stateVersion: '1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as TransactionRecord;
    const calls: string[] = [];
    const store = {
      listRecoverable: async () => [record],
      get: async () => record,
      transition: async (input: { toStatus: string; reason: string }) => {
        calls.push('transition:' + input.toStatus + ':' + input.reason);
        return { kind: 'applied', record: { ...record, status: 'unknown' } };
      },
    } as unknown as TransactionStore;
    const coordinator = new RecoveryCoordinator({
      transactions: store,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases({
        acquire: async () => { calls.push('lease-acquired'); return { kind: 'acquired', lease }; },
        release: async () => { calls.push('lease-released'); return { kind: 'released' }; },
      }),
      resolveUnknown: async () => { calls.push('observe-only'); },
      ownerToken: () => 'recovery-owner',
    });
    const fixedNow = Date.parse('2026-01-01T00:10:00.000Z');
    await expect(coordinator.recoverStaleSigned({
      limit: 5, staleAfterMs: 300_000, now: fixedNow,
    })).resolves.toBe(1);
    expect(calls).toEqual([
      'lease-acquired', 'transition:unknown:broadcast.indeterminate',
      'observe-only', 'lease-released',
    ]);
  });

  it('TX-02: never recover fresh signed, missing-hash or Solana sequencing records', async () => {
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    const cases: TransactionRecord[] = [
      { transactionId: 'fresh', status: 'signed', chain: 'ethereum-sepolia',
        nonce: '2', expectedHash: '0xhash', updatedAt: '2026-01-01T00:09:00.000Z' },
      { transactionId: 'no-hash', status: 'signed', chain: 'ethereum-sepolia',
        nonce: '3', updatedAt: '2026-01-01T00:00:00.000Z' },
      { transactionId: 'solana', status: 'signed', chain: 'solana-devnet',
        expectedHash: '0xhash', updatedAt: '2026-01-01T00:00:00.000Z' },
    ] as TransactionRecord[];
    let transitions = 0;
    let acquisitions = 0;
    const coordinator = new RecoveryCoordinator({
      transactions: {
        listRecoverable: async () => cases,
        get: async (id: string) => cases.find((x) => x.transactionId === id) ?? null,
        transition: async () => { transitions++; return { kind: 'not_found' }; },
      } as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases({ acquire: async () => { acquisitions++; return { kind: 'acquired', lease }; } }),
      resolveUnknown: async () => { throw new Error('must not observe'); },
      ownerToken: () => 'recovery-owner',
    });
    expect(await coordinator.recoverStaleSigned({ limit: 5, staleAfterMs: 300_000, now })).toBe(0);
    expect(acquisitions).toBe(1); // fresh record is rechecked against real time under lease.
    expect(transitions).toBe(0);
  });

  it('TX-02: concurrent successful broadcast CAS prevents a stale signed recovery rewrite', async () => {
    const record = {
      transactionId: 'txn_racing',
      chain: 'ethereum-sepolia',
      status: 'signed',
      nonce: '2',
      expectedHash: '0xhash',
      stateVersion: '1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as TransactionRecord;
    let observed = 0;
    const coordinator = new RecoveryCoordinator({
      transactions: {
        listRecoverable: async () => [record],
        get: async () => record,
        transition: async () => ({ kind: 'version_conflict', current: {
          ...record, status: 'broadcast', stateVersion: '2',
        } }),
      } as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases(),
      resolveUnknown: async () => { observed++; },
      ownerToken: () => 'recovery-owner',
    });
    expect(await coordinator.recoverStaleSigned({
      limit: 5, staleAfterMs: 60_000, now: Date.parse('2026-01-01T00:10:00.000Z'),
    })).toBe(0);
    expect(observed).toBe(0);
  });

  it('有效租约被其他 owner 持有时跳过，不并发解析', async () => {
    const record = {
      transactionId: 'txn_1', chain: 'ethereum-sepolia', status: 'unknown', expectedHash: '0xexpected',
    } as TransactionRecord;
    let resolved = 0;
    const coordinator = new RecoveryCoordinator({
      transactions: { listRecoverable: async () => [record] } as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases({ acquire: async () => ({ kind: 'held_by_other', lease }) }),
      resolveUnknown: async () => { resolved += 1; },
      ownerToken: () => 'recovery-owner',
    });
    await expect(coordinator.run({ limit: 2 })).resolves.toBe(0);
    expect(resolved).toBe(0);
  });

  it('没有可验证 hash 的 unknown 保持原状，不调用链解析', async () => {
    const record = { transactionId: 'txn_1', chain: 'ethereum-sepolia', status: 'unknown' } as TransactionRecord;
    let acquired = 0;
    let resolved = 0;
    const coordinator = new RecoveryCoordinator({
      transactions: { listRecoverable: async () => [record] } as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases({ acquire: async () => { acquired += 1; return { kind: 'acquired', lease }; } }),
      resolveUnknown: async () => { resolved += 1; },
      ownerToken: () => 'recovery-owner',
    });
    await expect(coordinator.run({ limit: 2 })).resolves.toBe(0);
    expect(acquired).toBe(0);
    expect(resolved).toBe(0);
  });

  it('启动前以相同批量上限清理过期幂等和孤儿 nonce 租约', async () => {
    const pruned: number[] = [];
    const released: number[] = [];
    const coordinator = new RecoveryCoordinator({
      transactions: { listRecoverable: async () => [] } as unknown as TransactionStore,
      idempotency: idempotency(pruned),
      nonce: nonce(released),
      trackerLeases: leases(),
      resolveUnknown: async () => undefined,
      ownerToken: () => 'recovery-owner',
    });
    await expect(coordinator.run({ limit: 17 })).resolves.toBe(0);
    expect(pruned).toHaveLength(1);
    expect(released).toHaveLength(1);
  });

  it('装配 sequencing 时同样以相同批量上限回收过期 blockhash 租约（M3-A01 遗留）', async () => {
    const seqReleased: number[] = [];
    const coordinator = new RecoveryCoordinator({
      transactions: { listRecoverable: async () => [] } as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      sequencing: sequencing(seqReleased),
      trackerLeases: leases(),
      resolveUnknown: async () => undefined,
      ownerToken: () => 'recovery-owner',
    });
    await expect(coordinator.run({ limit: 17 })).resolves.toBe(0);
    expect(seqReleased).toHaveLength(1);
  });

  it.each(['acquire', 'resolve', 'release'] as const)(
    'TX-60: %s failure on one unknown transaction does not abort subsequent pages',
    async (failure) => {
      const records = ['txn_bad', 'txn_good', 'txn_later'].map((transactionId) => ({
        transactionId, chain: 'ethereum-sepolia', status: 'unknown', expectedHash: '0x' + transactionId,
      })) as TransactionRecord[];
      const seen: string[] = [];
      const paged = {
        listRecoverable: async ({ afterTransactionId }: { afterTransactionId?: string }) =>
          afterTransactionId === undefined ? records.slice(0, 2) :
          afterTransactionId === 'txn_good' ? records.slice(2) : [],
      } as unknown as TransactionStore;
      const coordinator = new RecoveryCoordinator({
        transactions: paged,
        idempotency: idempotency(),
        nonce: nonce(),
        trackerLeases: leases({
          acquire: async ({ txHash }) => {
            if (failure === 'acquire' && txHash === '0xtxn_bad') throw new Error('RPC lease store temporary error');
            return { kind: 'acquired', lease };
          },
          release: async ({ txHash }) => {
            if (failure === 'release' && txHash === '0xtxn_bad') throw new Error('RPC lease release error');
            return { kind: 'released' };
          },
        }),
        resolveUnknown: async (id) => {
          seen.push(id);
          if (failure === 'resolve' && id === 'txn_bad') throw new Error('provider RPC timeout');
        },
        ownerToken: () => 'recovery-owner',
      });
      await expect(coordinator.run({ limit: 2 })).resolves.toBe(2);
      expect(seen).toContain('txn_good');
      expect(seen).toContain('txn_later');
    },
  );

  it.each(['acquire', 'resolve', 'release'] as const)(
    'TX-60: %s failure on one dropped transaction preserves later correction and pagination',
    async (failure) => {
      const records = ['txn_bad', 'txn_good', 'txn_later'].map((transactionId) => ({
        transactionId, chain: 'ethereum-sepolia', status: 'dropped', expectedHash: '0x' + transactionId,
      })) as TransactionRecord[];
      const observed: string[] = [];
      const coordinator = new RecoveryCoordinator({
        transactions: {
          listRecoverable: async ({ afterTransactionId }: { afterTransactionId?: string }) =>
            afterTransactionId === undefined ? records.slice(0, 2) :
            afterTransactionId === 'txn_good' ? records.slice(2) : [],
          get: async (id: string) => id === 'txn_bad'
            ? records[0]! : { ...records.find((record) => record.transactionId === id), status: 'included' },
        } as unknown as TransactionStore,
        idempotency: idempotency(),
        nonce: nonce(),
        trackerLeases: leases({
          acquire: async ({ txHash }) => {
            if (failure === 'acquire' && txHash === '0xtxn_bad') throw new Error('lease acquisition unavailable');
            return { kind: 'acquired', lease };
          },
          release: async ({ txHash }) => {
            if (failure === 'release' && txHash === '0xtxn_bad') throw new Error('lease release unavailable');
            return { kind: 'released' };
          },
        }),
        resolveUnknown: async (id) => {
          observed.push(id);
          if (failure === 'resolve' && id === 'txn_bad') throw new Error('chain observation unavailable');
        },
        ownerToken: () => 'recovery-owner',
      });
      await expect(coordinator.reconcileDropped({ limit: 2 })).resolves.toBe(2);
      expect(observed).toContain('txn_good');
      expect(observed).toContain('txn_later');
    },
  );

  it('TX-60: global database pagination failure remains visible to caller', async () => {
    const databaseError = new Error('transaction store unavailable');
    const coordinator = new RecoveryCoordinator({
      transactions: {
        listRecoverable: async () => { throw databaseError; },
      } as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases(),
      resolveUnknown: async () => undefined,
      ownerToken: () => 'recovery-owner',
    });
    await expect(coordinator.run({ limit: 2 })).rejects.toBe(databaseError);
    await expect(coordinator.reconcileDropped({ limit: 2 })).rejects.toBe(databaseError);
  });

  it('未装配 sequencing 时不报错（EVM-only 部署）', async () => {
    const coordinator = new RecoveryCoordinator({
      transactions: { listRecoverable: async () => [] } as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases(),
      resolveUnknown: async () => undefined,
      ownerToken: () => 'recovery-owner',
    });
    await expect(coordinator.run({ limit: 5 })).resolves.toBe(0);
  });
});

describe('RecoveryCoordinator.reconcileStrandedSigned（ADR-040 运维通道）', () => {
  const NOW = Date.parse('2026-01-01T00:10:00.000Z');

  function solanaSigned(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
    return {
      transactionId: 'txn_solana_stranded',
      chain: 'solana-devnet',
      status: 'signed',
      expectedHash: 'So1anaSignature',
      sequencingRef: { kind: 'blockhash', value: 'BlockhashValue', lastValidBlockHeight: '1000' },
      stateVersion: '3',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    } as TransactionRecord;
  }

  function harness(
    store: Partial<TransactionStore>,
    extra: {
      acquire?: TrackerLeaseStore['acquire'];
      resolveUnknown?: (id: string) => Promise<void>;
    } = {},
  ) {
    const calls: string[] = [];
    const coordinator = new RecoveryCoordinator({
      transactions: store as unknown as TransactionStore,
      idempotency: idempotency(),
      nonce: nonce(),
      trackerLeases: leases({
        acquire: extra.acquire ?? (async () => {
          calls.push('acquire');
          return { kind: 'acquired', lease };
        }),
        release: async () => {
          calls.push('release');
          return { kind: 'released' };
        },
      }),
      resolveUnknown: extra.resolveUnknown ?? (async () => {
        calls.push('observe');
      }),
      ownerToken: () => 'recovery-owner',
    });
    return { coordinator, calls };
  }

  it('陈旧 Solana signed 经租约围栏 + CAS 进入 unknown，并做一次只读观测', async () => {
    const record = solanaSigned();
    const transitions: Record<string, unknown>[] = [];
    const { coordinator, calls } = harness({
      get: async () => record,
      transition: async (input) => {
        transitions.push(input as unknown as Record<string, unknown>);
        calls.push('transition');
        return { kind: 'applied', record: { ...record, status: 'unknown' } };
      },
    });
    await expect(coordinator.reconcileStrandedSigned({
      transactionId: record.transactionId, staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('transitioned');
    // 顺序即安全语义：先围栏、再 CAS、再只读观测、最后释放租约。没有广播入口。
    expect(calls).toEqual(['acquire', 'transition', 'observe', 'release']);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      transactionId: 'txn_solana_stranded',
      expectedStatus: 'signed',
      expectedVersion: '3',
      toStatus: 'unknown',
      reason: 'broadcast.indeterminate',
    });
  });

  it('新鲜的 Solana signed 拒绝迁移（not_stale），不取租约不写状态', async () => {
    const record = solanaSigned({ updatedAt: '2026-01-01T00:09:30.000Z' as Iso8601 });
    let transitions = 0;
    const { coordinator, calls } = harness({
      get: async () => record,
      transition: async () => {
        transitions += 1;
        return { kind: 'not_found' };
      },
    });
    await expect(coordinator.reconcileStrandedSigned({
      transactionId: record.transactionId, staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('not_stale');
    expect(calls).toEqual([]);
    expect(transitions).toBe(0);
  });

  it('带 nonce 的 EVM 记录归巡检所有，本通道拒绝代劳（not_applicable）', async () => {
    const record = solanaSigned({
      chain: 'ethereum-sepolia' as ChainId,
      nonce: '8' as DecimalUint,
      sequencingRef: { kind: 'nonce', value: '8' as DecimalUint },
    });
    const { coordinator, calls } = harness({ get: async () => record });
    await expect(coordinator.reconcileStrandedSigned({
      transactionId: record.transactionId, staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('not_applicable');
    expect(calls).toEqual([]);
  });

  it('缺 expectedHash 或缺 sequencingRef 的记录不可验证，绝不转换（unverifiable）', async () => {
    const noHash = {
      transactionId: 'txn_solana_nohash',
      chain: 'solana-devnet',
      status: 'signed',
      sequencingRef: { kind: 'blockhash', value: 'BlockhashValue', lastValidBlockHeight: '1000' },
      stateVersion: '3',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as TransactionRecord;
    const noRef = {
      transactionId: 'txn_solana_noref',
      chain: 'solana-devnet',
      status: 'signed',
      expectedHash: 'So1anaSignature',
      stateVersion: '3',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as TransactionRecord;
    for (const record of [noHash, noRef]) {
      const { coordinator, calls } = harness({ get: async () => record });
      await expect(coordinator.reconcileStrandedSigned({
        transactionId: record.transactionId, staleAfterMs: 300_000, now: NOW,
      })).resolves.toBe('unverifiable');
      expect(calls).toEqual([]);
    }
  });

  it('记录不存在返回 not_found；不在 signed 返回 not_signed', async () => {
    const missing = harness({ get: async () => null });
    await expect(missing.coordinator.reconcileStrandedSigned({
      transactionId: 'txn_missing' as TransactionRecord['transactionId'],
      staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('not_found');

    const advanced = harness({ get: async () => solanaSigned({ status: 'broadcast' }) });
    await expect(advanced.coordinator.reconcileStrandedSigned({
      transactionId: 'txn_solana_stranded' as TransactionRecord['transactionId'],
      staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('not_signed');
  });

  it('tracker 租约被他人持有时返回 lease_held，不写状态', async () => {
    const record = solanaSigned();
    let transitions = 0;
    const { coordinator } = harness(
      {
        get: async () => record,
        transition: async () => {
          transitions += 1;
          return { kind: 'not_found' };
        },
      },
      { acquire: async () => ({ kind: 'held_by_other', lease }) },
    );
    await expect(coordinator.reconcileStrandedSigned({
      transactionId: record.transactionId, staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('lease_held');
    expect(transitions).toBe(0);
  });

  it('CAS 冲突返回 conflict：不观测、仍释放租约', async () => {
    const record = solanaSigned();
    const { coordinator, calls } = harness({
      get: async () => record,
      transition: async () => ({
        kind: 'version_conflict' as const,
        current: { ...record, status: 'broadcast' as const, stateVersion: '4' as DecimalUint },
      }),
    });
    await expect(coordinator.reconcileStrandedSigned({
      transactionId: record.transactionId, staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('conflict');
    expect(calls).toEqual(['acquire', 'release']);
  });

  it('租约内复查发现记录已被并发推进时返回 conflict，不写状态', async () => {
    const record = solanaSigned();
    let gets = 0;
    let transitions = 0;
    const { coordinator } = harness({
      get: async () => {
        gets += 1;
        return gets === 1 ? record : { ...record, status: 'broadcast' };
      },
      transition: async () => {
        transitions += 1;
        return { kind: 'not_found' };
      },
    });
    await expect(coordinator.reconcileStrandedSigned({
      transactionId: record.transactionId, staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('conflict');
    expect(transitions).toBe(0);
  });

  it('只读观测失败不撤销已落库的迁移（transitioned），租约仍释放', async () => {
    const record = solanaSigned();
    const { coordinator, calls } = harness(
      {
        get: async () => record,
        transition: async () => ({ kind: 'applied', record: { ...record, status: 'unknown' } }),
      },
      {
        resolveUnknown: async () => {
          calls.push('observe');
          throw new Error('RPC unavailable');
        },
      },
    );
    await expect(coordinator.reconcileStrandedSigned({
      transactionId: record.transactionId, staleAfterMs: 300_000, now: NOW,
    })).resolves.toBe('transitioned');
    expect(calls).toEqual(['acquire', 'observe', 'release']);
  });

  it('staleAfterMs 低于 60 秒下限直接抛 RangeError（与巡检同口径）', async () => {
    const { coordinator } = harness({ get: async () => solanaSigned() });
    await expect(coordinator.reconcileStrandedSigned({
      transactionId: 'txn_solana_stranded' as TransactionRecord['transactionId'],
      staleAfterMs: 59_999, now: NOW,
    })).rejects.toBeInstanceOf(RangeError);
  });
});
