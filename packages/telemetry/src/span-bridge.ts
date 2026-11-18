/**
 * Layer observation records → OTLP spans (M5 production hardening E6).
 *
 * Why here instead of each log outlet assembling its own: the four layers' records (Core / Adapter /
 * Provider / Store) already carry `traceId` + `spanId`, and their mapping to span names is
 * **the same thing**. Centralizing it keeps the four layers from drifting, and turns "add a layer's span name"
 * into an explicit change.
 *
 * Honest boundaries (matching the observability-spec acceptance checklist):
 * This bridge produces **real span identity** — one independent `spanId` per layer, parent pointing at the request span
 * (`http.request`). The two deeper levels in spec §4 (`core.operation → adapter.call`,
 * `adapter.call → provider.request`) need each layer to build true call nesting with AsyncLocalStorage;
 * this bridge does not fabricate those two levels — it hangs each layer explicitly under the request span.
 */

import { childSpanContext, runInSpan } from './context.js';
import { isValidSpanId, isValidTraceId, nowUnixNano, type SpanRecord } from './span.js';
import type { SpanExporter } from './exporter.js';

/** Bridge input: the smallest subset we can rely on from each layer's records. */
export interface LayerRecord {
  // Use `| undefined` instead of `?:`: each layer's records (Provider/Adapter/Core/Store) declare
  // optional fields as `string | undefined` under exactOptionalPropertyTypes;
  // using `?:` would make this interface their **incompatible supertype**, so the bridge could not reuse them directly.
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly latencyMs?: number | undefined;
  readonly status: 'success' | 'error';
  readonly errorCode?: string | undefined;
}

export interface SpanBridgeOptions {
  /** Record → span name (e.g. `core.operation`). */
  readonly spanName: string;
  /** Record → span attributes (**must pass that layer's log allowlist function**; do not pass the whole record through). */
  readonly attributesOf: (record: LayerRecord) => Readonly<Record<string, string | number | boolean>>;
  readonly exporter: SpanExporter;
  /** Clock injection, for tests; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Build a "record → span" bridge.
 *
 * Association rules (three, all explicit):
 * - A valid `traceId` is reused, otherwise a **new** one is created (the correct behavior when a background task has no entry trace);
 * - A valid `spanId` becomes the **parent** span; when invalid/missing, this span becomes the root;
 * - Each layer produces a **new** `spanId` (that is what "independent span" means).
 */
export function createSpanBridge(
  options: SpanBridgeOptions,
): (record: LayerRecord) => void {
  const now = options.now ?? Date.now;
  return (record) => {
    const attributes = options.attributesOf(record);
    const parentFromRecord =
      record.spanId !== undefined && isValidSpanId(record.spanId) ? record.spanId : undefined;

    // Derive via ALS: with no current context, start a new trace (legal as a root span too).
    const { context, parentSpanId: parentFromScope } = childSpanContext();
    const traceId =
      record.traceId !== undefined && isValidTraceId(record.traceId)
        ? record.traceId
        : context.traceId;
    // The parent's precedence is **deliberate**:
    // 1. The ALS-scope parent wins — it is decided by the execution structure (the request span), the only source that can express hierarchy;
    // 2. Only without ALS (the background sweep path) do we fall back to the spanId in the record.
    //
    // Why record.spanId cannot always be used: the spanId in a Provider record is **that Provider request
    // itself's identity** (`manager.ts` generates it and injects it into the RPC traceparent), not the parent span;
    // while the spanId in Core/Adapter records is exactly the request span (their parent). The same field has
    // different semantics in the two layers, so only ALS can unify them. See "honest boundaries" at the top of this file.
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
    // Export is best-effort: after the span record is built it goes to the exporter, which must not throw.
    options.exporter.export([span]);
  };
}

/**
 * Execute inside a root span: establish the ALS context for `http.request`.
 *
 * Returns `traceId` / `spanId` for the caller to put in logs and response headers, so **within the same request** each layer's
 * records carry a `spanId` that is this root span — the bridge hangs each layer under it accordingly.
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
