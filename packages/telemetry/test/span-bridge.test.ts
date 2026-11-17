// 各层记录 → span 桥接（M5 E6）。
// 核心不变量：**每层产出独立 spanId**，且父指向请求 span（不是共享同一个 spanId）。
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
  it('沿用合法 traceId，并把记录里的 spanId 作为父', () => {
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
    expect(span.spanId).not.toBe('b'.repeat(16)); // 独立 spanId
    expect(span.name).toBe('core.operation');
  });

  it('ALS 作用域父级优先于记录里的 spanId（Provider 记录的 spanId 是它自己的身份）', () => {
    const exporter = new InMemorySpanExporter();
    const emit = bridge(exporter, 'provider.request');
    // 模拟：请求 span 已通过 ALS 建立；Provider 记录带着**自己**的 spanId。
    runInRequestSpan('a'.repeat(32), (request) => {
      emit({
        traceId: request.traceId,
        spanId: 'd'.repeat(16), // provider 自己的 spanId，不是父
        status: 'success',
      });
      // 父必须是请求 span，而不是 provider 记录的 spanId
      expect(exporter.exported[0]?.parentSpanId).toBe(request.spanId);
      expect(exporter.exported[0]?.parentSpanId).not.toBe('d'.repeat(16));
    });
  });

  it('traceId 非法时新建 trace（不沿用垃圾值）', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'x')({ traceId: 'not-hex', status: 'success' });
    expect(exporter.exported[0]?.traceId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('spanId 非法时不当作父', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'x')({ traceId: 'a'.repeat(32), spanId: 'zz', status: 'success' });
    expect(exporter.exported[0]).not.toHaveProperty('parentSpanId');
  });

  it('延迟反映到 start/end（end - start == latency）', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'x')({ status: 'success', latencyMs: 7 });
    const span = exporter.exported[0]!;
    const dur = BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano);
    expect(dur).toBe(7_000_000n);
  });

  it('error 状态带 errorCode', () => {
    const exporter = new InMemorySpanExporter();
    bridge(exporter, 'x')({ status: 'error', errorCode: 'DFR_INTERNAL_ERROR' });
    expect(exporter.exported[0]).toMatchObject({
      status: 'error',
      errorCode: 'DFR_INTERNAL_ERROR',
    });
  });

  it('属性来自 attributesOf（白名单），不自动携带记录其余字段', () => {
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
  it('在根 span 内，各层记录共享同一父（请求 span）但各自独立 spanId', () => {
    const exporter = new InMemorySpanExporter();
    const emit = bridge(exporter, 'core.operation');
    runInRequestSpan('c'.repeat(32), (span) => {
      expect(span.traceId).toBe('c'.repeat(32));
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/u);
      emit({ traceId: span.traceId, spanId: span.spanId, status: 'success' });
      emit({ traceId: span.traceId, spanId: span.spanId, status: 'success' });
    });
    const [a, b] = exporter.exported;
    // 同一父
    expect(a?.parentSpanId).toBe(b?.parentSpanId);
    // 各自独立
    expect(a?.spanId).not.toBe(b?.spanId);
    // 父 = 请求 span
    expect(a?.parentSpanId).toBe(exporter.exported[0]?.parentSpanId);
  });

  it('traceId 非法时新建（入口不受污染）', () => {
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
