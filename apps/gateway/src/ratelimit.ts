/**
 * Token-bucket rate limiting (see docs/architecture/gateway-spec-v0.1.md chapter 5).
 *
 * Bucket key `(projectId, keyId, routeClass)`; a token bucket, not a fixed window — a fixed window at the boundary
 * would admit 2x the traffic. Over-limit requests are refused directly, never queued.
 */
export type RouteClass = 'read' | 'write' | 'stream';

export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
}

export const DEFAULT_BUCKETS: Readonly<Record<RouteClass, BucketConfig>> = {
  read: { capacity: 40, refillPerSecond: 20 },
  write: { capacity: 10, refillPerSecond: 2 },
  stream: { capacity: 5, refillPerSecond: 1 },
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until next availability, for Retry-After. */
  retryAfterMs: number;
  limit: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly configs: Readonly<Record<RouteClass, BucketConfig>> = DEFAULT_BUCKETS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Effective bucket configuration, for the developer-facing `GET /v1/usage` limits block. */
  limits(): Readonly<Record<RouteClass, BucketConfig>> {
    return {
      read: { ...this.configs.read },
      write: { ...this.configs.write },
      stream: { ...this.configs.stream },
    };
  }

  check(scope: string, routeClass: RouteClass): RateLimitDecision {
    const config = this.configs[routeClass];
    const key = `${scope}:${routeClass}`;
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: config.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(config.capacity, bucket.tokens + (elapsed / 1000) * config.refillPerSecond);
    // When the system clock moves backward, keep the last refill watermark so tokens are not re-issued twice once time recovers.
    bucket.updatedAt = Math.max(bucket.updatedAt, now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
        limit: config.capacity,
      };
    }

    const deficit = 1 - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil((deficit / config.refillPerSecond) * 1000),
      limit: config.capacity,
    };
  }
}
