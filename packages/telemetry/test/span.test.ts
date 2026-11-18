// Span identity invariants (M5 E6).
// Focus: W3C defines "all-zero" as illegal, so the generator must **never** produce all-zero —
// this case runs several rounds with the real random source, not just once.
import { describe, expect, it } from 'vitest';
import { isValidSpanId, isValidTraceId, newSpanId, newTraceId, nowUnixNano } from '../src/span.js';

  describe('id generation', () => {
    it('a trace id is 32 hex chars and valid', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newTraceId();
      expect(id).toMatch(/^[0-9a-f]{32}$/u);
      expect(isValidTraceId(id)).toBe(true);
    }
  });

    it('a span id is 16 hex chars and valid', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newSpanId();
      expect(id).toMatch(/^[0-9a-f]{16}$/u);
      expect(isValidSpanId(id)).toBe(true);
    }
  });

    it('ids do not repeat (sampling 500 pairs)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(newSpanId());
    expect(seen.size).toBe(500);
  });
});

  describe('validity checks', () => {
    it('rejects all-zero (explicitly illegal in W3C)', () => {
    expect(isValidTraceId('0'.repeat(32))).toBe(false);
    expect(isValidSpanId('0'.repeat(16))).toBe(false);
  });

    it('rejects wrong length/charset', () => {
    expect(isValidTraceId('abc')).toBe(false);
    expect(isValidTraceId('Z'.repeat(32))).toBe(false);
    expect(isValidSpanId('1234567890abcde')).toBe(false);
  });
});

describe('nowUnixNano', () => {
    it('uses BigInt, no precision loss', () => {
    // 1_700_000_000_000 ms -> 1.7e18 ns, beyond the Number safe integer (9.007e15)
    expect(nowUnixNano(() => 1_700_000_000_000)).toBe('1700000000000000000');
  });
});
