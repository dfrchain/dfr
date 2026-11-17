//
// M1-D 故障注入验收（DFR-M1-D07）。
//
// 权威来源：docs/development/m1-taskbook.md D07 卡；ADR-019/020/021；m1-storage-model。
//
// 为什么单独成文件：各故障点的**组件级**行为已由单测覆盖（tracker/recovery/reorg/
// provider/confirm）。D07 要证明的是这些组件在真实 PostgreSQL 上**组合**后仍然正确，
// 因此这里用真 Store + 真实并发连接，只在最外层替换链 RPC。
//
// 五个场景：进程重启、Provider 切换、lease 丢失、短重组、确认超时。
// 需要 `DFR_TRANSACTION_DATABASE_URL`，只在 `pnpm test:db` 中运行。
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

describe.skipIf(!ENABLED)('M1-D 故障注入验收（DFR-M1-D07）', () => {
  it('进程重启：关闭并重建 Pool 后，非终态交易可被恢复扫描重新发现，且状态不被破坏', async () => {
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

    // 另造一条广播结果不确定的 unknown 记录：它才属于恢复扫描的处理对象。
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

    // 模拟进程退出：先关引擎后台循环，再关闭整个 Pool。
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
    // 恢复扫描必须能安全跑完（不抛出），并解析重启前留下的 unknown 记录。
    const recovered = await coordinator.run({ limit: 100 });
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(resolved).toContain(unknownId);

    // built 交易跨重启持久且状态不被恢复扫描误改；但 built 不是"可恢复状态"（设计如此）。
    const after = await restarted.stores.transaction.get(built.transactionId);
    expect(after?.status).toBe('built');
    const recoverable = await restarted.stores.transaction.listRecoverable({ limit: 500 });
    expect(recoverable.map((record) => record.transactionId)).toContain(unknownId);
    expect(recoverable.map((record) => record.transactionId)).not.toContain(built.transactionId);
  });

  it('lease 丢失：有效租约期内第二 owner 不得接管，释放后可接管', async () => {
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

  it('短重组：canonical hash 变化时把 included 回退到 pending 并清空锚点，hash 不变时不动', async () => {
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

    // 负对照：canonical hash 未变 → 不回退。
    await reconcile(anchoredHash).run({ limit: 100 });
    expect((await runtime.stores.transaction.get(transactionId))?.status).toBe('included');
    expect(published).toHaveLength(0);
    expect(metrics.renderPrometheus()).not.toContain('dfr_transaction_reorg_total');

    // 正例：canonical hash 变化 → included → pending 并清空锚点。
    await reconcile(`0x${'c'.repeat(64)}`).run({ limit: 100 });
    const rolledBack = await runtime.stores.transaction.get(transactionId);
    expect(rolledBack?.status).toBe('pending');
    expect(rolledBack?.canonicalBlockHash).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(metrics.renderPrometheus()).toContain('dfr_transaction_reorg_total');
  });

  it('确认超时：等待上限内未达目标 finality 时返回 reached=false，且不改写记录', async () => {
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
      // 时钟每次前进一大步，让等待循环在第一次观测后立刻到达 deadline（不真正 sleep）。
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

  it('Provider 切换：主 Provider 5xx 时切到备用并返回结果，调用方无感知', async () => {
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
      // 固定加权选择：否则可能先选中备用 Provider，主 Provider 从未被调用，
      // "故障切换"就退化成"直接成功"（该用例曾因此约 25% 概率失败）。
      random: () => 0,
      // 主 Provider 全部 5xx，备用返回余额。
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
    // 主 Provider 先被尝试并失败，随后切到备用 —— 这是"切换"而非"从未调用主"。
    expect(calledProviders).toContain('sepolia-primary');
    expect(calledProviders).toContain('sepolia-secondary');
  });
});
