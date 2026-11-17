/**
 * Gateway HTTP 指标（observability-spec 第 5.1 节）。
 *
 * 为什么必须有：§5.6 把 `dfr_gateway_requests_total{status_code}`（API 成功率）与
 * `dfr_gateway_request_duration_seconds`（API 延迟）列为**需求第 14 章的最低指标**。
 * 在本模块之前这两项完全没有实现——平台最基础的可用性信号无法度量。
 *
 * 标签全部取自**有界枚举**，这是本模块最重要的设计约束：
 * - `route` 用路由 handler id（`listChains` / `buildTransaction` / …）或 `unmatched`，
 *   **绝不使用原始 path**——`/v1/transactions/0x…/confirm` 会把交易哈希变成标签（基数灾难）；
 * - `method` 只有 GET/POST；`status_code` 是我们自己能返回的有限集合；
 * - `chain` 来自注册表（有界）或 `none`；`reason_code` / `route_class` / `outcome` 都是小枚举。
 *
 * 渲染与基数兜底由 `@dfr/metrics` 的 `MetricRegistry` 提供（与交易指标同一实现）。
 */
import { MetricRegistry, type MetricRegistryOptions } from '@dfr/metrics';

/** 认证失败原因（与 `verifyApiKey` 的判别联合一致）。 */
export type AuthFailureReason = 'missing' | 'malformed' | 'mismatch';
export type GatewayRouteClass = 'read' | 'write' | 'stream';
/** 幂等结果：命中重放，或同键不同体的冲突。 */
export type IdempotencyOutcome = 'replayed' | 'conflict';

export interface RecordRequestInput {
  /** 路由 handler id；未匹配到路由（含鉴权前失败）时为 `unmatched`。 */
  readonly route: string;
  readonly method: string;
  readonly statusCode: number;
  /** 涉及的链；无关或未知时为 `none`。 */
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
  /** 在途请求计数（gauge 需要先算出总量再写入，注册表本身不做增减）。 */
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

  /** 进入/离开一次请求；内部维护计数并写入 gauge。 */
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
