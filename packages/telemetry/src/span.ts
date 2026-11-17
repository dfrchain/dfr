/**
 * Span 身份与层级（observability-spec §4 的 parent/child span）。
 *
 * 背景：M1 用 `trace_id` + `request_id` 关联**重建**层级，三层共享同一个请求 spanId。
 * 该做法的边界写在 spec 的验收清单里：无法表达"谁是谁的父"。
 * 本模块补上真正的 span 身份——每层**独立 spanId** + `parentSpanId`。
 *
 * 为什么不用 OpenTelemetry SDK：
 * 1. `pnpm verify` 必须离线可复现，SDK 会带来一整套依赖（exporter、
 *    resource、semantic-conventions）与版本漂移面；
 * 2. 我们只需要**产出**符合 OTLP 的 span，不需要 SDK 的自动插桩；
 * 3. 线格式是稳定的公开规范（OTLP/JSON），自己实现是可控的。
 * 若将来要接 SDK，`SpanExporter` 这个接口就是替换点。
 *
 * 安全：span 属性一律经**白名单**过滤（调用方给 `attributes` 时沿用各层日志
 * 的白名单函数），本模块不负责判断哪些字段敏感——它只保证不自行新增字段。
 */

import { randomBytes } from 'node:crypto';

/** 32 位十六进制 trace id（W3C Trace Context）。 */
export type TraceId = string;
/** 16 位十六进制 span id（W3C Trace Context）。 */
export type SpanId = string;

export interface SpanContext {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
}

/** 一个待导出的 span。字段命名刻意贴近 OTLP，减少导出时的映射错误。 */
export interface SpanRecord {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  /** 父 span；根 span 不带该字段（不是空字符串）。 */
  readonly parentSpanId?: SpanId;
  /** 例：`http.request` / `core.operation` / `adapter.call` / `provider.request` / `store.read`。 */
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly status: 'ok' | 'error';
  /**
   * 失败时的稳定错误码（DFR_*），成功时不带。
   *
   * 用 `?: string | undefined`（而不是 `?: string`）：各层记录在
   * `exactOptionalPropertyTypes` 下把可选字段声明为 `string | undefined`，
   * 桥接器把记录直接展开进 `SpanRecord` 时需要这一层兼容。
   */
  readonly errorCode?: string | undefined;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/u;
const SPAN_ID_RE = /^[0-9a-f]{16}$/u;

/** 生成新 trace id；全零被 W3C 定义为非法，因此永远不会返回全零。 */
export function newTraceId(): TraceId {
  return randomBytes(16).toString('hex');
}

/**
 * 生成新 span id。
 *
 * 循环条件排除全零：`randomBytes(8)` 全零的概率可忽略，但"可忽略"不是
 * "不可能"，而全零 span id 在 W3C 里是显式非法的——用一个循环把它变成不可能。
 */
export function newSpanId(): SpanId {
  for (;;) {
    const candidate = randomBytes(8).toString('hex');
    if (candidate !== '0000000000000000') return candidate;
  }
}

/** 校验 trace id（供"上游 traceparent 不可信"的入口使用）。 */
export function isValidTraceId(value: string): boolean {
  return TRACE_ID_RE.test(value) && !/^0+$/u.test(value);
}

/** 校验 span id。 */
export function isValidSpanId(value: string): boolean {
  return SPAN_ID_RE.test(value) && !/^0+$/u.test(value);
}

/** 当前 unix 纳秒。用 BigInt 避免 `Date.now()*1e6` 的浮点精度损失。 */
export function nowUnixNano(now: () => number = Date.now): string {
  return (BigInt(now()) * 1_000_000n).toString(10);
}
