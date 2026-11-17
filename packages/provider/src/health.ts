/**
 * Provider 健康与延迟窗口（见 docs/architecture/provider-spec-v0.1.md 第 4–5 章）。
 *
 * 只使用滑动窗口，不允许"上次成功就永远优先"的粘滞策略。
 */
import type { ProviderHealth, ProviderStatus } from '@dfr/types';

/** 滑动窗口容量。 */
const WINDOW_SIZE = 100;

export class HealthTracker {
  private readonly latencies: number[] = [];
  private readonly outcomes: boolean[] = [];
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private status: ProviderStatus = 'unknown';
  private lastCheckedAtMs = 0;

  recordSuccess(latencyMs: number, now: number): void {
    this.latencies.push(latencyMs);
    this.outcomes.push(true);
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses += 1;
    this.lastCheckedAtMs = now;

    if (this.status === 'unknown' || this.status === 'unhealthy') {
      if (this.consecutiveSuccesses >= 3) this.status = 'healthy';
      else if (this.consecutiveSuccesses >= 2) this.status = 'degraded';
    } else if (this.status === 'degraded' && this.consecutiveSuccesses >= 3) {
      this.status = 'healthy';
    }
    this.trim();
  }

  recordFailure(now: number): void {
    this.outcomes.push(false);
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    this.lastCheckedAtMs = now;

    if (this.consecutiveFailures >= 5) this.status = 'unhealthy';
    else if (this.consecutiveFailures >= 3 && this.status !== 'unhealthy') this.status = 'degraded';
    this.trim();
  }

  private trim(): void {
    while (this.latencies.length > WINDOW_SIZE) this.latencies.shift();
    while (this.outcomes.length > WINDOW_SIZE) this.outcomes.shift();
  }

  private percentile(p: number): number | undefined {
    if (this.latencies.length === 0) return undefined;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  errorRate(): number {
    if (this.outcomes.length === 0) return 0;
    const failures = this.outcomes.filter((ok) => !ok).length;
    return failures / this.outcomes.length;
  }

  latencyP50(): number | undefined {
    return this.percentile(50);
  }

  latencyP95(): number | undefined {
    return this.percentile(95);
  }

  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  get consecutiveSuccessCount(): number {
    return this.consecutiveSuccesses;
  }

  snapshot(now: number): ProviderHealth {
    const health: ProviderHealth = {
      status: this.status,
      lastCheckedAt: new Date(this.lastCheckedAtMs === 0 ? now : this.lastCheckedAtMs).toISOString() as ProviderHealth['lastCheckedAt'],
      consecutiveFailures: this.consecutiveFailures,
    };
    const p50 = this.latencyP50();
    const p95 = this.latencyP95();
    if (p50 !== undefined) health.latencyP50Ms = p50;
    if (p95 !== undefined) health.latencyP95Ms = p95;
    if (this.outcomes.length > 0) health.errorRate = this.errorRate();
    return health;
  }

  /** 健康检查周期：healthy 60s / degraded 15s / unhealthy 5s（指数退避上限 60s）。 */
  probeIntervalMs(): number {
    if (this.status === 'healthy') return 60_000;
    if (this.status === 'degraded') return 15_000;
    const base = 5_000;
    return Math.min(60_000, base * Math.max(1, this.consecutiveFailures));
  }

  /** 距下次允许探测的剩余毫秒数；<=0 表示可以探测。 */
  msUntilProbe(now: number): number {
    return Math.max(this.lastCheckedAtMs + this.probeIntervalMs() - now, 0);
  }

  get lastCheckedAt(): number {
    return this.lastCheckedAtMs;
  }
}
