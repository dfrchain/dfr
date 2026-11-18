// OTLP/JSON export format (M5 E6).
// Focus: fields use OTLP's real encoding (int64 → decimal **string**), not something that merely "looks like" it.
import { describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter, JsonlSpanExporter, toOtlpSpan } from '../src/exporter.js';
import type { SpanRecord } from '../src/span.js';

const SPAN: SpanRecord = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  parentSpanId: 'c'.repeat(16),
  name: 'core.operation',
  startTimeUnixNano: '1700000000000000000',
  endTimeUnixNano: '1700000000005000000',
  attributes: { operation: 'getBalance', latency_ms: 5, retry: false },
  status: 'error',
  errorCode: 'DFR_CHAIN_UNAVAILABLE',
};

describe('toOtlpSpan', () => {
    it('keeps identity and parent/child relationships', () => {
    const span = toOtlpSpan(SPAN);
    expect(span['traceId']).toBe(SPAN.traceId);
    expect(span['spanId']).toBe(SPAN.spanId);
    expect(span['parentSpanId']).toBe(SPAN.parentSpanId);
  });

    it('a root span has no parentSpanId field (not an empty string)', () => {
    // Explicitly construct a root span with only the required fields (do not drop fields via destructuring, to avoid lint noise).
    const root: SpanRecord = {
      traceId: SPAN.traceId,
      spanId: SPAN.spanId,
      name: SPAN.name,
      startTimeUnixNano: SPAN.startTimeUnixNano,
      endTimeUnixNano: SPAN.endTimeUnixNano,
      attributes: SPAN.attributes,
      status: SPAN.status,
      errorCode: SPAN.errorCode,
    };
    expect(toOtlpSpan(root)).not.toHaveProperty('parentSpanId');
  });

    it('attributes are encoded by type; integers use the intValue string', () => {
    const attrs = toOtlpSpan(SPAN)['attributes'] as Array<Record<string, unknown>>;
    const byKey = Object.fromEntries(attrs.map((a) => [a['key'], a['value']]));
    expect(byKey['operation']).toEqual({ stringValue: 'getBalance' });
    expect(byKey['latency_ms']).toEqual({ intValue: '5' });
    expect(byKey['retry']).toEqual({ boolValue: false });
  });

    it('status codes: ok=1, error=2 with a message', () => {
    expect((toOtlpSpan(SPAN)['status'] as Record<string, unknown>)['code']).toBe(2);
    expect((toOtlpSpan(SPAN)['status'] as Record<string, unknown>)['message']).toBe(
      'DFR_CHAIN_UNAVAILABLE',
    );
    // A successful span carries no errorCode (the whole field is omitted, not set to undefined).
    const okSpan: SpanRecord = {
      traceId: SPAN.traceId,
      spanId: SPAN.spanId,
      name: SPAN.name,
      startTimeUnixNano: SPAN.startTimeUnixNano,
      endTimeUnixNano: SPAN.endTimeUnixNano,
      attributes: SPAN.attributes,
      status: 'ok',
    };
    expect(
      (toOtlpSpan(okSpan)['status'] as Record<string, unknown>)['code'],
    ).toBe(1);
  });
});

describe('JsonlSpanExporter', () => {
    it('outputs a valid OTLP resourceSpans structure', () => {
    const lines: string[] = [];
    new JsonlSpanExporter((l) => lines.push(l)).export([SPAN]);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const rs = (parsed['resourceSpans'] as Array<Record<string, unknown>>)[0]!;
    expect((rs['resource'] as Record<string, unknown>)['attributes']).toBeDefined();
    const spans = ((rs['scopeSpans'] as Array<Record<string, unknown>>)[0]!['spans'] as unknown[]);
    expect(spans).toHaveLength(1);
  });

    it('empty batches write no lines', () => {
    const sink = vi.fn();
    new JsonlSpanExporter(sink).export([]);
    expect(sink).not.toHaveBeenCalled();
  });

    it('a sink throw is swallowed (observation must not affect business)', () => {
    const exporter = new JsonlSpanExporter(() => {
      throw new Error('disk full');
    });
    expect(() => exporter.export([SPAN])).not.toThrow();
  });
});

describe('InMemorySpanExporter', () => {
    it('accumulates exports and provides snapshot copies', () => {
    const exporter = new InMemorySpanExporter();
    exporter.export([SPAN]);
    expect(exporter.exported).toHaveLength(1);
    exporter.reset();
    expect(exporter.exported).toHaveLength(0);
  });
});
