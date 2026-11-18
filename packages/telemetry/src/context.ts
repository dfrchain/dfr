/**
 * Current span context (observability-spec §4: "AsyncLocalStorage carries the current span in-process").
 *
 * Why it is needed: only the "current span" is implicitly visible, so each layer's log outlet can attach child spans to the right parent **without changing port signatures**
 * — if explicit parameters were used instead, the public signatures of Store/Adapter/Provider would all
 * need new parameters for observation — and the spec explicitly rejects that.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { newSpanId, newTraceId, type SpanContext, type SpanId, type TraceId } from './span.js';

const current = new AsyncLocalStorage<SpanContext>();

/** The current span; returns undefined when not inside any span. */
export function currentSpan(): SpanContext | undefined {
  return current.getStore();
}

/**
 * Run `fn` with the given span as the "current span".
 *
 * A child span takes its parent via `parentOf()`: nesting is **decided by the execution structure**,
 * not guessed from call order or timestamps.
 */
export function runInSpan<T>(context: SpanContext, fn: () => T): T {
  return current.run(context, fn);
}

/** Parent span id (when currently inside a span). */
export function parentSpanId(): SpanId | undefined {
  return current.getStore()?.spanId;
}

/** The current trace id; returns undefined when not inside any span (never fabricates a new trace). */
export function activeTraceId(): TraceId | undefined {
  return current.getStore()?.traceId;
}

/**
 * Derive an identity for a new child span: inherit the current trace, generate a new spanId, parent is the current span.
 *
 * With no current span, **start a new trace** (as a root span) — the caller does not need to distinguish
 * "inside a request" from "in a background task"; both cases produce valid spans.
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
