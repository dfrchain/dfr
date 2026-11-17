/**
 * M4 故障 / 回退演练（离线可复现）。
 *
 * 权威来源：M4 任务书完成门"故障演练、回退演练"、ADR-008、`docs/runbooks/m4-bex-integration.md`。
 *
 * 全部用 stub provider + 真实 Gateway/Core/引擎驱动，**不依赖公网、不需要资金**，
 * 因此可进默认离线门禁。覆盖 BEX 接入时最需要提前确认的四类场景：
 *   1. Provider 掉线 → 切换到备用端点（BEX 用 DFR 后不再自建切换）；
 *   2. 票据失效/不匹配 → `DFR_INVALID_TICKET`（不枚举原因）；
 *   3. 确认超时 → 200 + `reached:false`（不是错误，不重写记录）；
 *   4. 回退演练：同一笔结算**只**由 DFR 广播一次（绝不双路广播）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { EventBus } from '@dfr/events';
import { createGatewayServer, hashSecret, TokenBucketLimiter, createCoreTransactionChainPort } from '@dfr/gateway';
import { SseTicketStore } from '../../apps/gateway/src/sse-ticket.js';
import { createStubFetch } from '@dfr/provider';
import { ChainRegistry } from '@dfr/registry';
import { TransactionEngine } from '@dfr/transaction';
import type { AccountRef, Chain, ChainId, TransactionId } from '@dfr/types';
import { createInMemoryTransactionStores } from './support/in-memory-transaction-stores.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN = 'ethereum-sepolia' as ChainId;
const SECRET = 'm4DrillsSecret0123456789abcdef';
const PEPPER = 'm4-drills-pepper';
const KEY_ID = 'M4Drill1';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };

const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
  baseFeePerGas: '0x3b9aca00',
};

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

interface HarnessOptions {
  /** 主 Provider 的应答行为（默认正常）。 */
  primary?: 'ok' | 'http-503';
  /** confirm 轮询时交易是否可见。 */
  confirmVisible?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const called: Array<{ providerId: string; method: string }> = [];
  const rawSends: string[] = [];
  const primaryBehavior = options.primary ?? 'ok';

  const stub = createStubFetch({
    onCall: (call) => called.push({ providerId: call.providerId, method: call.method }),
    resolve: (call) => {
      const isPrimary = call.providerId.includes('primary');
      if (isPrimary && primaryBehavior === 'http-503') return { kind: 'http', status: 503 };
      switch (call.method) {
        case 'eth_chainId': return { kind: 'result', value: '0xaa36a7' };
        case 'eth_blockNumber': return { kind: 'result', value: '0x112a880' };
        case 'eth_getTransactionCount': return { kind: 'result', value: '0x2a' };
        case 'eth_estimateGas': return { kind: 'result', value: '0x5208' };
        case 'eth_maxPriorityFeePerGas': return { kind: 'result', value: '0x3b9aca00' };
        case 'eth_getBlockByNumber': return { kind: 'result', value: BLOCK };
        case 'eth_call': return { kind: 'result', value: '0x' };
        case 'eth_getTransactionByHash':
          return { kind: 'result', value: options.confirmVisible === false ? null : {
            hash: `0x${'ab'.repeat(32)}`, blockNumber: '0x1', blockHash: `0x${'11'.repeat(32)}`,
            from: FROM.address, to: FROM.address, value: '0x0', nonce: '0x2a', input: '0x',
            transactionIndex: '0x0', gasPrice: '0x3b9aca00', gas: '0x5208',
          } };
        case 'eth_getLogs': return { kind: 'result', value: [{ address: FROM.address, topics: ['0xaa'], data: '0x', blockNumber: '0x1', logIndex: '0x0', transactionHash: `0x${'ab'.repeat(32)}` }] };
        case 'eth_sendRawTransaction': {
          rawSends.push(String(call.params[0]));
          return { kind: 'result', value: `0x${'cd'.repeat(32)}` };
        }
        default: return { kind: 'rpc-error', code: -32601, message: `unsupported ${call.method}` };
      }
    },
  });

  const registry = ChainRegistry.load({
    file: resolve(repoRoot, 'packages/registry/config/chains.yaml'),
    env: {
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://stub.local/sepolia-primary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://stub.local/sepolia-secondary',
    },
  });
  const stores = createInMemoryTransactionStores();
  const core = new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    random: () => 0, // 固定先选主 Provider，否则"切换"会退化成"直接成功"
    fetchImpl: stub,
    transactionStores: stores,
  });
  let n = 1;
  const engine = new TransactionEngine({
    stores: {
      transaction: stores.transaction,
      idempotency: stores.idempotency,
      nonce: stores.nonce,
      tracker: stores.tracker,
    },
    chain: createCoreTransactionChainPort(core),
    newTransactionId: () => `txn_01J8Z6W3Q2K9M4ABCDEFGHJK${String(n++).padStart(2, '0')}` as TransactionId,
  });
  const bus = new EventBus();
  const tickets = new SseTicketStore();
  const server = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'm4-drills',
      scope: { chains: '*', capabilities: '*', allowWrite: true },
    },
    allowWrite: true,
    transactions: engine,
    eventBus: bus,
    sseTickets: tickets,
    limiter: new TokenBucketLimiter({
      read: { capacity: 1000, refillPerSecond: 1000 },
      write: { capacity: 1000, refillPerSecond: 1000 },
      stream: { capacity: 100, refillPerSecond: 100 },
    }),
  });
  servers.push(server);
  return { core, engine, stores, bus, tickets, server, called, rawSends };
}

async function baseUrl(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, { headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' }, ...init });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('M4 故障/回退演练（离线）', () => {
  it('Provider 掉线：主端点 5xx 时切到备用并返回结果', async () => {
    const h = harness({ primary: 'http-503' });
    const base = await baseUrl(h.server);
    const { status, body } = await json(`${base}/v1/chains/${CHAIN}`);
    // 主 Provider 5xx → 管理切换 → 备用返回 eth_chainId/eth_blockNumber → 200。
    expect(status).toBe(200);
    expect(h.called.some((c) => c.providerId.includes('primary'))).toBe(true);
    expect(h.called.some((c) => c.providerId.includes('secondary'))).toBe(true);
    expect(body['chain']).toBe(CHAIN);
  }, 20_000);

  it('票据失效：用另一组 filter 消费票据 → DFR_INVALID_TICKET（不枚举原因）', async () => {
    const h = harness();
    const base = await baseUrl(h.server);
    const issued = h.tickets.issue({ projectId: 'm4-drills', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: CHAIN as never } })!;
    // 用**不同** filter（多加一个 types）消费：摘要不符 → 401。
    const res = await fetch(
      `${base}/v1/events/subscribe?chain=${CHAIN}&types=tx.finalized&ticket=${encodeURIComponent(issued.ticket)}`,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { dfr_code?: string }).dfr_code).toBe('DFR_INVALID_TICKET');
  }, 20_000);

  it('交易尚不可见：对未知 hash 调 confirm → 200 pending（内部轮询至 timeoutMs，不伪造终局）', async () => {
    const h = harness({ confirmVisible: false });
    const base = await baseUrl(h.server);
    const { status, body } = await json(`${base}/v1/transactions/0x${'ab'.repeat(32)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ chain: CHAIN, minFinality: 'finalized', timeoutMs: 1000 }),
    });
    // 链上还查不到这笔：confirm 在调用方给定的 timeoutMs 内内部轮询（F-2），
    // 截止仍不可见则如实返回 pending / reached=false 并转后台续跟，
    // **不**伪造 confirmed/failed，也不再 fail-fast 抛 404。
    // BEX 侧按 runbook：pending 是"尚未可见"，有界轮询即可，不当作错误重试广播。
    expect(status).toBe(200);
    const confirmation = body['confirmation'] as { status?: string; finality?: string; reached?: boolean };
    expect(confirmation.status).toBe('pending');
    expect(confirmation.finality).toBe('unknown');
    expect(confirmation.reached).toBe(false);
  }, 20_000);

  it('回退演练：一笔结算只广播一次，绝不双路广播', async () => {
    const h = harness();
    const base = await baseUrl(h.server);
    const built = await json(`${base}/v1/transactions/build`, {
      method: 'POST',
      body: JSON.stringify({ chain: CHAIN, from: FROM, to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' }, value: { asset: { kind: 'native', chain: CHAIN }, amount: '1' } }),
    });
    const txid = built.body['transactionId'] as string;
    const unsigned = built.body['unsignedTransaction'] as Record<string, unknown>;
    // 用桩签名（EIP-1559 形状）——绑定校验要求 payload 与记录一致，这里直接用记录里的 payload。
    const payload = unsigned['payload'] as string;
    const signed = {
      schemaVersion: '1', chain: CHAIN, unsigned,
      signedPayload: payload, expectedHash: `0x${'cd'.repeat(32)}`, signerRef: 'external:drill',
    };
    const res = await json(`${base}/v1/transactions/broadcast`, {
      method: 'POST',
      headers: { 'x-dfr-key': KEY, 'content-type': 'application/json', 'idempotency-key': 'drill-idem-0001' },
      body: JSON.stringify({ transactionId: txid, signedTransaction: signed }),
    });
    expect([200, 422]).toContain(res.status); // 桩签名可能未通过绑定 → 422，且不广播
    // **核心断言**：无论成功与否，广播调用至多一次（绝不重试/双路）。
    expect(h.rawSends.length).toBeLessThanOrEqual(1);
    if (res.status === 200) {
      expect((res.body['broadcast'] as { accepted: boolean }).accepted).toBe(true);
    }
  }, 20_000);
});
