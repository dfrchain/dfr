/**
 * 事件源接线测试（M2-C03 收尾）：后台 `chain.reorg` 必须真正进入事件总线。
 *
 * 为什么必须用真实 `startGateway`：接线点在 composition root（reorg 巡检的 publish sink），
 * 组件级测试看不到"事件是否真的从巡检流到了订阅者"。
 */
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../src/index.js';
import { startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'EvtWire1';
const SECRET = 'sseEventWiringSecret0123456789';
const PEPPER = 'sse-event-wiring-pepper';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const CHAIN = 'ethereum-sepolia';

const BLOCK = {
  number: '0x10',
  hash: `0x${'aa'.repeat(32)}`,
  parentHash: `0x${'bb'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
};

function rpcServer(): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
      // 链上 canonical hash 是 0xaa…，而记录锚定的是 0xcc… → 每轮都判定为重组。
      const result = parsed.method === 'eth_chainId' ? '0xaa36a7'
        : parsed.method === 'eth_getBlockByNumber' ? BLOCK
          : '0x0';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
    });
  });
}

function includedRecord(seq: number): Record<string, unknown> {
  return {
    transactionId: `txn_evt_${seq}`,
    projectId: 'default',
    chain: CHAIN,
    requestFingerprint: 'a'.repeat(64),
    status: 'included',
    stateVersion: '4',
    from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
    txHash: `0x${String(seq).padStart(2, '0').repeat(32).slice(0, 64)}`,
    blockRef: { kind: 'number', number: '16' },
    canonicalBlockHash: `0x${'cc'.repeat(32)}`,
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
}

describe('事件源接线：chain.reorg → SSE（M2-C03）', () => {
  it('订阅者能收到后台巡检发布的 chain.reorg 事件', async () => {
    const rpc = rpcServer();
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    const rpcPort = (rpc.address() as { port: number }).port;

    const persistence: GatewayPersistence = {
      stores: {
        transaction: {
          // 只有**重组巡检**带 `statuses: ['included']`；启动恢复巡检不带 statuses
          // （`RecoveryCoordinator.run` 的调用形状）。按这一点区分，避免启动恢复
          // 提前消耗掉我们要观察的那条记录（否则测试会随启动时序 flaky）。
          // 每一轮都返回同一个"被重组"的记录：订阅者无论何时连上，后续轮次都会产生事件。
          // （只返回一次会让测试依赖"订阅恰好早于第一轮巡检"，那是 flaky 的根源。）
          listRecoverable: async (input: { statuses?: readonly string[] }) => {
            if (input.statuses?.includes('included') !== true) return [];
            return [includedRecord(1)];
          },
          transition: async () => ({ kind: 'applied', record: includedRecord(1) }),
        } as never,
        idempotency: { pruneExpired: async () => 0 } as never,
        nonce: { releaseExpiredOrphaned: async () => 0 } as never,
        tracker: {
          acquire: async () => ({ kind: 'acquired' }),
          renew: async () => ({ kind: 'renewed' }),
          release: async () => ({ kind: 'released' }),
        } as never,
      },
      healthCheck: async () => undefined,
      close: async () => undefined,
    };

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let app: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      app = await startGateway(
        {
          DFR_M0_API_KEY_ID: KEY_ID,
          DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
          DFR_M0_API_KEY_PEPPER: PEPPER,
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_GATEWAY_PORT: '0',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '1000', // 让巡检尽快跑一轮（不依赖外部入口）
          DFR_REORG_SWEEP_BATCH: '10',
          DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
          DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: `http://127.0.0.1:${rpcPort}`,
        },
        async () => persistence,
      );

      // 订阅（header 鉴权路径），然后触发一轮重组巡检。
      const controller = new AbortController();
      const res = await fetch(`${app.port ? `http://127.0.0.1:${app.port}` : ''}/v1/events/subscribe?chain=${CHAIN}`, {
        headers: { 'x-dfr-key': KEY },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      // 巡检每 1s 一轮；每轮都判定为重组并发布事件，因此订阅者总能等到一个。
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // 必须由一个连续读取循环独占 reader。此前每秒将 `reader.read()` 与超时
      // Promise 竞争；若超时先赢，遗留的 read 仍会在事件到达时消费 chunk，
      // 测试主循环却不再观察该 chunk，造成“日志已有 reorg、SSE 缓冲为空”的假阴性。
      const received = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          controller.abort();
          resolve(false);
        }, 8_000);
        void (async () => {
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) {
                resolve(false);
                return;
              }
              buffer += decoder.decode(chunk.value, { stream: true });
              if (buffer.includes('event: chain.reorg')) {
                resolve(true);
                return;
              }
            }
          } catch {
            // abort/对端断开都不是成功接收事件。
            resolve(false);
          } finally {
            clearTimeout(timeout);
          }
        })();
      });
      await reader.cancel().catch(() => undefined);
      controller.abort();
      expect(received, `expected chain.reorg over SSE, buffer=${buffer.slice(0, 400)}`).toBe(true);
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);
});
