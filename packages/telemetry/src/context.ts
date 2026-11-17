/**
 * 当前 span 上下文（observability-spec §4："进程内 AsyncLocalStorage 承载当前 span"）。
 *
 * 为什么需要它：只有"当前 span"是隐式可见的，各层的日志出口才能在**不改端口签名**
 * 的前提下把子 span 挂到正确的父上。若改用显式传参，Store/Adapter/Provider 的
 * 公开签名都要为观测新增参数——spec 明确不接受这一点。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { newSpanId, newTraceId, type SpanContext, type SpanId, type TraceId } from './span.js';

const current = new AsyncLocalStorage<SpanContext>();

/** 当前 span；不在任何 span 内时返回 undefined。 */
export function currentSpan(): SpanContext | undefined {
  return current.getStore();
}

/**
 * 以给定 span 为"当前 span"执行 `fn`。
 *
 * 子 span 用 `parentOf()` 取父：这样嵌套是**由执行结构决定**的，
 * 而不是由调用顺序或时间戳猜出来的。
 */
export function runInSpan<T>(context: SpanContext, fn: () => T): T {
  return current.run(context, fn);
}

/** 父 span id（若当前在某个 span 内）。 */
export function parentSpanId(): SpanId | undefined {
  return current.getStore()?.spanId;
}

/** 当前 trace id；不在任何 span 内时返回 undefined（不伪造新 trace）。 */
export function activeTraceId(): TraceId | undefined {
  return current.getStore()?.traceId;
}

/**
 * 为一个新子 span 派生身份：继承当前 trace，生成新 spanId，父为当前 span。
 *
 * 没有任何当前 span 时**新建一条 trace**（作为根 span）——调用方无需区分
 * "在请求内"与"在后台任务里"，两种情况都能产出合法 span。
 */
export function childSpanContext(): { context: SpanContext; parentSpanId?: SpanId } {
  const parent = current.getStore();
  if (parent === undefined) {
    return { context: { traceId: newTraceId(), spanId: newSpanId() } };
  }
  return {
    context: { traceId: parent.traceId, spanId: newSpanId() },
    parentSpanId: parent.spanId,
  };
}
