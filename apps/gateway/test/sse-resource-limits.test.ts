/**
 * SSE long-connection capacity and writable backpressure controls.
 * These tests do not require a database or network providers.
 */
import { EventEmitter } from 'node:events';
import type { ServerResponse, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { DfrCore } from '@dfr/core';
import { EventBus } from '@dfr/events';
import { hashSecret, createGatewayServer } from '../src/index.js';
import { TokenBucketLimiter } from '../src/ratelimit.js';
import { SseTicketStore } from '../src/sse-ticket.js';
import {
  SSE_MAX_FRAME_BYTES,
  SSE_MAX_CONNECTIONS_PER_KEY,
  SseConnectionRegistry,
  createSseWriter,
} from '../src/sse-stream.js';

const SECRET = 'sseBackpressure0123456789Testing';
const KEY_ID = 'SseQKey1';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const PEPPER = 'sse-backpressure-pepper';
const core = {
  listChains: () => [],
  startHealthChecks: () => ({ started: 0, skipped: 0 }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

function fakeResponse(options: { backpressure?: boolean } = {}) {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  let destroyed = false;
  let ended = false;
  const res = Object.assign(emitter, {
    writableLength: 0,
    write: (value: string) => {
      sent.push(value);
      return !options.backpressure;
    },
    destroy: () => {
      destroyed = true;
      emitter.emit('close');
    },
    end: () => { ended = true; emitter.emit('close'); },
  }) as unknown as ServerResponse;
  return { res, sent, wasDestroyed: () => destroyed, wasEnded: () => ended };
}

describe('SSE writable backpressure', () => {
  const event = (payload: unknown) => ({
    cursor: '1', type: 'tx.finalized', payload,
  }) as never;

  it('a writable that returns false is destroyed immediately, subsequent writes are ignored', () => {
    const fake = fakeResponse({ backpressure: true });
    const writer = createSseWriter(fake.res);
    writer.write(event({ ok: true }));
    expect(writer.closed).toBe(true);
    expect(fake.wasDestroyed()).toBe(true);
    expect(fake.sent).toHaveLength(1);
    writer.keepAlive();
    writer.write(event({ second: true }));
    expect(fake.sent).toHaveLength(1);
  });

  it('oversized event frame is rejected before writing to the socket', () => {
    const fake = fakeResponse();
    const writer = createSseWriter(fake.res);
    writer.write(event({ blob: 'a'.repeat(SSE_MAX_FRAME_BYTES) }));
    expect(writer.closed).toBe(true);
    expect(fake.wasDestroyed()).toBe(true);
    expect(fake.sent).toHaveLength(0);
  });

  it('normal small events still serialize and end cleanly', () => {
    const fake = fakeResponse();
    const writer = createSseWriter(fake.res);
    writer.write(event({ n: 1 }));
    expect(fake.sent[0]).toContain('event: tx.finalized');
    writer.end();
    expect(fake.wasEnded()).toBe(true);
    expect(writer.closed).toBe(true);
  });
});

describe('SSE live-connection registry', () => {
  it('limits each key and server; release is idempotent', () => {
    const slots = new SseConnectionRegistry(2, 3);
    const releaseA1 = slots.acquire('a');
    const releaseA2 = slots.acquire('a');
    expect(releaseA1).not.toBeNull();
    expect(releaseA2).not.toBeNull();
    expect(slots.acquire('a')).toBeNull();
    const releaseB = slots.acquire('b');
    expect(releaseB).not.toBeNull();
    expect(slots.acquire('c')).toBeNull();
    releaseA1?.();
    releaseA1?.();
    expect(slots.activeConnections).toBe(2);
    expect(slots.countFor('a')).toBe(1);
    const releaseC = slots.acquire('c');
    expect(releaseC).not.toBeNull();
    releaseA2?.();
    releaseB?.();
    releaseC?.();
    expect(slots.activeConnections).toBe(0);
    expect(slots.countFor('a')).toBe(0);
  });
});

const servers: Server[] = [];
const aborters: AbortController[] = [];
afterEach(async () => {
  for (const controller of aborters.splice(0)) controller.abort();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startServer(tickets: SseTicketStore) {
  const limiter = new TokenBucketLimiter({
    read: { capacity: 100, refillPerSecond: 100 },
    write: { capacity: 100, refillPerSecond: 100 },
    stream: { capacity: 100, refillPerSecond: 100 },
  });
  const server = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID, currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER, projectId: 'sse-resource',
      scope: { chains: '*', capabilities: '*', allowWrite: false },
    },
    limiter,
    eventBus: new EventBus(),
    sseTickets: tickets,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('SSE gateway admission integration', () => {
  it('header streams exhaust the per-key limit and ticket subscriptions cannot bypass it', async () => {
    const tickets = new SseTicketStore();
    const base = await startServer(tickets);
    const streams: Response[] = [];
    for (let i = 0; i < SSE_MAX_CONNECTIONS_PER_KEY; i++) {
      const controller = new AbortController();
      aborters.push(controller);
      const res = await fetch(`${base}/v1/events/subscribe?chain=ethereum-sepolia`, {
        headers: { 'x-dfr-key': KEY }, signal: controller.signal,
      });
      expect(res.status).toBe(200);
      streams.push(res);
    }

    const ninth = await fetch(`${base}/v1/events/subscribe?chain=ethereum-sepolia`, {
      headers: { 'x-dfr-key': KEY },
    });
    expect(ninth.status).toBe(429);
    await ninth.body?.cancel();

    const issued = tickets.issue({
      projectId: 'sse-resource',
      apiKeyId: KEY_ID, ip: '127.0.0.1', filter: { chain: 'ethereum-sepolia' as never },
    })!;
    const blockedTicket = await fetch(
      `${base}/v1/events/subscribe?chain=ethereum-sepolia&ticket=${encodeURIComponent(issued.ticket)}`,
    );
    expect(blockedTicket.status).toBe(429);
    await blockedTicket.body?.cancel();

    // A disconnected stream releases its slot. Node delivers close
    // asynchronously; allow one turn for the response close listener.
    aborters[0]?.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const again = new AbortController();
    aborters.push(again);
    const reopened = await fetch(`${base}/v1/events/subscribe?chain=ethereum-sepolia`, {
      headers: { 'x-dfr-key': KEY }, signal: again.signal,
    });
    expect(reopened.status).toBe(200);
    for (const res of streams) await res.body?.cancel().catch(() => undefined);
    await reopened.body?.cancel().catch(() => undefined);
  }, 20_000);
});
