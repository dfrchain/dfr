/**
 * Adapter call records → structured log fields (DFR-M1-E02 observability supplement).
 *
 * Authoritative sources: observability-spec chapter 3 (unified correlation fields) and chapter 4 (span hierarchy)
 * (`core.operation` → `adapter.call` → `provider.request`).
 *
 * Isomorphic to `provider-call-log.ts`: an **allowlist**, not pass-through. Adapter call arguments may contain
 * calldata / unsigned payloads / address lists, and return values may contain full transactions; none of these enter logs.
 * The allowlist ensures that future fields added to `AdapterCallRecord` are never silently written into production logs with their arguments or payloads.
 */
import type { AdapterCallRecord } from '@dfr/core';

export const ADAPTER_CALL_LOG_FIELDS = {
  requestId: 'request_id',
  traceId: 'trace_id',
  spanId: 'span_id',
  adapter: 'adapter',
  adapterVersion: 'adapter_version',
  chain: 'chain',
  method: 'method',
  methodClass: 'method_class',
  status: 'status',
  errorCode: 'error_code',
  latencyMs: 'latency_ms',
} as const satisfies Partial<Record<keyof AdapterCallRecord, string>>;

/**
 * Fields known but **deliberately not logged**.
 *
 * Currently empty: every field of `AdapterCallRecord` may enter logs. This constant is kept so contract tests
 * can distinguish "a new field was not classified" from "deliberately excluded", keeping the same structure as the provider logs.
 */
export const ADAPTER_CALL_LOG_EXCLUDED: readonly (keyof AdapterCallRecord)[] = [];

/** Build log fields from one Adapter call record; take only allowlisted keys, dropping all undefined values. */
export function adapterCallLogFields(record: AdapterCallRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceKey, logKey] of Object.entries(ADAPTER_CALL_LOG_FIELDS) as [
    keyof AdapterCallRecord,
    string,
  ][]) {
    const value = record[sourceKey];
    if (value !== undefined) out[logKey] = value;
  }
  out['level'] = record.status === 'success' ? 'info' : 'warn';
  out['msg'] = 'adapter call';
  return out;
}

/**
 * Build the log outlet for `DfrCore.onAdapterCall`.
 *
 * Same convention as the Provider version: the outlet **must never throw**; observability failures cannot affect the business path.
 * The extra try/catch (Core already wraps one layer) exists because serialization itself can fail
 * (e.g. circular references), and this is the place that knows best how to degrade safely.
 */
export function createAdapterCallLogger(
  write: (line: string) => void,
): (record: AdapterCallRecord) => void {
  return (record) => {
    try {
      write(`${JSON.stringify(adapterCallLogFields(record))}\n`);
    } catch {
      // Observability is best-effort.
    }
  };
}
