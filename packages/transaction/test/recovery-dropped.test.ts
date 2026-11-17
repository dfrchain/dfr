/**
 * `dropped` 有界观测与收敛（ADR-023）。
 *
 * `RecoveryCoordinator.reconcileDropped` 负责在有界宽限窗内继续观测 `dropped` 记录，
 * 以便纠正误判。本文件锁定：
 *   1. 窗口内的 dropped 会被观测，且能从 dropped 收敛到 included；
 *   2. 窗口外的 dropped **不进入扫描**（否则重新制造"扫描集合只增不减、白跑 RPC"）；
 *   3. `absent` 观测不改变 dropped（不重复写状态）。
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
      // 真实实现由 Engine 完成观测；这里用注入端口模拟"观测到 included"。
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

describe('dropped 有界观测与收敛（ADR-023）', () => {
  it('窗口内的 dropped 会被观测，并能收敛到 included', async () => {
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

  it('窗口外的 dropped 不进入扫描（避免扫描集合只增不减）', async () => {
    const stores = createInMemoryTransactionStores();
    // updatedAt = 10 小时前，宽限窗为 6 小时 → 应被查询条件排除。
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

  it('观测为 absent 时保持 dropped，不计入收敛数', async () => {
    const stores = createInMemoryTransactionStores();
    const { coordinator, observed } = await seedDropped(stores, new Date(T0).toISOString(), {
      kind: 'absent',
    });

    const corrected = await coordinator.reconcileDropped({ limit: 100 });

    expect(observed).toEqual([TX_ID]);
    expect(corrected).toBe(0);
    expect((await stores.transaction.get(TX_ID))?.status).toBe('dropped');
  });

  it('非法 limit fail-closed', async () => {
    const stores = createInMemoryTransactionStores();
    const { coordinator } = await seedDropped(stores, new Date(T0).toISOString(), {
      kind: 'absent',
    });
    await expect(coordinator.reconcileDropped({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(coordinator.reconcileDropped({ limit: 501 })).rejects.toBeInstanceOf(RangeError);
  });
});
