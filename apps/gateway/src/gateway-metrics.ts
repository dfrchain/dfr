/**
 * Gateway HTTP metrics (observability-spec section 5.1).
 *
 * Why they must exist: §5.6 lists `dfr_gateway_requests_total{status_code}` (API success rate) and
 * `dfr_gateway_request_duration_seconds` (API latency) as the **minimum metrics of requirements chapter 14**.
 * Before this module, neither existed at all — the platform's most basic availability signals could not be measured.
 *
 * All labels come from **bounded enums**; this is the module's most important design constraint:
 * - `route` uses the route handler id (`listChains` / `buildTransaction` / …) or `unmatched`,
 *   **never the raw path** — `/v1/transactions/0x…/confirm` would turn transaction hashes into labels (a cardinality disaster);
 * - `method` is only GET/POST; `status_code` is the finite set we can return ourselves;
 * - `chain` comes from the registry (bounded) or is `none`; `reason_code` / `route_class` / `outcome` are all small enums.
 *
 * Rendering and the cardinality fallback are provided by `@dfr/metrics`' `MetricRegistry` (the same implementation as the transaction metrics).
 */
import { MetricRegistry, type MetricRegistryOptions } from '@dfr/metrics';

/** Authentication failure reason (matching the `verifyApiKey` discriminated union). */
export type AuthFailureReason = 'missing' | 'malformed' | 'mismatch';
export type GatewayRouteClass = 'read' | 'write' | 'stream';
/** Idempotency outcome: a replay hit, or a same-key-different-body conflict. */
export type IdempotencyOutcome = 'replayed' | 'conflict';

export interface RecordRequestInput {
  /** Route handler id; `unmatched` when no route matched (including failures before authentication). */
  readonly route: string;
  readonly method: string;
  readonly statusCode: number;
  /** The chain involved; `none` when irrelevant or unknown. */
  readonly chain?: string;
  readonly durationSeconds: number;
}

const REQUESTS_TOTAL = 'dfr_gateway_requests_total';
const REQUEST_DURATION = 'dfr_gateway_request_duration_seconds';
const AUTH_FAILURES = 'dfr_gateway_auth_failures_total';
const RATE_LIMITED = 'dfr_gateway_rate_limited_total';
const IDEMPOTENCY_HITS = 'dfr_gateway_idempotency_hits_total';
const INFLIGHT = 'dfr_gateway_inflight_requests';
const DEPENDENCY_REJECTED = 'dfr_gateway_dependency_rejected_total';

export class GatewayMetrics {
  private readonly registry: MetricRegistry;
  /** In-flight request count (a gauge needs the total computed before writing; the registry itself does no increment/decrement). */
  private readonly inflight = new Map<GatewayRouteClass, number>();

  constructor(options: MetricRegistryOptions = {}) {
    this.registry = new MetricRegistry(options);
    this.registry.declareCounter(REQUESTS_TOTAL, 'Gateway HTTP requests by route, method and status.');
    this.registry.declareHistogram(
      REQUEST_DURATION,
      'Gateway HTTP request duration in seconds.',
    );
    this.registry.declareCounter(AUTH_FAILURES, 'Gateway authentication failures by reason.');
    this.registry.declareCounter(RATE_LIMITED, 'Gateway requests rejected by the rate limiter.');
    this.registry.declareCounter(
      IDEMPOTENCY_HITS,
      'Gateway idempotency outcomes (replayed or conflict).',
    );
    this.registry.declareGauge(INFLIGHT, 'Gateway in-flight requests by route class.');
    this.registry.declareCounter(DEPENDENCY_REJECTED, 'Gateway requests rejected because a required dependency is unavailable.');
  }

  recordRequest(input: RecordRequestInput): void {
    const route = input.route;
    const method = input.method;
    this.registry.increment(REQUESTS_TOTAL, {
      route,
      method,
      status_code: String(input.statusCode),
      chain: input.chain ?? 'none',
    });
    this.registry.observe(REQUEST_DURATION, { route, method }, input.durationSeconds);
  }

  recordAuthFailure(reason: AuthFailureReason): void {
    this.registry.increment(AUTH_FAILURES, { reason_code: reason });
  }

  recordRateLimited(routeClass: GatewayRouteClass): void {
    this.registry.increment(RATE_LIMITED, { route_class: routeClass });
  }

  recordDependencyRejected(routeClass: GatewayRouteClass): void {
    this.registry.increment(DEPENDENCY_REJECTED, { route_class: routeClass });
  }

  recordIdempotencyOutcome(outcome: IdempotencyOutcome): void {
    this.registry.increment(IDEMPOTENCY_HITS, { outcome });
  }

  /** Enter/leave one request; maintains the count internally and writes it to the gauge. */
  changeInflight(routeClass: GatewayRouteClass, delta: 1 | -1): void {
    const next = Math.max(0, (this.inflight.get(routeClass) ?? 0) + delta);
    this.inflight.set(routeClass, next);
    this.registry.setGauge(INFLIGHT, { route_class: routeClass }, next);
  }

  renderPrometheus(): string {
    return this.registry.renderPrometheus();
  }

  seriesCount(metric: string): number {
    return this.registry.seriesCount(metric);
  }
}
