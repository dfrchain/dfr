/**
 * SSE 一次性票据测试（M2-C02，ADR-029）。
 *
 * 这是**安全边界**测试：票据一旦可重放、可跨 Key 使用、或 TTL 可被静默放大，
 * 就等于把长期凭证的能力泄漏给了 URL。每条断言对应 ADR-029 的一条硬约束。
 */
import { describe, expect, it } from 'vitest';
import {
  SSE_TICKET_DEFAULT_TTL_MS,
  SSE_TICKET_MAX_TTL_MS,
  SseTicketStore,
  clientIp,
  digestFilter,
} from '../src/sse-ticket.js';

const KEY = 'KeyAAAAA';
const OTHER_KEY = 'KeyBBBBB';
const IP = '203.0.113.5';

function store(options: { now?: () => number; max?: number } = {}): {
  store: SseTicketStore;
  advance: (ms: number) => void;
} {
  let clock = 1_000_000;
  const s = new SseTicketStore({
    now: () => (options.now ? options.now() : clock),
    newTicket: (() => {
      let n = 0;
      return () => `ticket_${++n}`;
    })(),
    ...(options.max !== undefined ? { maxOutstandingPerKey: options.max } : {}),
  });
  return { store: s, advance: (ms) => { clock += ms; } };
}

const FILTER = { chain: 'solana-devnet' as never };

describe('SseTicketStore 签发（M2-C02）', () => {
  it('默认 TTL 30s，返回不透明票据与 ISO8601 过期时间', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(issued.ticket).toMatch(/^ticket_\d+$/u);
    const ttl = Date.parse(issued.expiresAt) - 1_000_000;
    expect(ttl).toBe(SSE_TICKET_DEFAULT_TTL_MS);
  });

  it('票据生成值碰撞时 fail-closed，不能覆盖其他 Key 尚未消费的票据', () => {
    const s = new SseTicketStore({ now: () => 1_000_000, newTicket: () => 'same_ticket' });
    const first = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(first.ticket).toBe('same_ticket');
    expect(s.issue({ projectId: 'test-project', apiKeyId: OTHER_KEY, ip: '198.51.100.4', filter: FILTER })).toBeNull();
    expect(s.size).toBe(1);
    expect(s.consume({ projectId: 'test-project', ticket: first.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('ok');
  });

  it('TTL 超过上限 → RangeError（不静默截断）', () => {
    const { store: s } = store();
    expect(() => s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: SSE_TICKET_MAX_TTL_MS + 1 }))
      .toThrow(RangeError);
    expect(() => s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: 0 })).toThrow(RangeError);
    expect(() => s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: -1 })).toThrow(RangeError);
  });

  it('边界值 60s 允许', () => {
    const { store: s } = store();
    expect(s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: SSE_TICKET_MAX_TTL_MS })).not.toBeNull();
  });

  it('单 Key 未消费票据超限 → 签发失败（null），由调用方映射为限流', () => {
    const { store: s } = store({ max: 2 });
    expect(s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })).not.toBeNull();
    expect(s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })).not.toBeNull();
    expect(s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER }), '超出上限应失败').toBeNull();
    // 其他 Key 不受影响。
    expect(s.issue({ projectId: 'test-project', apiKeyId: OTHER_KEY, ip: IP, filter: FILTER })).not.toBeNull();
  });
});

describe('SseTicketStore 消费（单次 + 绑定）', () => {
  it('正常消费返回签发时的 filter', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    const result = s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER });
    expect(result).toMatchObject({ kind: 'ok', ticket: { apiKeyId: KEY, filter: FILTER } });
  });

  it('同一票据第二次使用 → invalid（单次消费）', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('ok');
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind, '重放必须失败').toBe('invalid');
  });

  it('并发消费只有一个赢家（原子性）', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    const results = [
      s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind,
      s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind,
      s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind,
    ];
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'invalid')).toHaveLength(2);
  });

  it('换 Key 使用同一票据 → invalid（绑定 apiKeyId）', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: OTHER_KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
  });

  it('换 IP 使用同一票据 → invalid（绑定客户端 IP）', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: '198.51.100.9', filter: FILTER }).kind).toBe('invalid');
  });

  it('扩大 filter 无法消费（绑定 filter 摘要，只能原样）', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    const widened = { ...FILTER, types: ['tx.finalized' as never] };
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: widened }).kind).toBe('invalid');
  });

  it('过期票据 → invalid，且已被回收', () => {
    let clock = 1_000_000;
    const s = new SseTicketStore({ now: () => clock, newTicket: () => 'ticket_x' });
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: 1_000 })!;
    clock += 1_001;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
    expect(s.size).toBe(0);
  });

  it('未知票据 → invalid（不区分未找到/过期/已用，避免枚举）', () => {
    const { store: s } = store();
    expect(s.consume({ projectId: 'test-project', ticket: 'nope', apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
  });
});

describe('filter 摘要与客户端 IP', () => {
  it('摘要与键顺序无关，但对内容变化敏感', () => {
    const a = digestFilter({ chain: 'solana-devnet' as never, types: ['tx.finalized' as never] });
    const b = digestFilter({ types: ['tx.finalized' as never], chain: 'solana-devnet' as never });
    expect(a).toBe(b);
    expect(digestFilter({ chain: 'solana-devnet' as never })).not.toBe(a);
  });

  it('默认不信任 X-Forwarded-For（取直连对端）', () => {
    expect(clientIp({ remoteAddress: IP, forwardedFor: '1.2.3.4', trustedProxies: [] })).toBe(IP);
  });

  it('可信代理存在时取 XFF 最后一跳；直连对端不可信时仍取直连', () => {
    expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: '9.9.9.9, 8.8.8.8', trustedProxies: ['10.0.0.1'] }))
      .toBe('8.8.8.8');
    expect(clientIp({ remoteAddress: IP, forwardedFor: '9.9.9.9', trustedProxies: ['10.0.0.1'] }), '直连不可信则不采信 XFF')
      .toBe(IP);
  });
});
