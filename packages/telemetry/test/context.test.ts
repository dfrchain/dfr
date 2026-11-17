// Span 上下文与父子派生（M5 E6）。
// 这条是 E6 的核心：子 span 的父**由执行结构决定**，而不是由时间戳或调用顺序猜。
import { describe, expect, it } from 'vitest';
import {
  activeTraceId,
  childSpanContext,
  currentSpan,
  parentSpanId,
  runInSpan,
} from '../src/context.js';

describe('无上下文时', () => {
  it('currentSpan / parentSpanId / activeTraceId 都为 undefined', () => {
    expect(currentSpan()).toBeUndefined();
    expect(parentSpanId()).toBeUndefined();
    expect(activeTraceId()).toBeUndefined();
  });

  it('childSpanContext 新建一条 trace，且不带父', () => {
    const { context, parentSpanId: parent } = childSpanContext();
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(parent).toBeUndefined();
  });
});

describe('在 span 内', () => {
  it('子 span 继承 trace，父为当前 span', () => {
    const root = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    runInSpan(root, () => {
      expect(activeTraceId()).toBe(root.traceId);
      expect(parentSpanId()).toBe(root.spanId);
      const { context, parentSpanId: parent } = childSpanContext();
      expect(context.traceId).toBe(root.traceId);
      expect(context.spanId).not.toBe(root.spanId); // 独立 spanId
      expect(parent).toBe(root.spanId);
    });
  });

  it('嵌套两层的父是直接父，不是根', () => {
    const root = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    runInSpan(root, () => {
      const mid = childSpanContext().context;
      runInSpan(mid, () => {
        expect(parentSpanId()).toBe(mid.spanId);
        expect(parentSpanId()).not.toBe(root.spanId);
      });
    });
  });

  it('退出 span 后上下文恢复（不泄漏）', () => {
    const root = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    runInSpan(root, () => {
      /* 离开作用域 */
    });
    expect(currentSpan()).toBeUndefined();
  });
});
