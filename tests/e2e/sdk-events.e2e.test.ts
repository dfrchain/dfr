/**
 * SDK events surface offline E2E (DFR-M4-C04).
 *
 * Chain: SDK → real Gateway (/v1/events/tickets + /v1/events/subscribe) → real EventBus.
 * Proves the SDK's new event methods are not just correct against a mock, but can really establish an SSE stream and consume events.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import { EventBus } from '@dfr/events';
import { createGatewayServer, hashSecret } from '@dfr/gateway';
import { SseTicketStore } from '../../apps/gateway/src/sse-ticket.js';
import { DFR } from '@dfr/sdk-typescript';

const SECRET = 'sdkEventsE2eSecret0123456789ab';
const PEPPER = 'sdk-events-e2e-pepper';
const KEY_ID = 'SdkEvent';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const CHAIN = 'solana-devnet';

const core = {
  listChains: () => [],
  startHealthChecks: () => ({ started: 0, skipped: 0 }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

let server: Server | undefined;
let bus: EventBus;
let tickets: SseTicketStore;
let dfr: DFR;

beforeAll(async () => {
  bus = new EventBus();
  tickets = new SseTicketStore();
  const created = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'sdk-events-e2e',
      scope: { chains: '*', capabilities: '*', allowWrite: true },
    },
    eventBus: bus,
    sseTickets: tickets,
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  const { port } = created.address() as AddressInfo;
  dfr = new DFR({ apiKey: KEY, baseUrl: `http://127.0.0.1:${port}` });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('SDK events surface E2E (M4-C04)', () => {
  it('createEventTicket really issues a ticket (201), returning ticket/expiresAt', async () => {
    const result = await dfr.createEventTicket({ filter: { chain: CHAIN as never }, ttlMs: 30_000 });
    expect(typeof result.ticket).toBe('string');
    expect(result.ticket.length).toBeGreaterThan(0);
    expect(typeof result.expiresAt).toBe('string');
  });

  it('header-authenticated subscription: the SDK receives events really published by the EventBus', async () => {
    const { events, close } = dfr.subscribeEvents({ chain: CHAIN as never });
    const iterator = events[Symbol.asyncIterator]();
    // Publish after establishing the connection (the EventBus is a live stream and does not replay historical frames).
    await new Promise((resolve) => setTimeout(resolve, 150));
    bus.publish({ type: 'tx.finalized' as never, chain: CHAIN as never, payload: { marked: 'header-path' } });
    let matched: { type: string; payload: { marked?: string } } | undefined;
    for (let i = 0; i < 10 && matched === undefined; i += 1) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value as { type: string; payload: { marked?: string } };
      if (event.payload?.marked === 'header-path') matched = event;
    }
    close();
    expect(matched?.type).toBe('tx.finalized');
  }, 15_000);

  it('ticket subscription: the SDK uses a ticket to establish a stream and consume events (without a Key header)', async () => {
    const issued = await dfr.createEventTicket({ filter: { chain: CHAIN as never } });
    const { events, close } = dfr.subscribeEventsWithTicket(issued.ticket, { chain: CHAIN as never });
    const iterator = events[Symbol.asyncIterator]();
    await new Promise((resolve) => setTimeout(resolve, 150));
    bus.publish({ type: 'tx.confirmed' as never, chain: CHAIN as never, payload: { marked: 'ticket-path' } });
    // A subscription delivers from the start of the session (including frames published earlier), so pick this run's event by its payload marker.
    let matched: { type: string; payload: { marked?: string } } | undefined;
    for (let i = 0; i < 10 && matched === undefined; i += 1) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value as { type: string; payload: { marked?: string } };
      if (event.payload?.marked === 'ticket-path') matched = event;
    }
    expect(matched?.type).toBe('tx.confirmed');
    close();
  }, 15_000);

  it('invalid ticket → DFR_INVALID_TICKET (without leaking the ticket itself)', async () => {
    const { events } = dfr.subscribeEventsWithTicket('tk_definitely_invalid', { chain: CHAIN as never });
    await expect(
      (async () => { for await (const e of events) { void e; } })(),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_TICKET' });
  }, 15_000);
});
