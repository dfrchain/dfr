/**
 * SSE subscription endpoint test (M2-C03, ADR-006 / ADR-029).
 *
 * Drives with the real `createGatewayServer` + real `EventBus`, covering:
 * ticket auth and single-use, header auth, filter effectiveness, event delivery, and disconnect cleanup.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import { EventBus } from '@dfr/events';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';
import { SseTicketStore } from '../src/sse-ticket.js';
import { TokenBucketLimiter } from '../src/ratelimit.js';

const SECRET = 'sseSubscribeSecret0123456789ab';
const PEPPER = 'sse-subscribe-pepper';
const KEY_ID = 'SseSub01';
const KEY = `dfr_${KEY_ID}_${SECRET}`;

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
    projectId: 'sse-sub',
    scope: { chains, capabilities: '*', allowWrite: false },
  };
}

async function start(options: {
  bus?: EventBus;
  tickets?: SseTicketStore;
  chains?: StaticApiKeyConfig['scope']['chains'];
  maxSseConnections?: number;
  limiter?: TokenBucketLimiter;
  authConfig?: StaticApiKeyConfig;
  keyId?: string;
} = {}) {
  const config = options.authConfig ?? auth(options.chains);
  const server = createGatewayServer({
    core,
    auth: options.keyId === undefined ? config : { ...config, keyId: options.keyId },
    eventBus: options.bus ?? new EventBus(),
    ...(options.tickets !== undefined ? { sseTickets: options.tickets } : {}),
    ...(options.maxSseConnections !== undefined ? { maxSseConnections: options.maxSseConnections } : {}),
    ...(options.limiter !== undefined ? { limiter: options.limiter } : {}),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Read SSE until `count` data frames arrive or it times out. */
async function readEvents(res: Response, count: number, timeoutMs = 3_000): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine !== undefined) events.push(JSON.parse(dataLine.slice(6)));
    }
  }
  reader.cancel().catch(() => undefined);
  return events;
}

describe('GET /v1/events/subscribe (M2-C03)', () => {
  it('rejects a ticket from a different project even when key IDs collide', async () => {
    const tickets = new SseTicketStore();
    const base = await start({ tickets });
    const issued = tickets.issue({ projectId: 'other-project', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never } })!;
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(issued.ticket)}`, { signal: controller.signal });
    const code = res.status;
    controller.abort();
    await res.body?.cancel().catch(() => undefined);
    expect(code).toBe(401);
  });
  it('invalidates an outstanding ticket after its issuing previous key is revoked', async () => {
    const tickets = new SseTicketStore();
    const config = auth();
    config.previousKeyId = 'Previous';
    config.previousHash = 'a'.repeat(64);
    const base = await start({ tickets, authConfig: config });
    const filter = { chain: 'solana-devnet' as never };
    const active = tickets.issue({ projectId: 'sse-sub', apiKeyId: 'Previous', ip: '127.0.0.1', filter })!;
    const revoked = tickets.issue({ projectId: 'sse-sub', apiKeyId: 'Previous', ip: '127.0.0.1', filter })!;
    const controller = new AbortController();
    const ok = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(active.ticket)}`, { signal: controller.signal });
    expect(ok.status).toBe(200);
    controller.abort();
    await ok.body?.cancel().catch(() => undefined);
    config.previousHash = undefined;
    const denied = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(revoked.ticket)}`);
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
  });

  it('applies the current IP allowlist to a previously issued ticket', async () => {
    const tickets = new SseTicketStore();
    const config = auth();
    const base = await start({ tickets, authConfig: config });
    const issued = tickets.issue({ projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never } })!;
    config.scope.ipAllowlist = ['192.0.2.1'];
    const denied = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(issued.ticket)}`);
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
  });
  it('rejects a ticket issued to an API key outside this gateway identity', async () => {
    const tickets = new SseTicketStore();
    const base = await start({ tickets });
    const issued = tickets.issue({ projectId: 'sse-sub', apiKeyId: 'Other001', ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never } })!;
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(issued.ticket)}`, { signal: controller.signal });
    const code = res.status;
    controller.abort();
    await res.body?.cancel().catch(() => undefined);
    expect(code).toBe(401);
  });

  it('rejects an invalid API key header even with an otherwise valid ticket', async () => {
    const tickets = new SseTicketStore();
    const base = await start({ tickets });
    const issued = tickets.issue({ projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never } })!;
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(issued.ticket)}`, {
      headers: { 'x-dfr-key': 'invalid-key' }, signal: controller.signal,
    });
    const code = res.status;
    controller.abort();
    await res.body?.cancel().catch(() => undefined);
    expect(code).toBe(401);
  });
  it('GW-01: enforces one simultaneous SSE connection per instance', async () => {
    const base = await start({ maxSseConnections: 1 });
    const controller = new AbortController();
    const first = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet`, {
      headers: { 'x-dfr-key': KEY }, signal: controller.signal,
    });
    expect(first.status).toBe(200);
    const next = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet`, {
      headers: { 'x-dfr-key': KEY },
    });
    expect(next.status).toBe(429);
    expect((await next.json()) as { dfr_code: string }).toMatchObject({ dfr_code: 'DFR_RATE_LIMITED' });
    controller.abort();
    await first.body?.cancel().catch(() => undefined);
  }, 15_000);

  it('GW-01: SSE header authentication uses the stream token bucket, not read bucket', async () => {
    const limiter = new TokenBucketLimiter({
      read: { capacity: 20, refillPerSecond: 20 },
      write: { capacity: 10, refillPerSecond: 2 },
      stream: { capacity: 1, refillPerSecond: 0.001 },
    });
    const base = await start({ limiter });
    const controller = new AbortController();
    const first = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet`, {
      headers: { 'x-dfr-key': KEY }, signal: controller.signal,
    });
    expect(first.status).toBe(200);
    const next = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet`, {
      headers: { 'x-dfr-key': KEY },
    });
    expect(next.status).toBe(429);
    controller.abort();
    await first.body?.cancel().catch(() => undefined);
  }, 15_000);

  it('GW-01: a valid one-time SSE ticket is also charged against the stream bucket', async () => {
    const tickets = new SseTicketStore();
    const limiter = new TokenBucketLimiter({
      read: { capacity: 20, refillPerSecond: 20 },
      write: { capacity: 10, refillPerSecond: 2 },
      stream: { capacity: 1, refillPerSecond: 0.001 },
    });
    const base = await start({ limiter, tickets });
    const filter = { chain: 'solana-devnet' as never };
    const firstTicket = tickets.issue({ projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter })!;
    const secondTicket = tickets.issue({ projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter })!;
    const controller = new AbortController();
    const first = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(firstTicket.ticket)}`, {
      signal: controller.signal,
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(secondTicket.ticket)}`);
    expect(second.status).toBe(429);
    controller.abort();
    await first.body?.cancel().catch(() => undefined);
  }, 15_000);
  it('a restricted-chain Key may not use a header to establish a global event stream', async () => {
    const base = await start({ chains: ['solana-devnet' as never] });
    const res = await fetch(`${base}/v1/events/subscribe`, { headers: { 'x-dfr-key': KEY } });
    if (res.status === 200) await res.body?.cancel();
    expect(res.status).toBe(403);
    expect((await res.json()) as { dfr_code: string }).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
  });

  it('consuming a ticket re-validates chains and the global filter against the current Key scope', async () => {
    const tickets = new SseTicketStore();
    const base = await start({ tickets, chains: ['solana-devnet' as never] });
    const cases = [
      [{}, ''],
      [{ chain: 'ethereum-sepolia' as never }, 'chain=ethereum-sepolia&'],
    ] as const;
    for (const [filter, chain] of cases) {
      const issued = tickets.issue({ projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter })!;
      const res = await fetch(`${base}/v1/events/subscribe?${chain}ticket=${encodeURIComponent(issued.ticket)}`);
      if (res.status === 200) await res.body?.cancel();
      expect(res.status).toBe(401);
      expect((await res.json()) as { dfr_code: string }).toMatchObject({ dfr_code: 'DFR_INVALID_TICKET' });
    }
  });

  it('a restricted-chain Key's authorized chains can still establish event streams via header and ticket', async () => {
    const tickets = new SseTicketStore();
    const base = await start({ tickets, chains: ['solana-devnet' as never] });
    const headerStream = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet`, {
      headers: { 'x-dfr-key': KEY },
    });
    expect(headerStream.status).toBe(200);
    await headerStream.body?.cancel();

    const issued = tickets.issue({
      projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never },
    })!;
    const ticketStream = await fetch(
      `${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(issued.ticket)}`,
    );
    expect(ticketStream.status).toBe(200);
    await ticketStream.body?.cancel();
  });

  it('when the issuing Key has been revoked from the current configuration, an unexpired ticket cannot establish an event stream either', async () => {
    const tickets = new SseTicketStore();
    const issued = tickets.issue({
      projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never },
    })!;
    const base = await start({ tickets, keyId: 'Rotated1' });
    const res = await fetch(
      `${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(issued.ticket)}`,
    );
    if (res.status === 200) await res.body?.cancel();
    expect(res.status).toBe(401);
    expect((await res.json()) as { dfr_code: string }).toMatchObject({ dfr_code: 'DFR_INVALID_TICKET' });
  });

  it('missing credential → 401', async () => {
    const base = await start();
    const res = await fetch(`${base}/v1/events/subscribe`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('AUTH-02: an SSE header subscription by a restricted API Key must specify an authorized chain', async () => {
    const base = await start({ chains: ['ethereum-sepolia' as never] });
    for (const suffix of ['', '?chain=solana-devnet']) {
      const response = await fetch(`${base}/v1/events/subscribe${suffix}`, {
        headers: { 'x-dfr-key': KEY },
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { dfr_code: string }).dfr_code).toBe('DFR_PROJECT_SCOPE_DENIED');
    }
    const controller = new AbortController();
    const ok = await fetch(`${base}/v1/events/subscribe?chain=ethereum-sepolia`, {
      headers: { 'x-dfr-key': KEY }, signal: controller.signal,
    });
    expect(ok.status).toBe(200);
    controller.abort();
  }, 15_000);

  it('AUTH-02: a legacy or internally issued over-privileged ticket cannot bypass existing chain permissions', async () => {
    const tickets = new SseTicketStore();
    const base = await start({ tickets, chains: ['ethereum-sepolia' as never] });
    for (const chain of ['solana-devnet', undefined] as const) {
      const filter = chain === undefined ? {} : { chain: chain as never };
      const issued = tickets.issue({ projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter })!;
      const chainQuery = chain === undefined ? '' : `chain=${chain}&`;
      const res = await fetch(
        `${base}/v1/events/subscribe?${chainQuery}ticket=${encodeURIComponent(issued.ticket)}`,
      );
      // Ticket bearer credentials intentionally return 401 without revealing current scope.
      expect(res.status).toBe(401);
      expect(((await res.json()) as { dfr_code: string }).dfr_code).toBe('DFR_INVALID_TICKET');
    }
  }, 15_000);

  it('header auth can establish a stream, and received frames are in SSE format (id/event/data)', async () => {
    const bus = new EventBus();
    const base = await start({ bus });
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet`, {
      headers: { 'x-dfr-key': KEY },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    bus.publish({ type: 'tx.finalized' as never, chain: 'solana-devnet' as never, payload: { n: 1 } });
    const events = await readEvents(res, 1);
    expect(events).toHaveLength(1);
    const event = events[0] as { type: string; cursor: string; payload: { n: number } };
    expect(event.type).toBe('tx.finalized');
    expect(event.cursor).toBe('1');
    expect(event.payload.n).toBe(1);
    controller.abort();
  }, 15_000);

  it('filter takes effect: only events for that chain are received', async () => {
    const bus = new EventBus();
    const base = await start({ bus });
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/subscribe?chain=solana-devnet`, {
      headers: { 'x-dfr-key': KEY },
      signal: controller.signal,
    });
    bus.publish({ type: 'tx.finalized' as never, chain: 'ethereum-sepolia' as never, payload: { chain: 'eth' } });
    bus.publish({ type: 'tx.finalized' as never, chain: 'solana-devnet' as never, payload: { chain: 'sol' } });
    const events = await readEvents(res, 1);
    expect(events).toHaveLength(1);
    expect((events[0] as { payload: { chain: string } }).payload.chain).toBe('sol');
    controller.abort();
  }, 15_000);

  it('ticket auth can establish a stream, and the ticket is consumed (a second connection fails with 401)', async () => {
    const bus = new EventBus();
    const tickets = new SseTicketStore();
    const base = await start({ bus, tickets });

    const issued = tickets.issue({
      projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never },
    })!;

    const controller = new AbortController();
    const ok = await fetch(
      `${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(issued.ticket)}`,
      { signal: controller.signal },
    );
    expect(ok.status).toBe(200);
    controller.abort();

    // Reconnecting with the same ticket: already consumed → 401 DFR_INVALID_TICKET.
    const reuse = await fetch(
      `${base}/v1/events/subscribe?chain=solana-devnet&ticket=${encodeURIComponent(issued.ticket)}`,
    );
    expect(reuse.status).toBe(401);
    const body = (await reuse.json()) as { dfr_code: string };
    expect(body.dfr_code).toBe('DFR_INVALID_TICKET');
  }, 15_000);

  it('a ticket's filter is bound: widening the filter in the URL cannot establish a stream', async () => {
    const tickets = new SseTicketStore();
    const base = await start({ tickets });
    const issued = tickets.issue({
      projectId: 'sse-sub', apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'solana-devnet' as never },
    })!;
    // The ticket binds chain=solana-devnet; connecting with types instead (different filter digest) → rejected.
    const res = await fetch(
      `${base}/v1/events/subscribe?chain=solana-devnet&types=tx.finalized&ticket=${encodeURIComponent(issued.ticket)}`,
    );
    expect(res.status).toBe(401);
    await res.body?.cancel();
  }, 15_000);

  it('no event bus assembled → 404 (deployment has no event stream), not 500', async () => {
    const server = createGatewayServer({ core, auth: auth() });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/events/subscribe?chain=solana-devnet`, {
      headers: { 'x-dfr-key': KEY },
    });
    expect(res.status).toBe(404);
    await res.body?.cancel();
  }, 15_000);
});
