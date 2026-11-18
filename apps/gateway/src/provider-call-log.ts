/**
 * Provider call records → structured log fields (DFR-M1-E02 observability supplement).
 *
 * Authoritative sources: docs/architecture/observability-spec-v0.1.md sections 3/7 (unified correlation fields and redaction rules),
 * provider-spec chapter 9 (the `ProviderCallRecord` fields).
 *
 * Why an explicit allowlist is needed: `ProviderCallRecord` is defined by `@dfr/provider` and may gain fields in the future.
 * If `JSON.stringify(record)` were logged directly, a new field (e.g. an endpoint, a credential reference, a request body)
 * would silently enter production logs, and such leaks are nearly impossible to remediate afterwards. So only allowlisted fields are picked here,
 * and `apps/gateway/test/provider-call-log.test.ts` asserts "every field of the record is either in the allowlist
 * or in the explicit exclusion list" — a new field fails the test immediately, forcing a human to confirm whether it may enter logs.
 */
import type { ProviderCallRecord } from '@dfr/provider';

/**
 * Fields allowed into logs, mapped to the unified snake_case names of observability-spec chapter 3.
 *
 * Deliberately excluded: `network` and `providerKind` (internal topology details, not currently in the spec naming table);
 * more importantly — the record itself **contains no** endpoint / credential / request body / response body.
 */
export const PROVIDER_CALL_LOG_FIELDS = {
  requestId: 'request_id',
  traceId: 'trace_id',
  spanId: 'span_id',
  chain: 'chain',
  providerId: 'provider_id',
  method: 'method',
  methodClass: 'method_class',
  status: 'status',
  errorCode: 'error_code',
  latencyMs: 'latency_ms',
  retryCount: 'retry_count',
  circuitState: 'circuit_state',
  scoreAtCall: 'score_at_call',
  failover: 'failover',
} as const satisfies Partial<Record<keyof ProviderCallRecord, string>>;

/**
 * Fields known but **deliberately not logged**; they must be listed explicitly, or the contract test below cannot distinguish
 * "forgot to add" from "deliberately excluded".
 */
export const PROVIDER_CALL_LOG_EXCLUDED: readonly (keyof ProviderCallRecord)[] = [
  'network',
  'providerKind',
];

/** Build log fields from one call record; take only allowlisted keys, dropping all undefined values. */
export function providerCallLogFields(record: ProviderCallRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceKey, logKey] of Object.entries(PROVIDER_CALL_LOG_FIELDS) as [
    keyof ProviderCallRecord,
    string,
  ][]) {
    const value = record[sourceKey];
    if (value !== undefined) out[logKey] = value;
  }
  // Useful for dashboards by failure rate and circuit-breaker state; does not affect redaction.
  out['level'] = record.status === 'success' ? 'info' : 'warn';
  out['msg'] = 'provider call';
  return out;
}

/**
 * Build the log outlet for `DfrCore.onProviderCall`.
 *
 * `write` injection point: production passes `process.stdout.write`; tests can capture the output.
 * The returned callback **must never throw**: observability failures cannot affect the call path being observed.
 */
export function createProviderCallLogger(
  write: (line: string) => void,
): (record: ProviderCallRecord) => void {
  return (record) => {
    try {
      write(`${JSON.stringify(providerCallLogFields(record))}\n`);
    } catch {
      // Observability is best-effort: even serialization failures must not bubble up to the Provider call stack.
    }
  };
}
