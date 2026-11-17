/**
 * @dfr/telemetry —— span 身份、上下文与 OTLP 导出（M5 生产加固 E6）。
 *
 * 规范来源：docs/architecture/observability-spec-v0.1.md §3/§4/§10
 * （最后一条未决项："真正的 parent/child span + 独立 spanId"）。
 *
 * 刻意零第三方依赖：`pnpm verify` 必须离线可复现。导出格式是公开的
 * OTLP/JSON，接 OpenTelemetry Collector 不需要本包引入 SDK。
 */
export {
  isValidSpanId,
  isValidTraceId,
  newSpanId,
  newTraceId,
  nowUnixNano,
  type SpanContext,
  type SpanId,
  type SpanRecord,
  type TraceId,
} from './span.js';
export {
  activeTraceId,
  childSpanContext,
  currentSpan,
  parentSpanId,
  runInSpan,
} from './context.js';
export {
  InMemorySpanExporter,
  JsonlSpanExporter,
  toOtlpSpan,
  type SpanExporter,
} from './exporter.js';
export {
  createSpanBridge,
  runInRequestSpan,
  type LayerRecord,
  type SpanBridgeOptions,
} from './span-bridge.js';
