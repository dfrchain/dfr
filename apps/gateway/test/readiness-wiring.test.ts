// composition root 就绪装配测试（DFR-M1-E02）。
//
// 单测覆盖了 Gateway 的 `/readyz` 逻辑；这里补的是**接线**：真实 `startGateway`
// 在 M1（有事务存储）时，必须把数据库探针接进 `/readyz`，否则编排系统会认为
// "HTTP 起了就是就绪"，而数据库其实已经不可达。
import { describe, expect, it, vi } from 'vitest';
import type { TransactionStores } from '@dfr/core';
import { hashSecret } from '../src/index.js';
import { startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'ReadyKey';
const SECRET = 'readinessWiringSecret0123456789ab';
const PEPPER = 'readiness-wiring-pepper';

const M1_ENV = {
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

function persistence(healthCheck: () => Promise<void>): GatewayPersistence {
  // startGateway 会在监听前跑一轮 RecoveryCoordinator；这里给四个 Store 提供
  // 最小 no-op 实现，使测试只关注就绪接线，不重复 DB 门禁已覆盖的恢复语义。
  return {
    stores: {
      transaction: {
        listRecoverable: async () => [],
      } as unknown as TransactionStores['transaction'],
      idempotency: {
        pruneExpired: async () => 0,
      } as unknown as TransactionStores['idempotency'],
      nonce: {
        releaseExpiredOrphaned: async () => 0,
      } as unknown as TransactionStores['nonce'],
      tracker: {
        acquire: async () => ({ kind: 'held_by_other' }),
        release: async () => ({ kind: 'released' }),
      } as unknown as TransactionStores['tracker'],
    },
    healthCheck,
    close: vi.fn(async () => undefined),
  };
}

async function withGateway(
  healthCheck: () => Promise<void>,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const app = await startGateway(M1_ENV, async () => persistence(healthCheck));
  try {
    await body(`http://127.0.0.1:${app.port}`);
  } finally {
    await app.close();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('startGateway 就绪装配（DFR-M1-E02）', () => {
  it('M1 启动后 /readyz 反映数据库可达（stores=ok）', async () => {
    await withGateway(async () => undefined, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/readyz`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['status']).toBe('ready');
      expect(body['stores']).toBe('ok');
      // 就绪明细必须如实反映每条启用链的 Provider 可用性。
      // ethereum-sepolia：两个端点已由 env 解析 → 2/2。
      // base-sepolia：M1 下启用但本测试未提供端点 env → 0/0（配置缺口被显式暴露，
      // 而不是被掩盖成"就绪"）。整体仍就绪，因为至少一条链有可用 Provider。
      expect(body['chains']).toEqual([
        { chain: 'ethereum-sepolia', providers: 2, available: 2 },
        { chain: 'base-sepolia', providers: 0, available: 0 },
      ]);
    });
  });

  it('数据库探针失败时 /readyz 503，但 /healthz 仍 200', async () => {
    await withGateway(
      async () => {
        throw new Error('connect ECONNREFUSED 10.1.2.3:5432');
      },
      async (baseUrl) => {
        const ready = await fetch(`${baseUrl}/readyz`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toMatchObject({ status: 'not_ready', stores: 'unavailable' });

        const live = await fetch(`${baseUrl}/healthz`);
        expect(live.status).toBe(200);
      },
    );
  });

  it('数据库在运行中失效时拒绝业务路由；恢复后重新放行', async () => {
    let databaseUp = true;
    await withGateway(
      async () => {
        if (!databaseUp) throw new Error('database unavailable');
      },
      async (baseUrl) => {
        const headers = { 'X-DFR-Key': `dfr_${KEY_ID}_${SECRET}` };
        expect((await fetch(`${baseUrl}/v1/chains`, { headers })).status).toBe(200);

        databaseUp = false;
        expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/v1/chains`, { headers })).status).toBe(503);

        databaseUp = true;
        expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
        expect((await fetch(`${baseUrl}/v1/chains`, { headers })).status).toBe(200);
      },
    );
  });
});
