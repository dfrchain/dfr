/**
 * `POST /v1/events/tickets` HTTP endpoint test (M2-C02, ADR-029).
 *
 * Drives with the real `createGatewayServer`, verifying ticket issuance passes real auth, rate-limit, and scope gates,
 * rather than only testing an isolated store.
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

describe('POST /v1/events/tickets (M2-C02)', () => {
  it('a restricted-chain Key cannot issue a global event ticket with no chain', async () => {
    const store = new SseTicketStore();
    const base = await start({ tickets: store, chains: ['solana-devnet' as never] });
    const res = await post(base, { filter: {} });
    expect(res.status).toBe(403);
    expect((await res.json()) as { dfr_code: string }).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(store.size).toBe(0);
  });

  it('issuance returns 201 + ticket/expiresAt/requestId, and the ticket contains no Key', async () => {
    const base = await start({ tickets: new SseTicketStore() });
    const res = await post(base, { filter: { chain: 'solana-devnet' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticket: string; expiresAt: string; requestId: string };
    expect(body.ticket).toBeTruthy();
    expect(body.expiresAt).toBeTruthy();
    expect(body.requestId).toBeTruthy();
    // A ticket must not contain any fragment of an API Key (it is an independent opaque random value).
    expect(body.ticket).not.toContain(SECRET);
    expect(body.ticket).not.toContain(KEY_ID);
  });

  it('AUTH-02: a restricted Key may not issue SSE tickets for other chains or all chains', async () => {
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

  it('no Key carried → 401 (consistent with other endpoints)', async () => {
    const base = await start({ tickets: new SseTicketStore() });
    const res = await fetch(`${base}/v1/events/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('a deployment without an assembled ticket store → 404 (this deployment has no SSE), not 500', async () => {
    const base = await start();
    const res = await post(base, { filter: {} });
    expect(res.status).toBe(404);
  });

  it('ttlMs above the cap → 400 (no silent truncation)', async () => {
    const base = await start({ tickets: new SseTicketStore() });
    expect((await post(base, { filter: {}, ttlMs: 60_001 })).status).toBe(400);
    expect((await post(base, { filter: {}, ttlMs: 0 })).status).toBe(400);
  });

  it('an issued ticket can be consumed by the same Key/IP/filter, and fails with a different filter', async () => {
    const store = new SseTicketStore();
    const base = await start({ tickets: store });
    const res = await post(base, { filter: { chain: 'solana-devnet' } });
    const { ticket } = (await res.json()) as { ticket: string };

    // The direct peer is 127.0.0.1 (no trusted proxy configured, and no XFF carried).
    expect(store.consume({ projectId: 'sse-ticket',
      ticket, apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never },
    }).kind).toBe('ok');

    const res2 = await post(base, { filter: { chain: 'solana-devnet' } });
    const { ticket: ticket2 } = (await res2.json()) as { ticket: string };
    expect(store.consume({ projectId: 'sse-ticket',
      ticket: ticket2, apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'ethereum-sepolia' as never },
    }).kind, 'widening/changing the filter must fail').toBe('invalid');
  });

  it('X-Forwarded-For is not trusted by default (IP binding takes the direct peer)', async () => {
    const store = new SseTicketStore();
    const base = await start({ tickets: store });
    // Each issued ticket can only be consumed once, so two tickets are used to verify separately.
    const res1 = await post(base, { filter: {} }, { 'x-forwarded-for': '1.2.3.4' });
    const { ticket: t1 } = (await res1.json()) as { ticket: string };
    // No trusted proxy configured: the binding is the direct 127.0.0.1, and a forged XFF cannot consume it.
    expect(store.consume({ projectId: 'sse-ticket', ticket: t1, apiKeyId: KEY_ID, ip: '1.2.3.4', filter: {} }).kind).toBe('invalid');

    const res2 = await post(base, { filter: {} }, { 'x-forwarded-for': '1.2.3.4' });
    const { ticket: t2 } = (await res2.json()) as { ticket: string };
    expect(store.consume({ projectId: 'sse-ticket', ticket: t2, apiKeyId: KEY_ID, ip: '127.0.0.1', filter: {} }).kind).toBe('ok');
  });
});
