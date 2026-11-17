/**
 * `POST /v1/events/tickets` HTTP 端点测试（M2-C02，ADR-029）。
 *
 * 用真实 `createGatewayServer` 驱动，验证票据签发经过真实的鉴权、限流与 scope 闸门，
 * 而不是只测一个孤立的 store。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';
import { SseTicketStore } from '../src/sse-ticket.js';

const SECRET = 'sseTicketEndpointSecret0123456789';
const PEPPER = 'sse-ticket-pepper';
const KEY_ID = 'SseKey01';

const core = {
  listChains: () => [],
  startHealthChecks: () => ({ started: 0, skipped: 0 }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function auth(chains: StaticApiKeyConfig['scope']['chains'] = '*'): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'sse-ticket',
    scope: { chains, capabilities: '*', allowWrite: false },
  };
}

async function start(options: { tickets?: SseTicketStore; trustedProxies?: readonly string[]; chains?: StaticApiKeyConfig['scope']['chains'] } = {}) {
  const server = createGatewayServer({
    core,
    auth: auth(options.chains),
    ...(options.tickets !== undefined ? { sseTickets: options.tickets } : {}),
    ...(options.trustedProxies !== undefined ? { trustedProxies: options.trustedProxies } : {}),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const KEY = `dfr_${KEY_ID}_${SECRET}`;

function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/events/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dfr-key': KEY, ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/events/tickets（M2-C02）', () => {
  it('受限链 Key 不能签发无 chain 的全局事件票据', async () => {
    const store = new SseTicketStore();
    const base = await start({ tickets: store, chains: ['solana-devnet' as never] });
    const res = await post(base, { filter: {} });
    expect(res.status).toBe(403);
    expect((await res.json()) as { dfr_code: string }).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(store.size).toBe(0);
  });

  it('签发返回 201 + ticket/expiresAt/requestId，且 ticket 不含 Key', async () => {
    const base = await start({ tickets: new SseTicketStore() });
    const res = await post(base, { filter: { chain: 'solana-devnet' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticket: string; expiresAt: string; requestId: string };
    expect(body.ticket).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
    expect(body.requestId).toBeTruthy();
    // 票据不得包含 API Key 的任何片段（它是独立的不透明随机值）。
    expect(body.ticket).not.toContain(SECRET);
    expect(body.ticket).not.toContain(KEY_ID);
  });

  it('AUTH-02：受限 Key 不得签发其他链或全链的 SSE 票据', async () => {
    const store = new SseTicketStore();
    const base = await start({
      tickets: store,
      chains: ['ethereum-sepolia' as never],
    });
    for (const body of [
      { filter: { chain: 'solana-devnet' } },
      { filter: {} },
      {},
    ]) {
      const response = await post(base, body);
      expect(response.status).toBe(403);
      const result = (await response.json()) as { dfr_code: string };
      expect(result.dfr_code).toBe('DFR_PROJECT_SCOPE_DENIED');
    }
    expect(store.size).toBe(0);
    const allowed = await post(base, { filter: { chain: 'ethereum-sepolia' } });
    expect(allowed.status).toBe(201);
    expect(store.size).toBe(1);
  });

  it('未携带 Key → 401（与其他端点一致）', async () => {
    const base = await start({ tickets: new SseTicketStore() });
    const res = await fetch(`${base}/v1/events/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('未装配票据存储的部署 → 404（该部署无 SSE），不是 500', async () => {
    const base = await start();
    const res = await post(base, { filter: {} });
    expect(res.status).toBe(404);
  });

  it('ttlMs 超上限 → 400（不静默截断）', async () => {
    const base = await start({ tickets: new SseTicketStore() });
    expect((await post(base, { filter: {}, ttlMs: 60_001 })).status).toBe(400);
    expect((await post(base, { filter: {}, ttlMs: 0 })).status).toBe(400);
  });

  it('签发的票据可被同一 Key/IP/filter 消费，换 filter 则失败', async () => {
    const store = new SseTicketStore();
    const base = await start({ tickets: store });
    const res = await post(base, { filter: { chain: 'solana-devnet' } });
    const { ticket } = (await res.json()) as { ticket: string };

    // 直连对端是 127.0.0.1（未配置可信代理，且未带 XFF）。
    expect(store.consume({ projectId: 'sse-ticket',
      ticket, apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never },
    }).kind).toBe('ok');

    const res2 = await post(base, { filter: { chain: 'solana-devnet' } });
    const { ticket: ticket2 } = (await res2.json()) as { ticket: string };
    expect(store.consume({ projectId: 'sse-ticket',
      ticket: ticket2, apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'ethereum-sepolia' as never },
    }).kind, '扩大/改变 filter 必须失败').toBe('invalid');
  });

  it('默认不信任 X-Forwarded-For（IP 绑定取直连对端）', async () => {
    const store = new SseTicketStore();
    const base = await start({ tickets: store });
    // 每次签发的票据只能消费一次，因此用两张票据分别验证。
    const res1 = await post(base, { filter: {} }, { 'x-forwarded-for': '1.2.3.4' });
    const { ticket: t1 } = (await res1.json()) as { ticket: string };
    // 未配置可信代理：绑定的是直连 127.0.0.1，伪造的 XFF 无法消费。
    expect(store.consume({ projectId: 'sse-ticket', ticket: t1, apiKeyId: KEY_ID, ip: '1.2.3.4', filter: {} }).kind).toBe('invalid');

    const res2 = await post(base, { filter: {} }, { 'x-forwarded-for': '1.2.3.4' });
    const { ticket: t2 } = (await res2.json()) as { ticket: string };
    expect(store.consume({ projectId: 'sse-ticket', ticket: t2, apiKeyId: KEY_ID, ip: '127.0.0.1', filter: {} }).kind).toBe('ok');
  });
});
