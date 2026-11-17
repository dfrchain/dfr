// D04 常驻重组巡检的 composition root 接线测试（关闭 D04/D05/D07 遗留运行时缺口）。
//
// 为什么必须用真实 startGateway：调度器是否被装配、是否被 close() 停掉，只有
// 真实 composition root 才能证明。组件级行为由 packages/transaction/test/reorg-scheduler.test.ts
// 与 reorg.test.ts 覆盖；这里只证明"生产入口真的把它跑起来了"。
import { describe, expect, it, vi } from 'vitest';
import type { TransactionStores } from '@dfr/core';
import { hashSecret } from '../src/index.js';
import { GatewayStartupError, startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'ReorgKey';
const SECRET = 'reorgSweepWiringSecret0123456789ab';
const PEPPER = 'reorg-sweep-pepper';

const BASE_ENV = {
  DFR_M0_API_KEY_ID: KEY_ID,
  DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
  DFR_M0_API_KEY_PEPPER: PEPPER,
  DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
  DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
  DFR_GATEWAY_PORT: '0',
  DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://stub.local/sepolia-primary',
  DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://stub.local/sepolia-secondary',
};

/** 记录 listRecoverable 调用次数：巡检唯一会触达的 Store 方法（statuses=['included']）。 */
function countingPersistence() {
  // 显式标注入参类型，测试才能断言传给 Store 的 limit。
  const listRecoverable = vi.fn(async (_input: { limit: number; statuses?: readonly string[] }) => [] as never[]);
  const persistence: GatewayPersistence = {
    stores: {
      transaction: { listRecoverable } as unknown as TransactionStores['transaction'],
      idempotency: { pruneExpired: async () => 0 } as unknown as TransactionStores['idempotency'],
      nonce: { releaseExpiredOrphaned: async () => 0 } as unknown as TransactionStores['nonce'],
      tracker: {
        acquire: async () => ({ kind: 'held_by_other' }),
        release: async () => ({ kind: 'released' }),
      } as unknown as TransactionStores['tracker'],
    },
    healthCheck: async () => undefined,
    close: vi.fn(async () => undefined),
  };
  return { persistence, listRecoverable };
}

async function withGateway(
  env: NodeJS.ProcessEnv,
  persistence: GatewayPersistence,
  body: (app: Awaited<ReturnType<typeof startGateway>>) => Promise<void>,
): Promise<void> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const app = await startGateway(env, async () => persistence);
  try {
    await body(app);
  } finally {
    await app.close();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('D04 常驻重组巡检接线（关闭发布阻塞缺口）', () => {
  it('M1 启动后按配置间隔周期性驱动 ReorgReconciler', async () => {
    const { persistence, listRecoverable } = countingPersistence();
    await withGateway(
      { ...BASE_ENV, DFR_REORG_SWEEP_INTERVAL_MS: '1000', DFR_REORG_SWEEP_BATCH: '50' },
      persistence,
      async () => {
        // 启动阶段的 RecoveryCoordinator 也会调 listRecoverable；先记基线。
        const baseline = listRecoverable.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 1_400));
        expect(listRecoverable.mock.calls.length).toBeGreaterThan(baseline);
        // 批次上限必须来自环境变量，而不是硬编码默认值。
        const sweep = listRecoverable.mock.calls.at(-1)?.[0];
        expect(sweep?.limit).toBe(50);
      },
    );
  }, 15_000);

  it('close() 会停掉巡检：关闭后不再有新的 listRecoverable 调用', async () => {
    const { persistence, listRecoverable } = countingPersistence();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const app = await startGateway(
        { ...BASE_ENV, DFR_REORG_SWEEP_INTERVAL_MS: '1000' },
        async () => persistence,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await app.close();
      const afterClose = listRecoverable.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      expect(listRecoverable.mock.calls.length).toBe(afterClose);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 15_000);

  it('非法巡检间隔 / 批次上限 fail-closed，不静默回落到默认值', async () => {
    const { persistence } = countingPersistence();
    await expect(
      startGateway({ ...BASE_ENV, DFR_REORG_SWEEP_INTERVAL_MS: 'abc' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
    await expect(
      startGateway({ ...BASE_ENV, DFR_REORG_SWEEP_INTERVAL_MS: '10' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
    await expect(
      startGateway({ ...BASE_ENV, DFR_REORG_SWEEP_BATCH: '501' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
  }, 15_000);
});
