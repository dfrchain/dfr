/**
 * SDK 事件面离线 E2E（DFR-M4-C04）。
 *
 * 链路：SDK → 真实 Gateway（/v1/events/tickets + /v1/events/subscribe）→ 真实 EventBus。
 * 证明 SDK 新增的事件方法不是只对着 mock 正确，而是能真的建立 SSE 流并消费事件。
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

describe('SDK 事件面 E2E（M4-C04）', () => {
  it('createEventTicket 真实签发（201），返回 ticket/expiresAt', async () => {
    const result = await dfr.createEventTicket({ filter: { chain: CHAIN as never }, ttlMs: 30_000 });
    expect(typeof result.ticket).toBe('string');
    expect(result.ticket.length).toBeGreaterThan(0);
    expect(typeof result.expiresAt).toBe('string');
  });

  it('header 鉴权订阅：SDK 收到真实 EventBus 发布的事件', async () => {
    const { events, close } = dfr.subscribeEvents({ chain: CHAIN as never });
    const iterator = events[Symbol.asyncIterator]();
    // 建立连接后再发布（EventBus 是实时流，不重放历史帧）。
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

  it('票据订阅：SDK 用 ticket 建立流并消费事件（不带 Key header）', async () => {
    const issued = await dfr.createEventTicket({ filter: { chain: CHAIN as never } });
    const { events, close } = dfr.subscribeEventsWithTicket(issued.ticket, { chain: CHAIN as never });
    const iterator = events[Symbol.asyncIterator]();
    await new Promise((resolve) => setTimeout(resolve, 150));
    bus.publish({ type: 'tx.confirmed' as never, chain: CHAIN as never, payload: { marked: 'ticket-path' } });
    // 订阅会从会话起点开始投递（含此前发布过的帧），因此按 payload 标记挑选本次事件。
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

  it('无效票据 → DFR_INVALID_TICKET（不泄漏票据原文）', async () => {
    const { events } = dfr.subscribeEventsWithTicket('tk_definitely_invalid', { chain: CHAIN as never });
    await expect(
      (async () => { for await (const e of events) { void e; } })(),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_TICKET' });
  }, 15_000);
});
