/**
 * SDK event-path contract tests (M4 prerequisite: BEX needs to consume events, ADR-008).
 *
 * Covers: `createEventTicket` (POST /v1/events/tickets) and `subscribeEvents` /
 * `subscribeEventsWithTicket` (SSE frame parsing for GET /v1/events/subscribe).
 */
import { describe, expect, it } from 'vitest';
import { DFR, isDfrApiError } from '../src/index.js';

const BASE = 'https://gateway.example';
const KEY = 'dfr_EventsKey_secret0123456789abcdef';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function capture(
  handler: (call: Captured) => Response | Promise<Response>,
  seen: Captured[],
): typeof fetch {
  return async (input, init) => {
    const call: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    seen.push(call);
    return handler(call);
  };
}

function sseResponse(frames: readonly string[]): Response {
  const body = frames.map((f) => `${f}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function event(id: string, type: string): string {
  return `data: ${JSON.stringify({
    eventId: id, cursor: id, type, chain: 'ethereum-sepolia',
    payload: { status: 'built' }, schemaVersion: '1', occurredAt: '2026-10-06T00:00:00Z',
  })}`;
}

describe('SDK createEventTicket', () => {
  it('POST /v1/events/tickets, with filter and optional ttlMs, unpacking the ticket', async () => {
    const seen: Captured[] = [];
    const client = new DFR({
      apiKey: KEY, baseUrl: BASE,
      fetchImpl: capture(() => jsonResponse(201, { ticket: 'tk_1', expiresAt: '2026-10-06T00:00:30Z', requestId: 'req_1' }), seen),
    });
    const result = await client.createEventTicket({ filter: { chain: 'ethereum-sepolia' as never, types: ['tx.finalized' as never] }, ttlMs: 30_000 });
    expect(result.ticket).toBe('tk_1');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe(`${BASE}/v1/events/tickets`);
    expect(seen[0]!.headers['x-dfr-key']).toBe(KEY);
    expect(JSON.parse(seen[0]!.body!)).toEqual({ filter: { chain: 'ethereum-sepolia', types: ['tx.finalized'] }, ttlMs: 30000 });
  });

  it('invalid ticket → DFR_INVALID_TICKET (without leaking the raw ticket)', async () => {
    const client = new DFR({
      apiKey: KEY, baseUrl: BASE,
      fetchImpl: capture(() => jsonResponse(401, { dfr_code: 'DFR_INVALID_TICKET', detail: 'invalid ticket', request_id: 'req_x' }), []),
    });
    try {
      await client.createEventTicket({ filter: {} });
      throw new Error('expected failure');
    } catch (err) {
      expect(isDfrApiError(err)).toBe(true);
      expect((err as { code: string }).code).toBe('DFR_INVALID_TICKET');
      expect((err as Error).message).not.toContain('tk_');
    }
  });
});

describe('SDK subscribeEvents', () => {
  it('header auth: GET /v1/events/subscribe?chain=&types=, parsing SSE frames one by one', async () => {
    const seen: Captured[] = [];
    const client = new DFR({
      apiKey: KEY, baseUrl: BASE,
      fetchImpl: capture(
        () => sseResponse([': heartbeat', event('c1', 'tx.built'), event('c2', 'tx.finalized')]),
        seen,
      ),
    });
    const { events } = client.subscribeEvents({ chain: 'ethereum-sepolia' as never, types: ['tx.finalized' as never] });
    const got: string[] = [];
    for await (const e of events) got.push(`${e.eventId}:${e.type}`);
    expect(got).toEqual(['c1:tx.built', 'c2:tx.finalized']);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url).toContain('/v1/events/subscribe?');
    expect(seen[0]!.url).toContain('chain=ethereum-sepolia');
    expect(seen[0]!.url).toContain('types=tx.finalized');
    // The header path carries a Key and accepts SSE.
    expect(seen[0]!.headers['x-dfr-key']).toBe(KEY);
    expect(seen[0]!.headers['accept']).toBe('text/event-stream');
  });

  it('ticket path: query carries a ticket and **no** Key header (the ticket is the credential)', async () => {
    const seen: Captured[] = [];
    const client = new DFR({
      apiKey: KEY, baseUrl: BASE,
      fetchImpl: capture(() => sseResponse([event('c1', 'tx.built')]), seen),
    });
    const { events } = client.subscribeEventsWithTicket('tk_abc', { chain: 'ethereum-sepolia' as never });
    const got: string[] = [];
    for await (const e of events) got.push(e.eventId);
    expect(got).toEqual(['c1']);
    expect(seen[0]!.url).toContain('ticket=tk_abc');
    expect(seen[0]!.headers['x-dfr-key']).toBeUndefined();
  });

  it('close() closes the stream (the iterator aborts with it and yields no more)', async () => {
    const client = new DFR({
      apiKey: KEY, baseUrl: BASE,
      fetchImpl: capture(
        (_call) => sseResponse([event('c1', 'tx.built')]),
        [],
      ),
    });
    const { events, close } = client.subscribeEvents({});
    const iterator = events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    close();
    // Calling next again after closing must not throw (done or a normal end).
    const second = await iterator.next().catch((err) => ({ done: true, value: err }));
    expect(second.done === true || second.done === false).toBe(true);
  });

  it('non-2xx (expired ticket) → DFR_INVALID_TICKET error', async () => {
    const client = new DFR({
      apiKey: KEY, baseUrl: BASE,
      fetchImpl: capture(
        () => jsonResponse(401, { dfr_code: 'DFR_INVALID_TICKET', detail: 'bad ticket' }),
        [],
      ),
    });
    const { events } = client.subscribeEventsWithTicket('tk_bad', { chain: 'ethereum-sepolia' as never });
    await expect((async () => { for await (const _event of events) { void _event; } })()).rejects.toMatchObject({ code: 'DFR_INVALID_TICKET' });
  });
});
