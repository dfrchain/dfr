/**
 * Store call records → structured log fields (observability-spec chapter 4 `store.read` / `store.write`).
 *
 * Isomorphic to the provider / adapter logs: an **allowlist**, not pass-through. Store call arguments contain addresses, nonces,
 * payloads, and lease tokens, and return values contain full transaction records — none of these enter logs. The allowlist also ensures that future fields added to
 * `StoreCallRecord` never silently write business values into production logs.
 */
import type { StoreCallRecord } from '@dfr/transaction';

export const STORE_CALL_LOG_FIELDS = {
  requestId: 'request_id',
  traceId: 'trace_id',
  spanId: 'span_id',
  store: 'store',
  operation: 'operation',
  kind: 'kind',
  status: 'status',
  errorCode: 'error_code',
  latencyMs: 'latency_ms',
} as const satisfies Partial<Record<keyof StoreCallRecord, string>>;

/**
 * Fields known but **deliberately not logged**.
 *
 * Currently empty: every field of `StoreCallRecord` may enter logs (it was designed to hold "only the call shape").
 * This constant is kept so contract tests can distinguish "a new field was not classified" from "deliberately excluded".
 */
export const STORE_CALL_LOG_EXCLUDED: readonly (keyof StoreCallRecord)[] = [];

/**
 * `kind` is expanded in logs into the observability-spec span name (`store.read` / `store.write`),
 * so dashboards and Traces can align directly on span names without another mapping on the query side.
 */
export function storeCallLogFields(record: StoreCallRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceKey, logKey] of Object.entries(STORE_CALL_LOG_FIELDS) as [
    keyof StoreCallRecord,
    string,
  ][]) {
    const value = record[sourceKey];
    if (value !== undefined) out[logKey] = value;
  }
  out['span'] = record.kind === 'read' ? 'store.read' : 'store.write';
  out['level'] = record.status === 'success' ? 'info' : 'warn';
  out['msg'] = 'store call';
  return out;
}

/** Build the Store call log outlet; the outlet must never throw (observability failures do not affect business logic). */
export function createStoreCallLogger(
  write: (line: string) => void,
): (record: StoreCallRecord) => void {
  return (record) => {
    try {
      write(`${JSON.stringify(storeCallLogFields(record))}\n`);
    } catch {
      // Observability is best-effort.
    }
  };
}
