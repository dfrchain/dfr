/**
 * M1 真实持久化：Solana `signed` 滞留记录的运维对账通道（issue #22 门禁 4，ADR-040）。
 *
 * 与 `packages/transaction/test/recovery.test.ts`（内存替身单测）的区别：这里用
 * **真实 PostgreSQL Store** 装配 `RecoveryCoordinator`，验证运维通道在真实
 * CAS / tracker 租约 / 排序租约语义下成立：
 *
 *   - 陈旧的 Solana `signed` 记录可被人工点名迁移到 `unknown`；
 *   - 新鲜的同种记录被拒绝（`not_stale`），状态不变；
 *   - EVM 记录不归本通道（`not_applicable`），且既有 `recoverStaleSigned`
 *     巡检在真实 PG 上行为不变；
 *   - 通道没有任何广播路径：`RecoveryCoordinator` 的依赖里根本不存在链端口，
 *     迁移后记录 `txHash` 仍为空、状态只到 `unknown`，唯一的外部效应是
 *     只读解析回调（本测试以记录型替身承接并断言其调用）。
 *
 * 需要 `DFR_TRANSACTION_DATABASE_URL`，因此只在 `pnpm test:db` 下运行。
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

/** 落库一笔 Solana `signed` 记录：reserve 排序租约 → create(built) → sign。 */
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

/** 落库一笔 EVM `signed` 记录（B37 同款顺序：reserve nonce → create → sign）。 */
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

describe.skipIf(!ENABLED)('M1 真实持久化：signed 滞留对账（issue #22 门禁 4 / ADR-040）', () => {
  it('陈旧 Solana signed 记录可被运维通道迁移到 unknown（真实 CAS + 租约围栏）', async () => {
    const runtime = await openRuntime();
    const { transactionId } = await seedSolanaSigned(runtime);
    const observed: TransactionId[] = [];
    const coordinator = coordinatorFor(runtime, observed);

    // 以注入时钟把记录推过陈旧窗口（updatedAt 为落库时刻，now = +10 分钟）。
    const outcome = await coordinator.reconcileStrandedSigned({
      transactionId, staleAfterMs: 300_000, now: Date.now() + 10 * 60_000,
    });
    expect(outcome).toBe('transitioned');

    const after = await runtime.stores.transaction.get(transactionId);
    expect(after?.status).toBe('unknown');
    // 只推进一格：版本 0(built) → 1(sign) → 2(unknown)，且从未经过 broadcast。
    expect(after?.stateVersion).toBe('2');
    expect(after?.txHash).toBeUndefined();
    // 唯一的外部效应是一次只读解析回调；通道不触碰排序租约（记录里的
    // sequencingRef 保持原样，租约行留给 TTL 回收——本记录属于
    // "签名后、markConsumed 前崩溃"的变体，租约仍为 reserved）。
    expect(observed).toEqual([transactionId]);
    expect(after?.sequencingRef?.kind).toBe('blockhash');
  });

  it('新鲜 Solana signed 记录被拒绝（not_stale），状态保持 signed', async () => {
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

  it('EVM 记录不归运维通道（not_applicable），且既有 recoverStaleSigned 巡检行为不变', async () => {
    const runtime = await openRuntime();
    const { transactionId } = await seedEvmSigned(runtime);
    const observed: TransactionId[] = [];
    const coordinator = coordinatorFor(runtime, observed);
    const future = Date.now() + 10 * 60_000;

    await expect(coordinator.reconcileStrandedSigned({
      transactionId, staleAfterMs: 300_000, now: future,
    })).resolves.toBe('not_applicable');
    expect((await runtime.stores.transaction.get(transactionId))?.status).toBe('signed');

    // 同一条记录随后由既有 EVM 巡检按原语义修复：signed → unknown + 只读解析。
    // 共享 runner 库里可能有其他套件留下的陈旧 EVM 记录，只断言本条被修复。
    const repaired = await coordinator.recoverStaleSigned({
      limit: 10, staleAfterMs: 300_000, now: future,
    });
    expect(repaired).toBeGreaterThanOrEqual(1);
    expect((await runtime.stores.transaction.get(transactionId))?.status).toBe('unknown');
    expect(observed).toContain(transactionId);
  });
});
