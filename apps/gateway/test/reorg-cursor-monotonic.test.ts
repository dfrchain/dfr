// 重组事件游标跨巡检轮次的单调性（ADR-006 / ChainEvent.cursor）。
//
// 为什么必须用真实 startGateway：缺陷不在 `ReorgReconciler` 内部，而在**接线**——
// Gateway 的 `reconcile` 每轮都 `new ReorgReconciler(...)`，而游标是实例字段，
// 于是每轮都从 1 重新开始。组件级测试（reorg.test.ts）每次只 new 一个实例，看不到。
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../src/index.js';
import { startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'CursorKy';
const SECRET = 'reorgCursorMonotonicSecret0123456789';
const PEPPER = 'cursor-pepper';
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
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
      // 交易锚定的 canonical hash 是 0xcc…，而链上现在返回 0xaa…，
      // 于是每一轮巡检都会判定为重组并回退这条记录。
      const result =
        parsed.method === 'eth_chainId'
          ? '0xaa36a7'
          : parsed.method === 'eth_getBlockByNumber'
            ? BLOCK
            : '0x0';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
    });
  });
}

/** 一条 included 记录；每轮都会被"发现重组"并回退。 */
function includedRecord(seq: number): Record<string, unknown> {
  return {
    transactionId: `txn_cursor_${seq}`,
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

describe('重组事件游标跨轮次单调（DFR-M1-D04 补强）', () => {
  it('两轮巡检发布的事件游标必须严格递增（当前实现会重复为 1）', async () => {
    const rpc = rpcServer();
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    const rpcPort = (rpc.address() as { port: number }).port;

    // 每轮巡检都返回一条新的 included 记录，保证两轮各产出一个事件。
    let served = 0;
    const persistence: GatewayPersistence = {
      stores: {
        transaction: {
          listRecoverable: async (input: { statuses?: readonly string[] }) => {
            if (input.statuses?.includes('included') !== true) return [];
            served += 1;
            if (served > 2) return [];
            return [includedRecord(served)];
          },
          transition: async () => ({ kind: 'applied', record: includedRecord(served) }),
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

    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
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
          DFR_REORG_SWEEP_INTERVAL_MS: '1000',
          DFR_REORG_SWEEP_BATCH: '10',
          DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
          DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: `http://127.0.0.1:${rpcPort}`,
        },
        async () => persistence,
      );
      // 等两轮巡检（间隔 1s）。
      await new Promise((resolve) => setTimeout(resolve, 2_600));

      const cursors = lines
        .map((line) => {
          try {
            return JSON.parse(line) as { msg?: string; cursor?: unknown };
          } catch {
            return undefined;
          }
        })
        .filter((entry): entry is { msg?: string; cursor?: unknown } => entry?.msg === 'chain.reorg')
        .map((entry) => String(entry.cursor));

      expect(cursors.length, `expected >= 2 reorg events, got: ${lines.join('')}`).toBeGreaterThanOrEqual(2);
      // 字符串比较前先转数字：ADR-006 要求游标单调递增。
      for (let i = 1; i < cursors.length; i += 1) {
        expect(
          Number(cursors[i]),
          `游标必须严格递增，实际为 ${JSON.stringify(cursors)}`,
        ).toBeGreaterThan(Number(cursors[i - 1]));
      }
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);
});
