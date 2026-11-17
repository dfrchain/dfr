// D03 恢复巡检的 composition root 接线测试（关闭 TODO-009 记录的残余缺口）。
//
// 缺口：`RecoveryCoordinator`（过期幂等清理 / 孤儿 nonce 租约回收 / unknown 解析）
// 此前只在**启动**时跑一轮，长期不重启的实例永远不会再回收它们。
//
// 本测试用真实 `startGateway` 证明三件事：
//   1. 启动时先跑一轮恢复（且发生在监听端口之前）；
//   2. 之后按 `DFR_RECOVERY_SWEEP_INTERVAL_MS` 周期运行；
//   3. `close()` 后停止，不再触达 Store。
// 组件级行为由 packages/transaction/test/recovery-scheduler.test.ts 与 recovery.test.ts 覆盖。
import { describe, expect, it, vi } from 'vitest';
import type { TransactionStores } from '@dfr/core';
import { hashSecret } from '../src/index.js';
import { GatewayStartupError, startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'RecovKey';
const SECRET = 'recoverySweepWiringSecret01234567ab';
const PEPPER = 'recovery-sweep-pepper';

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

/** 记录 pruneExpired 的 limit：恢复每轮唯一必调的方法。 */
function countingPersistence() {
  const pruneExpired = vi.fn(async (_input: { limit: number }) => 0);
  const persistence: GatewayPersistence = {
    stores: {
      transaction: { listRecoverable: async () => [] as never[] } as unknown as TransactionStores['transaction'],
      idempotency: { pruneExpired } as unknown as TransactionStores['idempotency'],
      nonce: { releaseExpiredOrphaned: async () => 0 } as unknown as TransactionStores['nonce'],
      tracker: {
        acquire: async () => ({ kind: 'held_by_other' }),
        release: async () => ({ kind: 'released' }),
      } as unknown as TransactionStores['tracker'],
    },
    healthCheck: async () => undefined,
    close: vi.fn(async () => undefined),
  };
  return { persistence, pruneExpired };
}

function silenceStdio() {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return () => {
    stdout.mockRestore();
    stderr.mockRestore();
  };
}

describe('D03 恢复巡检接线（关闭 TODO-009 残余缺口）', () => {
  it('启动时先跑一轮恢复（监听端口之前），并遵守 DFR_RECOVERY_BATCH_SIZE', async () => {
    const { persistence, pruneExpired } = countingPersistence();
    const restore = silenceStdio();
    try {
      const app = await startGateway(
        { ...BASE_ENV, DFR_RECOVERY_BATCH_SIZE: '37' },
        async () => persistence,
      );
      // startGateway resolve 时已经监听过：启动轮必须已经跑过。
      expect(pruneExpired).toHaveBeenCalledTimes(1);
      expect(pruneExpired.mock.calls[0]?.[0].limit).toBe(37);
      await app.close();
    } finally {
      restore();
    }
  }, 15_000);

  it('按 DFR_RECOVERY_SWEEP_INTERVAL_MS 周期运行', async () => {
    const { persistence, pruneExpired } = countingPersistence();
    const restore = silenceStdio();
    try {
      const app = await startGateway(
        { ...BASE_ENV, DFR_RECOVERY_SWEEP_INTERVAL_MS: '1000' },
        async () => persistence,
      );
      const baseline = pruneExpired.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      expect(pruneExpired.mock.calls.length).toBeGreaterThan(baseline);
      await app.close();
    } finally {
      restore();
    }
  }, 15_000);

  it('close() 停掉恢复巡检：之后不再触达 Store', async () => {
    const { persistence, pruneExpired } = countingPersistence();
    const restore = silenceStdio();
    try {
      const app = await startGateway(
        { ...BASE_ENV, DFR_RECOVERY_SWEEP_INTERVAL_MS: '1000' },
        async () => persistence,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await app.close();
      const afterClose = pruneExpired.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      expect(pruneExpired.mock.calls.length).toBe(afterClose);
    } finally {
      restore();
    }
  }, 15_000);

  it('非法恢复巡检间隔 / 批次上限 fail-closed', async () => {
    const { persistence } = countingPersistence();
    await expect(
      startGateway({ ...BASE_ENV, DFR_RECOVERY_SWEEP_INTERVAL_MS: '10' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
    await expect(
      startGateway({ ...BASE_ENV, DFR_RECOVERY_BATCH_SIZE: '501' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
    await expect(
      startGateway({ ...BASE_ENV, DFR_RECOVERY_BATCH_SIZE: 'ten' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
  }, 15_000);
});
