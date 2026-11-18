/**
 * Span identity and hierarchy (observability-spec §4 parent/child spans).
 *
 * Background: M1 used `trace_id` + `request_id` to **reconstruct** hierarchy by association; three layers shared one request spanId.
 * That approach's boundary is written in the spec's acceptance checklist: it cannot express "who is whose parent".
 * This module adds true span identity — one **independent spanId** per layer + `parentSpanId`.
 *
 * Why not use the OpenTelemetry SDK:
 * 1. `pnpm verify` must be reproducible offline; the SDK brings a whole dependency set (exporter,
 *    resource, semantic-conventions) and a version-drift surface;
 * 2. We only need to **produce** spans conforming to OTLP, not the SDK's automatic instrumentation;
 * 3. The wire format is a stable public spec (OTLP/JSON); implementing it ourselves is controllable.
 * If the SDK is adopted later, the `SpanExporter` interface is the replacement point.
 *
 * Security: span attributes always pass an **allowlist** filter (when the caller supplies `attributes`, each layer's log
 * allowlist function is reused); this module does not decide which fields are sensitive — it only guarantees it adds no fields of its own.
 */

import { randomBytes } from 'node:crypto';

/** 32-hex-char trace id (W3C Trace Context). */
export type TraceId = string;
/** 16-hex-char span id (W3C Trace Context). */
export type SpanId = string;

export interface SpanContext {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
}

/** A span to export. Field names deliberately stay close to OTLP to reduce mapping mistakes at export. */
export interface SpanRecord {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  /** Parent span; a root span omits this field (not an empty string). */
  readonly parentSpanId?: SpanId;
  /** E.g. `http.request` / `core.operation` / `adapter.call` / `provider.request` / `store.read`. */
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly status: 'ok' | 'error';
  /**
   * The stable error code on failure (DFR_*); absent on success.
   *
   * Use `?: string | undefined` (not `?: string`): each layer's records declare optional fields as `string | undefined` under
   * `exactOptionalPropertyTypes`,
   * so the bridge stays compatible when expanding records directly into a `SpanRecord`.
   */
  readonly errorCode?: string | undefined;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/u;
const SPAN_ID_RE = /^[0-9a-f]{16}$/u;

/** Generate a new trace id; all-zero is defined as illegal by W3C, so it is never returned. */
export function newTraceId(): TraceId {
  return randomBytes(16).toString('hex');
}

/**
 * Generate a new span id.
 *
 * The loop condition excludes all-zero: the chance of `randomBytes(8)` returning all zero is negligible, but "negligible" is not
 * "impossible", and an all-zero span id is explicitly illegal in W3C — one loop turns it into impossible.
 */
export function newSpanId(): SpanId {
  for (;;) {
    const candidate = randomBytes(8).toString('hex');
    if (candidate !== '0000000000000000') return candidate;
  }
}

/** Validate a trace id (for entries where the "upstream traceparent is untrusted"). */
export function isValidTraceId(value: string): boolean {
  return TRACE_ID_RE.test(value) && !/^0+$/u.test(value);
}

/** Validate a span id. */
export function isValidSpanId(value: string): boolean {
  return SPAN_ID_RE.test(value) && !/^0+$/u.test(value);
}

/** Current unix nanoseconds. Uses BigInt to avoid the float precision loss of `Date.now()*1e6`. */
export function nowUnixNano(now: () => number = Date.now): string {
  return (BigInt(now()) * 1_000_000n).toString(10);
}
