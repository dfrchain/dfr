// OTLP/JSON 导出格式（M5 E6）。
// 重点：字段用 OTLP 的真实编码（int64 → 十进制**字符串**），不是"看起来像"。
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
  it('保留身份与父子关系', () => {
    const span = toOtlpSpan(SPAN);
    expect(span['traceId']).toBe(SPAN.traceId);
    expect(span['spanId']).toBe(SPAN.spanId);
    expect(span['parentSpanId']).toBe(SPAN.parentSpanId);
  });

  it('根 span 不出现 parentSpanId 字段（不是空字符串）', () => {
    // 显式构造一个只有必填字段的根 span（不靠解构丢弃字段，避免 lint 噪声）。
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

  it('属性按类型编码；整数用 intValue 字符串', () => {
    const attrs = toOtlpSpan(SPAN)['attributes'] as Array<Record<string, unknown>>;
    const byKey = Object.fromEntries(attrs.map((a) => [a['key'], a['value']]));
    expect(byKey['operation']).toEqual({ stringValue: 'getBalance' });
    expect(byKey['latency_ms']).toEqual({ intValue: '5' });
    expect(byKey['retry']).toEqual({ boolValue: false });
  });

  it('状态码：ok=1、error=2 且带 message', () => {
    expect((toOtlpSpan(SPAN)['status'] as Record<string, unknown>)['code']).toBe(2);
    expect((toOtlpSpan(SPAN)['status'] as Record<string, unknown>)['message']).toBe(
      'DFR_CHAIN_UNAVAILABLE',
    );
    // 成功的 span 不带 errorCode（整体省略该字段，不是设为 undefined）。
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
  it('输出合法的 OTLP resourceSpans 结构', () => {
    const lines: string[] = [];
    new JsonlSpanExporter((l) => lines.push(l)).export([SPAN]);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const rs = (parsed['resourceSpans'] as Array<Record<string, unknown>>)[0]!;
    expect((rs['resource'] as Record<string, unknown>)['attributes']).toBeDefined();
    const spans = ((rs['scopeSpans'] as Array<Record<string, unknown>>)[0]!['spans'] as unknown[]);
    expect(spans).toHaveLength(1);
  });

  it('空批次不写任何行', () => {
    const sink = vi.fn();
    new JsonlSpanExporter(sink).export([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it('sink 抛错被吞掉（观测不得影响业务）', () => {
    const exporter = new JsonlSpanExporter(() => {
      throw new Error('disk full');
    });
    expect(() => exporter.export([SPAN])).not.toThrow();
  });
});

describe('InMemorySpanExporter', () => {
  it('累积导出并提供快照副本', () => {
    const exporter = new InMemorySpanExporter();
    exporter.export([SPAN]);
    expect(exporter.exported).toHaveLength(1);
    exporter.reset();
    expect(exporter.exported).toHaveLength(0);
  });
});
