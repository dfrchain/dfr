/**
 * 各层观测记录 → OTLP span（M5 生产加固 E6）。
 *
 * 为什么放在这里而不是每个日志出口自己拼：四层记录（Core / Adapter /
 * Provider / Store）已经携带 `traceId` + `spanId`，它们与 span 名称的映射是
 * **同一件事**。集中一处可以保证四层不会漂移，也让"新增一层的 span 名称"
 * 变成一个显式的改动。
 *
 * 诚实的边界（与 observability-spec 验收清单一致）：
 * 本桥接产出的是**真实 span 身份**——每层一个独立的 `spanId`，父指向请求 span
 * （`http.request`）。spec §4 里更深的两级（`core.operation → adapter.call`、
 * `adapter.call → provider.request`）需要各层用 AsyncLocalStorage 建立真正的
 * 调用嵌套；本桥接不伪造那两级，而是把每层显式挂在请求 span 之下。
 */

import { childSpanContext, runInSpan } from './context.js';
import { isValidSpanId, isValidTraceId, nowUnixNano, type SpanRecord } from './span.js';
import type { SpanExporter } from './exporter.js';

/** 桥接输入：各层记录里我们能依赖的最小子集。 */
export interface LayerRecord {
  // 用 `| undefined` 而不是 `?:`：各层记录（Provider/Adapter/Core/Store）在
  // exactOptionalPropertyTypes 下把可选字段声明为 `string | undefined`，
  // 用 `?:` 会让本接口成为它们的**不兼容超类型**，使桥接器无法直接复用。
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly latencyMs?: number | undefined;
  readonly status: 'success' | 'error';
  readonly errorCode?: string | undefined;
}

export interface SpanBridgeOptions {
  /** 记录 → span 名称（例：`core.operation`）。 */
  readonly spanName: string;
  /** 记录 → span 属性（**必须传该层日志的白名单函数**，不要透传整个记录）。 */
  readonly attributesOf: (record: LayerRecord) => Readonly<Record<string, string | number | boolean>>;
  readonly exporter: SpanExporter;
  /** 时钟注入，便于测试；默认 `Date.now`。 */
  readonly now?: () => number;
}

/**
 * 构造一个"记录 → span"的桥接器。
 *
 * 关联规则（三条，都是显式的）：
 * - `traceId` 合法则沿用，否则**新建**（后台任务没有入口 trace 时的正确行为）；
 * - `spanId` 合法则作为**父** span；不合法/缺失时该 span 成为根；
 * - 每层产出**新的** `spanId`（这才是"独立 span"的含义）。
 */
export function createSpanBridge(
  options: SpanBridgeOptions,
): (record: LayerRecord) => void {
  const now = options.now ?? Date.now;
  return (record) => {
    const attributes = options.attributesOf(record);
    const parentFromRecord =
      record.spanId !== undefined && isValidSpanId(record.spanId) ? record.spanId : undefined;

    // 用 ALS 派生：无当前上下文时新建 trace（作为根 span 也合法）。
    const { context, parentSpanId: parentFromScope } = childSpanContext();
    const traceId =
      record.traceId !== undefined && isValidTraceId(record.traceId)
        ? record.traceId
        : context.traceId;
    // 父的取值顺序是**有意的**：
    // 1. ALS 作用域父级优先——它由执行结构决定（请求 span），是唯一能表达层级的来源；
    // 2. 没有 ALS 时（后台巡检路径）才回落到记录里的 spanId。
    //
    // 为什么不能总是用 record.spanId：Provider 记录里的 spanId 是**该次 Provider 请求
    // 自身的身份**（`manager.ts` 生成它并注入 RPC 的 traceparent），不是父 span；
    // 而 Core/Adapter 记录里的 spanId 恰恰是请求 span（它们的父）。同一字段在两层
    // 语义不同，因此只能靠 ALS 统一。详见本文件顶部"诚实的边界"。
    const parentSpanId = parentFromScope ?? parentFromRecord;

    const latency = Math.max(0, record.latencyMs ?? 0);
    const end = now();
    const start = end - latency;
    const span: SpanRecord = {
      traceId,
      spanId: context.spanId,
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      name: options.spanName,
      startTimeUnixNano: nowUnixNano(() => start),
      endTimeUnixNano: nowUnixNano(() => end),
      attributes,
      status: record.status === 'success' ? 'ok' : 'error',
      ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
    };
    // 导出是尽力而为：span 记录构造完成后交给 exporter，后者自身不得抛错。
    options.exporter.export([span]);
  };
}

/**
 * 在根 span 内执行：建立 `http.request` 的 ALS 上下文。
 *
 * 返回 `traceId` / `spanId` 供调用方放进日志与响应头，这样**同一请求内**各层
 * 记录携带的 `spanId` 就是这个根 span——桥接据此把各层挂到它下面。
 */
export function runInRequestSpan<T>(
  traceId: string | undefined,
  fn: (span: { traceId: string; spanId: string }) => T,
): T {
  const { context } = childSpanContext();
  const resolvedTrace =
    traceId !== undefined && isValidTraceId(traceId) ? traceId : context.traceId;
  const span = { traceId: resolvedTrace, spanId: context.spanId };
  return runInSpan({ traceId: resolvedTrace, spanId: context.spanId }, () => fn(span));
}
