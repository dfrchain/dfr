/**
 * Gateway span-export wiring (M5 production hardening E6).
 *
 * Convert the four layers of observability-spec §4 records (`core.operation` / `adapter.call` /
 * `provider.request` / `store.read|write`) into **real spans** and hand them to the `SpanExporter`.
 *
 * Relationship to the existing log outlets: **coexist, not replace**.
 * - Log outlets (`*-call-log.ts`) stay as-is: they are the main entry point for operations retrieval;
 * - This module additionally produces OTLP spans, for Trace backends (Collector/Jaeger/Tempo) to rebuild the hierarchy.
 *
 * Why opt-in (`DFR_OTLP_SPANS=true`): existing deployments may have no Trace backend,
 * and unconditional output would double stdout. Off by default means "behavior unchanged", this repo's standing requirement for existing deployments.
 *
 * Why attributes go through each layer's own allowlist function: the allowlists are already test-locked on the log path;
 * reusing them means spans introduce **no new** field-exposure surface — there is no "logs filtered it, spans leaked it".
 */
import {
  createSpanBridge,
  JsonlSpanExporter,
  type SpanExporter,
} from '@dfr/telemetry';
import type { ProviderCallRecord } from '@dfr/provider';
import type { AdapterCallRecord, CoreOperationRecord } from '@dfr/core';
import type { StoreCallRecord } from '@dfr/transaction';
import { providerCallLogFields } from './provider-call-log.js';
import { adapterCallLogFields } from './adapter-call-log.js';
import { coreOperationLogFields } from './core-operation-log.js';
import { storeCallLogFields } from './store-call-log.js';

/** Mapping from one layer's observability record → span name (one-to-one with the observability-spec §4 layer names). */
export const SPAN_NAMES = {
  coreOperation: 'core.operation',
  adapterCall: 'adapter.call',
  providerRequest: 'provider.request',
} as const;

/** A store span's name is decided by kind (`store.read` / `store.write`), matching the log convention. */
export function storeSpanName(kind: StoreCallRecord['kind']): string {
  return kind === 'read' ? 'store.read' : 'store.write';
}

/**
 * Convert the log allowlist's `snake_case` fields into span attributes.
 *
 * The three **correlation fields `request_id`/`trace_id`/`span_id` do not enter attributes**: they are the span's own
 * identity and parent/child relations; putting them in attributes would store the same information twice and possibly inconsistently. `span`/`level`/`msg`
 * are log-only keys and likewise do not belong in span attributes.
 */
const NON_ATTRIBUTE_KEYS = new Set(['request_id', 'trace_id', 'span_id', 'span', 'level', 'msg']);

export function attributesFromLogFields(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (NON_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/** Set of four layer bridges; `undefined` means that layer is not assembled. */
export interface SpanEmitters {
  readonly coreOperation?: (record: CoreOperationRecord) => void;
  readonly adapterCall?: (record: AdapterCallRecord) => void;
  readonly providerRequest?: (record: ProviderCallRecord) => void;
  readonly storeCall?: (record: StoreCallRecord) => void;
}

/**
 * Construct the four-layer span emitters.
 *
 * Pass `exporter` so tests can inject an in-memory exporter; production uses the default stdout JSONL.
 */
export function createSpanEmitters(exporter?: SpanExporter): SpanEmitters {
  const sink: SpanExporter =
    exporter ?? new JsonlSpanExporter((line) => process.stdout.write(line));

  return {
    coreOperation: createSpanBridge({
      spanName: SPAN_NAMES.coreOperation,
      exporter: sink,
      attributesOf: (record) => attributesFromLogFields(coreOperationLogFields(record as CoreOperationRecord)),
    }),
    adapterCall: createSpanBridge({
      spanName: SPAN_NAMES.adapterCall,
      exporter: sink,
      attributesOf: (record) => attributesFromLogFields(adapterCallLogFields(record as AdapterCallRecord)),
    }),
    providerRequest: createSpanBridge({
      spanName: SPAN_NAMES.providerRequest,
      exporter: sink,
      attributesOf: (record) => attributesFromLogFields(providerCallLogFields(record as ProviderCallRecord)),
    }),
    storeCall: (record) => {
      // The store layer's span name depends on kind, so a bridge is constructed per call;
      // the bridge itself is stateless (only name and exporter), so this cost is acceptable.
      createSpanBridge({
        spanName: storeSpanName(record.kind),
        exporter: sink,
        attributesOf: (r) => attributesFromLogFields(storeCallLogFields(r as StoreCallRecord)),
      })(record);
    },
  };
}
