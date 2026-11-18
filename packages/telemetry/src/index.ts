/**
 * @dfr/telemetry — span identity, context, and OTLP export (M5 production hardening E6).
 *
 * Spec source: docs/architecture/observability-spec-v0.1.md §3/§4/§10
 * (last open item: "true parent/child spans + independent spanIds").
 *
 * Deliberately zero third-party dependencies: `pnpm verify` must be reproducible offline. The export format is the public
 * OTLP/JSON; connecting an OpenTelemetry Collector needs no SDK in this package.
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
