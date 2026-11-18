/**
 * M2-D02: SSE security negative-control acceptance.
 *
 * Completion gate (roadmap M2): "SSE ticket TTL / single-use / IP / filter binding".
 * C02/C03 already tested these properties separately; this file gathers them into **one executable acceptance
 * checklist**, ensuring every item of the completion gate has a corresponding failure path (not just "the happy
 * path works").
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

describe('M2-D02 SSE security negative controls', () => {
  it('TTL binding: issuance is capped, and an expired ticket cannot be consumed', () => {
    let clock = 1_000_000;
    const s = new SseTicketStore({ now: () => clock, newTicket: () => 't' });
    expect(() => s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: SSE_TICKET_MAX_TTL_MS + 1 }))
      .toThrow(RangeError);
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: 1_000 })!;
    clock += 1_001;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
  });

  it('single-use: replaying the same ticket fails', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('ok');
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind, 'replay must fail').toBe('invalid');
  });

  it('IP binding: consuming from a different IP fails', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: KEY, ip: '198.51.100.9', filter: FILTER }).kind).toBe('invalid');
  });

  it('filter binding: widening the subscription scope fails', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    const widened = { ...FILTER, types: ['tx.finalized' as never] };
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: KEY, ip: IP, filter: widened }).kind).toBe('invalid');
  });

  it('use under a different Key fails (when a header is provided)', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, apiKeyId: OTHER_KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
  });

  it('browser scenario (no apiKeyId provided): IP and filter must still match', () => {
    const s = store();
    const t = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    // Ticket only, no header: the ticket itself is the credential, but IP is still constrained.
    expect(s.consume({ projectId: 'test-project', ticket: t.ticket, ip: '198.51.100.9', filter: FILTER }).kind).toBe('invalid');

    const t2 = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: t2.ticket, ip: IP, filter: FILTER }).kind).toBe('ok');
  });

  it('IP resolution cannot be forged: X-Forwarded-For is not trusted when no trusted proxy is configured', () => {
    expect(clientIp({ remoteAddress: IP, forwardedFor: '9.9.9.9', trustedProxies: [] })).toBe(IP);
    // Likewise not trusted when the direct peer is not in the trusted list.
    expect(clientIp({ remoteAddress: IP, forwardedFor: '9.9.9.9', trustedProxies: ['10.0.0.1'] })).toBe(IP);
  });

  it('failure semantics are uniform: expired / used / not-found are not distinguished (to prevent enumeration)', () => {
    const s = store();
    const used = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    s.consume({ projectId: 'test-project', ticket: used.ticket, apiKeyId: KEY, ip: IP, filter: FILTER });
    const results = [
      s.consume({ projectId: 'test-project', ticket: used.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind, // used
      s.consume({ projectId: 'test-project', ticket: 'never-issued', apiKeyId: KEY, ip: IP, filter: FILTER }).kind, // not found
    ];
    expect(new Set(results)).toEqual(new Set(['invalid']));
  });
});
