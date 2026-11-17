/**
 * M2-D02：SSE 安全负对照验收。
 *
 * 完成门（roadmap M2）："SSE ticket TTL/单次/IP/filter 绑定"。
 * C02/C03 已分别测过这些属性；本文件把它们收拢为**一条可执行的验收清单**，
 * 确保完成门的每一项都有对应的失败路径（而不只是"正向能跑通"）。
 */
import { describe, expect, it } from 'vitest';
import { SSE_TICKET_MAX_TTL_MS, SseTicketStore, clientIp } from '../../apps/gateway/src/sse-ticket.js';

const KEY = 'KeyAAAAA';
const OTHER_KEY = 'KeyBBBBB';
const IP = '203.0.113.5';
const FILTER = { chain: 'solana-devnet' as never };

function store(): SseTicketStore {
  let n = 0;
  return new SseTicketStore({ now: () => 1_000_000, newTicket: () => `t${++n}` });
}

describe('M2-D02 SSE 安全负对照', () => {
  it('TTL 绑定：签发受上限约束，过期后不可消费', () => {
    let clock = 1_000_000;
    const s = new SseTicketStore({ now: () => clock, newTicket: () => 't' });
    expect(() => s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: SSE_TICKET_MAX_TTL_MS + 1 }))
      .toThrow(RangeError);
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: 1_000 })!;
    clock += 1_001;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
  });

  it('单次消费：重放同一票据失败', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('ok');
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind, '重放必须失败').toBe('invalid');
  });

  it('IP 绑定：换 IP 消费失败', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: KEY, ip: '198.51.100.9', filter: FILTER }).kind).toBe('invalid');
  });

  it('filter 绑定：扩大订阅范围失败', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    const widened = { ...FILTER, types: ['tx.finalized' as never] };
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: KEY, ip: IP, filter: widened }).kind).toBe('invalid');
  });

  it('跨 Key 使用失败（提供了 header 时）', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: OTHER_KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
  });

  it('浏览器场景（不提供 apiKeyId）：IP 与 filter 仍必须匹配', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    // 只有票据、无 header：票据本身即凭证，但 IP 仍受约束。
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, ip: '198.51.100.9', filter: FILTER }).kind).toBe('invalid');

    const t2 = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: t2.ticket, ip: IP, filter: FILTER }).kind).toBe('ok');
  });

  it('IP 取址不可被伪造：未配置可信代理时不采信 X-Forwarded-For', () => {
    expect(clientIp({ remoteAddress: IP, forwardedFor: '9.9.9.9', trustedProxies: [] })).toBe(IP);
    // 直连对端不在可信列表时，同样不采信。
    expect(clientIp({ remoteAddress: IP, forwardedFor: '9.9.9.9', trustedProxies: ['10.0.0.1'] })).toBe(IP);
  });

  it('失败语义统一：不区分过期/已用/未找到（避免枚举）', () => {
    const s = store();
    const used = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    s.consume({ projectId: 'test-project', ticket: used.ticket, apiKeyId: KEY, ip: IP, filter: FILTER });
    const results = [
      s.consume({ projectId: 'test-project', ticket: used.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind, // 已用
      s.consume({ projectId: 'test-project', ticket: 'never-issued', apiKeyId: KEY, ip: IP, filter: FILTER }).kind, // 未找到
    ];
    expect(new Set(results)).toEqual(new Set(['invalid']));
  });
});
