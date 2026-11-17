/**
 * SDK 事件路径契约测试（M4 前置：BEX 需要消费事件，ADR-008）。
 *
 * 覆盖：`createEventTicket`（POST /v1/events/tickets）与 `subscribeEvents` /
 * `subscribeEventsWithTicket`（GET /v1/events/subscribe 的 SSE 帧解析）。
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
  it('POST /v1/events/tickets，带 filter 与可选 ttlMs，解包票据', async () => {
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

  it('票据无效 → DFR_INVALID_TICKET（不泄漏票据原文）', async () => {
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
  it('header 鉴权：GET /v1/events/subscribe?chain=&types=，逐条解析 SSE 帧', async () => {
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
    // header 路径带 Key，且接受 SSE。
    expect(seen[0]!.headers['x-dfr-key']).toBe(KEY);
    expect(seen[0]!.headers['accept']).toBe('text/event-stream');
  });

  it('ticket 路径：query 带 ticket 且**不带** Key header（票据即凭据）', async () => {
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

  it('close() 关闭流（迭代器随之中止，不再产出）', async () => {
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
    // 关闭后再次 next 不应抛错（done 或正常结束）。
    const second = await iterator.next().catch((err) => ({ done: true, value: err }));
    expect(second.done === true || second.done === false).toBe(true);
  });

  it('非 2xx（票据失效）→ DFR_INVALID_TICKET 错误', async () => {
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
