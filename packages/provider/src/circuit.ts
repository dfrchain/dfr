/**
 * Circuit breaker (see docs/architecture/provider-spec-v0.1.md, chapter 7).
 *
 * Granularity: `(providerId, method category)`. Write and read categories must not share one circuit breaker,
 * or failures on the write path would wrongly hurt the read path.
 *
 * State machine: closed → open → half-open → closed.
 * - 5 consecutive failures, or an error rate > 50% within a 10s window → open
 * - open lasts 30s (exponential backoff, capped at 5min)
 * - on expiry, admit 1 probe; 3 consecutive successes → closed
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
  /** Half-open admits only 1 probe in flight (spec chapter 7: half-open probe count = 1). */
  private halfOpenProbeInFlight = false;

  constructor(private readonly options: CircuitOptions = DEFAULT_CIRCUIT_OPTIONS) {}

  get current(): CircuitState {
    return this.state;
  }

  /** Whether to admit this call. When open expires, move to half-open and admit 1 probe. */
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
    // half-open: admit only one probe; fail all other requests immediately to avoid a probe storm (spec chapter 7).
    if (this.halfOpenProbeInFlight) return false;
    this.halfOpenProbeInFlight = true;
    return true;
  }

  /** Open duration with exponential backoff: 30s the 1st time, 60s the 2nd, ... capped at 5min. */
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

  /** Observation data, for scoring and tests. */
  snapshot(now: number): { state: CircuitState; errorRate: number; consecutiveFailures: number } {
    this.prune(now);
    const failures = this.samples.filter((s) => !s.ok).length;
    const errorRate = this.samples.length === 0 ? 0 : failures / this.samples.length;
    return { state: this.state, errorRate, consecutiveFailures: this.consecutiveFailures };
  }

  /** For tests and ops: force a reset. */
  reset(): void {
    this.state = 'closed';
    this.samples.length = 0;
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.openCount = 0;
    this.halfOpenProbeInFlight = false;
  }
}
