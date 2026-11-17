// broadcast 幂等契约测试（TODO-013）。
//
// 预复审发现：gateway-spec §7.2 / openapi / m1-api-contract §4 / security-trust-model §5
// 都声称广播有幂等（存指纹 + 首次响应、同体重放、异体 409、`Idempotency-Replayed`），
// 但 Gateway 只校验键长度，`engine.broadcast` 从不访问幂等 Store。
//
// 本文件把该契约锁成行为。**最强的一条断言是**：同键同体重放时
// **Adapter 只被调用一次** —— 这才是"幂等"真正的资金安全含义（不会重复广播）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import {
  GatewayIdempotencyCoordinator,
  createGatewayServer,
  hashSecret,
  type StaticApiKeyConfig,
} from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia';
const KEY_ID = 'BcIdem01'; // 恰好 8 位
const SECRET = 'broadcastIdempotencySecret0123456789';
const PEPPER = 'bc-idem-pepper';
const EXPECTED_HASH = `0x${'ab'.repeat(32)}`;

const core = {
  listChains: () => [],
  readiness: () => ({ ready: false, chains: [] }),
  startHealthChecks: () => ({ started: [], skipped: [] }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

function auth(): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'bc-idem',
    scope: { chains: '*', capabilities: '*', allowWrite: true },
  };
}

const UNSIGNED = { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: {} };

function body(transactionId: string, hash = EXPECTED_HASH) {
  return {
    transactionId,
    signedTransaction: {
      schemaVersion: '1',
      chain: CHAIN,
      unsigned: UNSIGNED,
      signedPayload: '0x02f8signed',
      expectedHash: hash,
    },
  };
}

let server: Server | undefined;
let broadcastCalls = 0;
let baseUrl = '';

async function start(): Promise<void> {
  broadcastCalls = 0;
  const stores = createInMemoryTransactionStores();
  const engine = {
    broadcast: async () => {
      broadcastCalls += 1;
      return {
        transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
        status: 'broadcast',
        txHash: EXPECTED_HASH,
        accepted: true,
        observedAt: new Date().toISOString(),
      };
    },
  };
  server = createGatewayServer({
    core,
    auth: auth(),
    allowWrite: true,
    transactions: engine as never,
    // 真实的内存幂等 Store + 真实的 C04 协调器（此前从未被装配）。
    idempotency: new GatewayIdempotencyCoordinator(stores.idempotency),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function post(
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; replayed: string | null; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/transactions/broadcast`, {
    method: 'POST',
    headers: {
      'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    replayed: response.headers.get('idempotency-replayed'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('broadcast 幂等（TODO-013）', () => {
  it('同键同体两次 → 都 202，但 Adapter 只被调用一次，第二次带 Idempotency-Replayed', async () => {
    await start();
    const payload = body('txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN');

    const first = await post(payload, 'bc-idem-key-0001');
    expect(first.status).toBe(202);
    expect(first.replayed).toBeNull();
    expect(broadcastCalls).toBe(1);

    const second = await post(payload, 'bc-idem-key-0001');
    expect(second.status).toBe(202);
    // 关键：重放**不得**再次广播。
    expect(broadcastCalls).toBe(1);
    expect(second.replayed).toBe('true');
    expect(second.body['transactionId']).toBe(first.body['transactionId']);
  });

  it('同键不同体 → 409 DFR_IDEMPOTENCY_CONFLICT，且不广播第二次', async () => {
    await start();
    await post(body('txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN'), 'bc-idem-key-0002');
    expect(broadcastCalls).toBe(1);

    // 换 transactionId（不同请求体）复用同一幂等键。
    const conflict = await post(body('txn_OTHER_ID'), 'bc-idem-key-0002');
    expect(conflict.status).toBe(409);
    expect(conflict.body['dfr_code']).toBe('DFR_IDEMPOTENCY_CONFLICT');
    expect(broadcastCalls).toBe(1);
  });

  it('不同幂等键 → 各自独立执行（幂等键不串味）', async () => {
    await start();
    const payload = body('txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN');
    await post(payload, 'bc-idem-key-0003');
    await post(payload, 'bc-idem-key-0004');
    expect(broadcastCalls).toBe(2);
  });

  it('未装配幂等协调器时不得静默降级：仍要求键，但不做重放', async () => {
    // 该用例锁定"装配与否"的行为差异是显式的：没有协调器就没有重放保证。
    broadcastCalls = 0;
    const engine = {
      broadcast: async () => {
        broadcastCalls += 1;
        return { transactionId: 'txn_x', status: 'broadcast', txHash: EXPECTED_HASH, accepted: true, observedAt: new Date().toISOString() };
      },
    };
    server = createGatewayServer({ core, auth: auth(), allowWrite: true, transactions: engine as never });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const payload = body('txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN');
    await post(payload, 'bc-idem-key-0005');
    await post(payload, 'bc-idem-key-0005');
    // 无协调器 → 两次都真的广播（这是当前的诚实行为，不是"假装幂等"）。
    expect(broadcastCalls).toBe(2);
  });
});

describe('真实 startGateway 的幂等接线（TODO-013）', () => {
  it('M1 启动后广播幂等生效：同键不同体被 409 拦截（证明协调器已装配）', async () => {
    // 为什么用"冲突"而不是"重放"来验证接线：重放需要**首次请求成功**（才会写首次响应），
    // 而让真实 startGateway 的引擎成功广播需要可用的 Provider + 真实签名 —— 那由
    // tests/e2e/m1-broadcast.e2e.test.ts 覆盖。这里只需证明"协调器确实被装配"：
    // `acquire` 发生在引擎调用**之前**，因此同键不同体必然得到 409（而不是引擎层的 404）。
    const { startGateway } = await import('../src/main.js');
    const stores = createInMemoryTransactionStores();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let app: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      app = await startGateway(
        {
          DFR_M0_API_KEY_ID: KEY_ID,
          DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
          DFR_M0_API_KEY_PEPPER: PEPPER,
          DFR_GATEWAY_PORT: '0',
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
        },
        async () => ({
          stores: {
            transaction: stores.transaction,
            idempotency: stores.idempotency,
            nonce: stores.nonce,
            tracker: stores.tracker,
          } as never,
          healthCheck: async () => undefined,
          close: async () => undefined,
        }),
      );
      const url = `http://127.0.0.1:${app.port}/v1/transactions/broadcast`;
      const headers = {
        'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
        'content-type': 'application/json',
        'idempotency-key': 'wire-idem-0001',
      };

      const first = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body('txn_wire_a')),
      });
      // 首次请求拿到执行权，随后因记录不存在在引擎层失败（404），
      // 但幂等记录已经建立 —— 这正是下面冲突断言的前提。
      expect(first.status).toBe(404);

      const second = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body('txn_wire_b')),
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { dfr_code?: string }).dfr_code).toBe(
        'DFR_IDEMPOTENCY_CONFLICT',
      );
    } finally {
      await app?.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);
});
