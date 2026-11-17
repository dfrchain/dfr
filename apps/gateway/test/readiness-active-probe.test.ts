// /readyz 主动探测契约测试（DFR-M1-E02 观测补充，opt-in）。
//
// 背景：默认 `/readyz` 只读已有熔断/健康状态，因此**冷启动**的 Provider（尚未被任何探针
// 观测，health=unknown）会被计为可用 → 端点全挂也可能"谎报就绪"。
// `DFR_READY_ACTIVE_PROBE=true` 时改为当场探测：available 表示"刚才真的应答了"。
//
// 本文件用真实 `startGateway` + 本地 RPC 端点，验证三条：
//   1. 默认（未开启）：即使端点不可达，仍按旧语义判定（回归保护，行为不变）；
//   2. 开启后：端点不可达 → 503；端点可达 → 200；
//   3. TTL 缓存生效：连续两次 /readyz 不会每次都打 RPC。
import { createServer, type Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionStores } from '@dfr/core';
import { hashSecret } from '../src/index.js';
import { GatewayStartupError, startGateway, type GatewayPersistence } from '../src/main.js';

const SECRET = 'activeProbeSecret0123456789abcdef';
const PEPPER = 'active-probe-pepper';

function fakePersistence(): GatewayPersistence {
  return {
    stores: {
      transaction: { listRecoverable: async () => [] as never[] } as unknown as TransactionStores['transaction'],
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
}

function baseEnv(rpcPort: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DFR_M0_API_KEY_ID: 'ProbeKey',
    DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
    DFR_M0_API_KEY_PEPPER: PEPPER,
    DFR_GATEWAY_PORT: '0',
    DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
    DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
    DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
    DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
    DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
    ...extra,
  };
}

async function withGateway(
  env: NodeJS.ProcessEnv,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const app = await startGateway(env, async () => fakePersistence());
  try {
    await body(`http://127.0.0.1:${app.port}`);
  } finally {
    await app.close();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** 返回 eth_chainId 的 RPC；`calls` 记录收到的请求数。 */
async function startRpc(): Promise<{ port: number; server: Server; calls: () => number }> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result: '0x14a34' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, server, calls: () => count };
}

describe('GET /readyz 主动探测（DFR-M1-E02 观测补充）', () => {
  it('开启后：端点可达 → 200 ready，且 available 表示"真的应答了"', async () => {
    const rpc = await startRpc();
    try {
      await withGateway(baseEnv(rpc.port, { DFR_READY_ACTIVE_PROBE: 'true' }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/readyz`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          status: string;
          chains: { chain: string; providers: number; available: number }[];
        };
        expect(body.status).toBe('ready');
        const base = body.chains.find((c) => c.chain === 'base-sepolia');
        expect(base).toEqual({ chain: 'base-sepolia', providers: 1, available: 1 });
        expect(rpc.calls()).toBeGreaterThan(0);
      });
    } finally {
      await new Promise<void>((resolve) => rpc.server.close(() => resolve()));
    }
  }, 20_000);

  it('开启后：端点不可达 → 503（这正是默认语义会谎报就绪的场景）', async () => {
    // 占用一个端口后立刻关闭，得到一个"确定不可达"的地址。
    const rpc = await startRpc();
    const deadPort = rpc.port;
    await new Promise<void>((resolve) => rpc.server.close(() => resolve()));

    await withGateway(baseEnv(deadPort, { DFR_READY_ACTIVE_PROBE: 'true' }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/readyz`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as {
        status: string;
        chains: { chain: string; available: number }[];
      };
      expect(body.status).toBe('not_ready');
      // 探测确实把死端点判成不可用（而不是沿用"unknown 即可用"）。
      expect(body.chains.find((c) => c.chain === 'base-sepolia')?.available).toBe(0);
    });
  }, 20_000);

  it('默认未开启时保持旧语义（回归保护）：不因端点不可达而改判', async () => {
    const rpc = await startRpc();
    const deadPort = rpc.port;
    await new Promise<void>((resolve) => rpc.server.close(() => resolve()));

    await withGateway(baseEnv(deadPort), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/readyz`);
      // 旧语义只读已有状态：从未被观测的 Provider 计为可用 → 仍为 ready。
      // 该断言锁定"不改默认行为"，使开启新特性成为显式选择。
      expect(response.status).toBe(200);
    });
  }, 20_000);

  it('TTL 缓存生效：连续两次 /readyz 不会重复打满 RPC', async () => {
    const rpc = await startRpc();
    try {
      await withGateway(
        baseEnv(rpc.port, { DFR_READY_ACTIVE_PROBE: 'true', DFR_READY_PROBE_CACHE_MS: '60000' }),
        async (baseUrl) => {
          const first = await fetch(`${baseUrl}/readyz`);
          expect(first.status).toBe(200);
          const afterFirst = rpc.calls();

          const second = await fetch(`${baseUrl}/readyz`);
          expect(second.status).toBe(200);
          // 缓存命中：第二次不应产生任何新的 RPC。
          expect(rpc.calls()).toBe(afterFirst);
        },
      );
    } finally {
      await new Promise<void>((resolve) => rpc.server.close(() => resolve()));
    }
  }, 20_000);

  it('非法开关值 fail-closed（不静默当作关闭）', async () => {
    await expect(
      startGateway(
        baseEnv(1, { DFR_READY_ACTIVE_PROBE: 'yes' }),
        async () => fakePersistence(),
      ),
    ).rejects.toBeInstanceOf(GatewayStartupError);
  }, 20_000);
});
