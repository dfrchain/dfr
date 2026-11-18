/**
 * SSE single-use ticket test (M2-C02, ADR-029).
 *
 * This is a **security boundary** test: once a ticket becomes replayable, usable across Keys, or its TTL silently enlargeable,
 * it is equivalent to leaking a long-lived credential's power to a URL. Each assertion corresponds to one hard constraint in ADR-029.
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

describe('SseTicketStore issuance (M2-C02)', () => {
  it('default TTL 30s, returns an opaque ticket and an ISO8601 expiry time', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(issued.ticket).toMatch(/^ticket_\d+$/u);
    const ttl = Date.parse(issued.expiresAt) - 1_000_000;
    expect(ttl).toBe(SSE_TICKET_DEFAULT_TTL_MS);
  });

  it('a ticket generation-value collision fails closed, and cannot overwrite another Key's unconsumed ticket', () => {
    const s = new SseTicketStore({ now: () => 1_000_000, newTicket: () => 'same_ticket' });
    const first = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(first.ticket).toBe('same_ticket');
    expect(s.issue({ projectId: 'test-project', apiKeyId: OTHER_KEY, ip: '198.51.100.4', filter: FILTER })).toBeNull();
    expect(s.size).toBe(1);
    expect(s.consume({ projectId: 'test-project', ticket: first.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('ok');
  });

  it('TTL above the cap → RangeError (no silent truncation)', () => {
    const { store: s } = store();
    expect(() => s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: SSE_TICKET_MAX_TTL_MS + 1 }))
      .toThrow(RangeError);
    expect(() => s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: 0 })).toThrow(RangeError);
    expect(() => s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: -1 })).toThrow(RangeError);
  });

  it('the boundary value 60s is allowed', () => {
    const { store: s } = store();
    expect(s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: SSE_TICKET_MAX_TTL_MS })).not.toBeNull();
  });

  it('a single Key exceeding the unconsumed ticket cap → issuance fails (null), mapped to rate limiting by the caller', async () => {
    const { store: s } = store({ max: 2 });
    expect(s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })).not.toBeNull();
    expect(s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })).not.toBeNull();
    expect(s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER }), 'exceeding the cap should fail').toBeNull();
    // Other Keys are unaffected.
    expect(s.issue({ projectId: 'test-project', apiKeyId: OTHER_KEY, ip: IP, filter: FILTER })).not.toBeNull();
  });
});

describe('SseTicketStore consumption (single-use + binding)', () => {
  it('normal consumption returns the filter from issuance', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    const result = s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER });
    expect(result).toMatchObject({ kind: 'ok', ticket: { apiKeyId: KEY, filter: FILTER } });
  });

  it('using the same ticket a second time → invalid (single-use)', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('ok');
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind, 'replay must fail').toBe('invalid');
  });

  it('concurrent consumption has only one winner (atomicity)', () => {
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

  it('using the same ticket with a different Key → invalid (bound to apiKeyId)', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: OTHER_KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
  });

  it('using the same ticket from a different IP → invalid (bound to client IP)', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: '198.51.100.9', filter: FILTER }).kind).toBe('invalid');
  });

  it('a widened filter cannot consume (bound to the filter digest; only as-is)', () => {
    const { store: s } = store();
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER })!;
    const widened = { ...FILTER, types: ['tx.finalized' as never] };
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: widened }).kind).toBe('invalid');
  });

  it('an expired ticket → invalid, and already reclaimed', () => {
    let clock = 1_000_000;
    const s = new SseTicketStore({ now: () => clock, newTicket: () => 'ticket_x' });
    const issued = s.issue({ projectId: 'test-project', apiKeyId: KEY, ip: IP, filter: FILTER, ttlMs: 1_000 })!;
    clock += 1_001;
    expect(s.consume({ projectId: 'test-project', ticket: issued.ticket, apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
    expect(s.size).toBe(0);
  });

  it('an unknown ticket → invalid (not distinguishing not-found / expired / used, to avoid enumeration)', () => {
    const { store: s } = store();
    expect(s.consume({ projectId: 'test-project', ticket: 'nope', apiKeyId: KEY, ip: IP, filter: FILTER }).kind).toBe('invalid');
  });
});

describe('filter digests and client IPs', () => {
  it('the digest is independent of key order, but sensitive to content changes', () => {
    const a = digestFilter({ chain: 'solana-devnet' as never, types: ['tx.finalized' as never] });
    const b = digestFilter({ types: ['tx.finalized' as never], chain: 'solana-devnet' as never });
    expect(a).toBe(b);
    expect(digestFilter({ chain: 'solana-devnet' as never })).not.toBe(a);
  });

  it('X-Forwarded-For is not trusted by default (take the direct peer)', () => {
    expect(clientIp({ remoteAddress: IP, forwardedFor: '1.2.3.4', trustedProxies: [] })).toBe(IP);
  });

  it('when a trusted proxy exists, take the last XFF hop; when the direct peer is untrusted, still take the direct peer', () => {
    expect(clientIp({ remoteAddress: '10.0.0.1', forwardedFor: '9.9.9.9, 8.8.8.8', trustedProxies: ['10.0.0.1'] }))
      .toBe('8.8.8.8');
    expect(clientIp({ remoteAddress: IP, forwardedFor: '9.9.9.9', trustedProxies: ['10.0.0.1'] }), 'an untrusted direct peer means XFF is not trusted')
      .toBe(IP);
  });
});
