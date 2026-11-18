import { describe, expect, it } from 'vitest';
import type { IdempotencyRecord, IdempotencyStore } from '@dfr/transaction';
import type { ChainId, Iso8601 } from '@dfr/types';
import { GatewayIdempotencyCoordinator, canonicalJson, fingerprintRequest } from '../src/idempotency.js';

describe('GatewayIdempotencyCoordinator', () => {
  it('sorts by key and ignores undefined, keeping array order unchanged', () => {
    expect(canonicalJson({ b: 1, a: undefined, c: { z: 2, y: 1 }, list: [2, 1] }))
      .toBe('{"b":1,"c":{"y":1,"z":2},"list":[2,1]}');
    expect(fingerprintRequest({ a: 1, b: 2 })).toBe(fingerprintRequest({ b: 2, a: 1 }));
  });

  it('normalized JSON keys sort by UTF-16 code unit, not locale collation', () => {
    // RFC 8785 property ordering must not vary with server locale/ICU data.
    expect(canonicalJson({ a: 2, Z: 1 })).toBe('{"Z":1,"a":2}');
    expect(canonicalJson({ 'ä': 2, z: 1 })).toBe('{"z":1,"ä":2}');
    // JS object enumeration always reorders integer-like names; the wire
    // serializer must not inherit that enumeration order.
    expect(canonicalJson({ '2': 2, '10': 10 })).toBe('{"10":10,"2":2}');
    expect(canonicalJson({ list: [undefined, 2], nested: { b: undefined, a: 1 } }))
      .toBe('{"list":[null,2],"nested":{"a":1}}');
  });

  it('only delegates to the Store, keeping the acquired/replayed/conflict/in_flight decisions', async () => {
    const calls: unknown[] = [];
    const record = { scope: { projectId: 'p', chain: 'ethereum-sepolia' as ChainId, key: 'k' }, fingerprint: 'f', state: 'in_flight' as const, ownerToken: 'o', leaseExpiresAt: '2026-01-01T00:00:00.000Z' as Iso8601, expiresAt: '2026-01-02T00:00:00.000Z' as Iso8601 } satisfies IdempotencyRecord;
    const store: IdempotencyStore = {
      begin: async (input) => {
        calls.push(input);
        return { kind: 'in_flight' as const, record, retryAfterMs: 42 };
      },
      complete: async () => ({ kind: 'completed' as const, record }),
      get: async () => null,
      pruneExpired: async () => 0,
    } satisfies IdempotencyStore;
    const coordinator = new GatewayIdempotencyCoordinator(store, { leaseTtlMs: 1000 });
    const result = await coordinator.acquire({ projectId: 'p', chain: 'ethereum-sepolia' as ChainId, key: 'k' }, { b: 2, a: 1 });
    expect(result.kind).toBe('in_flight');
    expect((calls[0] as { fingerprint: string }).fingerprint).toBe(fingerprintRequest({ a: 1, b: 2 }));
    expect((calls[0] as { leaseTtlMs: number }).leaseTtlMs).toBe(1000);
  });
});
