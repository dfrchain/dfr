/**
 * Span export (M5 production hardening E6).
 *
 * Two implementations, deliberately different in semantics:
 * - `InMemorySpanExporter`: for tests and local diagnostics;
 * - `JsonlSpanExporter`: writes OTLP/JSON lines to a sink (default stdout),
 *   so filebeat / fluent-bit / collector can pick them up.
 *
 * Why not call a remote OTLP endpoint directly: `pnpm verify` must work offline; and putting network calls
 * in the request path would turn "observability backend jitter" into "business failure". Export is **best-effort**:
 * `export()` never throws (same convention as each layer's log outlet).
 *
 * Format: the OTLP/JSON `resourceSpans → scopeSpans → spans` shape.
 * Only fill fields we actually have; do not fabricate SDK metadata.
 */

import type { SpanRecord } from './span.js';

export interface SpanExporter {
  /** Export (best-effort, **must not throw**). */
  export(spans: readonly SpanRecord[]): void;
  /** Close/flush (optional). */
  shutdown?(): void;
}

/** In-memory exporter: for test assertions. Keeps the original records in export order. */
export class InMemorySpanExporter implements SpanExporter {
  private readonly spans: SpanRecord[] = [];

  export(spans: readonly SpanRecord[]): void {
    this.spans.push(...spans);
  }

  /** Snapshot of exported spans (a copy, so callers cannot mutate internal state). */
  get exported(): readonly SpanRecord[] {
    return [...this.spans];
  }

  reset(): void {
    this.spans.length = 0;
  }
}

/**
 * JSONL exporter.
 *
 * `sink` defaults to `process.stdout.write`; the caller is responsible for not writing sensitive content here —
 * span attributes have already passed each layer's allowlist, and this module does not filter a second time (double filtering would hide allowlist holes).
 */
export class JsonlSpanExporter implements SpanExporter {
  readonly #sink: (line: string) => void;
  readonly #serviceName: string;

  constructor(sink: (line: string) => void, serviceName = 'dfr-gateway') {
    this.#sink = sink;
    this.#serviceName = serviceName;
  }

  export(spans: readonly SpanRecord[]): void {
    if (spans.length === 0) return;
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: this.#serviceName } }],
          },
          scopeSpans: [
            {
              scope: { name: '@dfr/telemetry' },
              spans: spans.map((span) => toOtlpSpan(span)),
            },
          ],
        },
      ],
    };
    try {
      this.#sink(`${JSON.stringify(payload)}\n`);
    } catch {
      // Observation failures do not affect business (same convention as each layer's log outlet).
    }
  }
}

/** `SpanRecord` → OTLP span. Unset fields are **absent**, not filled with empty values. */
export function toOtlpSpan(span: SpanRecord): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL: these are all in-process calls, not RPC client/server semantics.
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: otlpValue(value),
    })),
    status: {
      // OTLP: 0=UNSET, 1=OK, 2=ERROR. On failure, carry errorCode as the description.
      code: span.status === 'ok' ? 1 : 2,
      ...(span.errorCode !== undefined ? { message: span.errorCode } : {}),
    },
  };
}

function otlpValue(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  // Integers use intValue (decimal strings; OTLP specifies int64 encoded as strings).
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}
