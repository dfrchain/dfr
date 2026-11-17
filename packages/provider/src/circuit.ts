/**
 * 熔断器（见 docs/architecture/provider-spec-v0.1.md 第 7 章）。
 *
 * 粒度：`(providerId, method 类别)`。写类与读类不得共享同一个熔断器，
 * 否则写路径的失败会误伤读路径。
 *
 * 状态机：closed → open → half-open → closed。
 * - 连续 5 次失败，或 10s 窗口内错误率 > 50% → open
 * - open 持续 30s（指数退避，上限 5min）
 * - 到期放行 1 个探针；连续 3 次成功 → closed
 */
import type { CircuitState } from '@dfr/types';

export type MethodClass = 'read' | 'write';

export interface CircuitOptions {
  failureThreshold: number;
  errorRateThreshold: number;
  windowMs: number;
  openBaseMs: number;
  openMaxMs: number;
  halfOpenSuccesses: number;
}

export const DEFAULT_CIRCUIT_OPTIONS: CircuitOptions = {
  failureThreshold: 5,
  errorRateThreshold: 0.5,
  windowMs: 10_000,
  openBaseMs: 30_000,
  openMaxMs: 300_000,
  halfOpenSuccesses: 3,
};

interface Sample {
  at: number;
  ok: boolean;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private readonly samples: Sample[] = [];
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;
  private openCount = 0;
  /** half-open 只允许 1 个探针在飞行中（spec 第 7 章：半开探针数 = 1）。 */
  private halfOpenProbeInFlight = false;

  constructor(private readonly options: CircuitOptions = DEFAULT_CIRCUIT_OPTIONS) {}

  get current(): CircuitState {
    return this.state;
  }

  /** 是否放行本次调用。open 到期时转入 half-open 并放行 1 个探针。 */
  allow(now: number): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (now - this.openedAt >= this.openDurationMs()) {
        this.state = 'half-open';
        this.halfOpenSuccesses = 0;
        this.halfOpenProbeInFlight = true;
        return true;
      }
      return false;
    }
    // half-open：只放行一个探针，其余请求立即失败，避免探针风暴（spec 第 7 章）。
    if (this.halfOpenProbeInFlight) return false;
    this.halfOpenProbeInFlight = true;
    return true;
  }

  /** 打开时长指数退避：第 1 次 30s，第 2 次 60s，……上限 5min。 */
  private openDurationMs(): number {
    const exponent = Math.min(Math.max(this.openCount - 1, 0), 10);
    return Math.min(this.options.openBaseMs * 2 ** exponent, this.options.openMaxMs);
  }

  onSuccess(now: number): void {
    this.samples.push({ at: now, ok: true });
    this.consecutiveFailures = 0;
    this.halfOpenProbeInFlight = false;
    if (this.state === 'half-open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.options.halfOpenSuccesses) {
        this.state = 'closed';
        this.halfOpenSuccesses = 0;
        this.openCount = 0;
      }
    } else if (this.state === 'closed') {
      this.openCount = 0;
    }
    this.prune(now);
  }

  onFailure(now: number): void {
    this.samples.push({ at: now, ok: false });
    this.consecutiveFailures += 1;
    this.halfOpenProbeInFlight = false;
    this.prune(now);

    if (this.state === 'half-open') {
      this.trip(now);
      return;
    }
    if (this.state === 'closed' && this.shouldTrip()) {
      this.trip(now);
    }
  }

  private shouldTrip(): boolean {
    if (this.consecutiveFailures >= this.options.failureThreshold) return true;
    if (this.samples.length < 4) return false;
    const failures = this.samples.filter((s) => !s.ok).length;
    return failures / this.samples.length > this.options.errorRateThreshold;
  }

  private trip(now: number): void {
    this.state = 'open';
    this.openedAt = now;
    this.openCount += 1;
    this.halfOpenSuccesses = 0;
    this.halfOpenProbeInFlight = false;
  }

  private prune(now: number): void {
    const cutoff = now - this.options.windowMs;
    while (this.samples.length > 0 && (this.samples[0] as Sample).at < cutoff) {
      this.samples.shift();
    }
  }

  /** 观测数据，供评分与测试使用。 */
  snapshot(now: number): { state: CircuitState; errorRate: number; consecutiveFailures: number } {
    this.prune(now);
    const failures = this.samples.filter((s) => !s.ok).length;
    const errorRate = this.samples.length === 0 ? 0 : failures / this.samples.length;
    return { state: this.state, errorRate, consecutiveFailures: this.consecutiveFailures };
  }

  /** 测试与运维用：强制复位。 */
  reset(): void {
    this.state = 'closed';
    this.samples.length = 0;
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.openCount = 0;
    this.halfOpenProbeInFlight = false;
  }
}
