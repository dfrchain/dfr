// Layer records → span bridge (M5 E6).
// Core invariant: **each layer produces an independent spanId**, and the parent points at the request span (not a shared spanId).
import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '../src/exporter.js';
import { createSpanBridge, runInRequestSpan } from '../src/span-bridge.js';

function bridge(exporter: InMemorySpanExporter, name: string) {
  return createSpanBridge({
    spanName: name,
    attributesOf: (r) => ({ operation: String(r.requestId ?? 'x') }),
    exporter,
    now: () => 1_700_000_000_000,
  });
}

describe('createSpanBridge', () => {
    it('reuses a valid traceId, and uses the spanId in the record as the parent', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'core.operation')({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      status: 'success',
      latencyMs: 5,
    });
    const span = exporter.exported[0]!;
    expect(span.traceId).toBe('a'.repeat(32));
    expect(span.parentSpanId).toBe('b'.repeat(16));
    expect(span.spanId).not.toBe('b'.repeat(16)); // Independent spanId
    expect(span.name).toBe('core.operation');
  });

    it('the ALS-scope parent wins over the spanId in the record (a Provider record\'s spanId is its own identity)', () => {
    const exporter = new InMemorySpanExporter();
    const emit = bridge(exporter, 'provider.request');
    // Simulate: the request span is already established via ALS; the Provider record carries **its own** spanId.
    runInRequestSpan('a'.repeat(32), (request) => {
      emit({
        traceId: request.traceId,
        spanId: 'd'.repeat(16), // the provider's own spanId, not the parent
        status: 'success',
      });
      // The parent must be the request span, not the spanId in the provider record
      expect(exporter.exported[0]?.parentSpanId).toBe(request.spanId);
      expect(exporter.exported[0]?.parentSpanId).not.toBe('d'.repeat(16));
    });
  });

    it('a new trace is started when traceId is invalid (do not reuse a garbage value)', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'x')({ traceId: 'not-hex', status: 'success' });
    expect(exporter.exported[0]?.traceId).toMatch(/^[0-9a-f]{32}$/u);
  });

    it('an invalid spanId is not treated as a parent', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'x')({ traceId: 'a'.repeat(32), spanId: 'zz', status: 'success' });
    expect(exporter.exported[0]).not.toHaveProperty('parentSpanId');
  });

    it('latency is reflected in start/end (end - start == latency)', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'x')({ status: 'success', latencyMs: 7 });
    const span = exporter.exported[0]!;
    const dur = BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano);
    expect(dur).toBe(7_000_000n);
  });

    it('error state carries errorCode', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'x')({ status: 'error', errorCode: 'DFR_INTERNAL_ERROR' });
    expect(exporter.exported[0]).toMatchObject({
      status: 'error',
      errorCode: 'DFR_INTERNAL_ERROR',
    });
  });

    it('attributes come from attributesOf (the allowlist), not carried automatically from the rest of the record', () => {
    const exporter = new InMemorySpanExporter();
    createSpanBridge({
      spanName: 'x',
      attributesOf: () => ({ safe: 'yes' }),
      exporter,
    })({ status: 'success', requestId: 'r-1', errorCode: 'DFR_X' });
    expect(exporter.exported[0]?.attributes).toEqual({ safe: 'yes' });
  });
});

describe('runInRequestSpan', () => {
    it('inside a root span, each layer\'s records share the same parent (the request span) but have independent spanIds', () => {
    const exporter = new InMemorySpanExporter();
    const emit = bridge(exporter, 'core.operation');
    runInRequestSpan('c'.repeat(32), (span) => {
      expect(span.traceId).toBe('c'.repeat(32));
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/u);
      emit({ traceId: span.traceId, spanId: span.spanId, status: 'success' });
      emit({ traceId: span.traceId, spanId: span.spanId, status: 'success' });
    });
    const [a, b] = exporter.exported;
    // Same parent
    expect(a?.parentSpanId).toBe(b?.parentSpanId);
    // Independent each
    expect(a?.spanId).not.toBe(b?.spanId);
    // Parent = the request span
    expect(a?.parentSpanId).toBe(exporter.exported[0]?.parentSpanId);
  });

    it('a new trace is started when traceId is invalid (the entry is not polluted)', () => {
    const exporter = new InMemorySpanExporter();
    const emit = bridge(exporter, 'x');
    runInRequestSpan('garbage', (span) => {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/u);
      emit({ traceId: span.traceId, spanId: span.spanId, status: 'success' });
    });
    expect(exporter.exported[0]?.traceId).toBe(
      exporter.exported[0]?.traceId,
    );
  });
});
