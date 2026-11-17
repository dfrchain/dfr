/**
 * 令牌桶限流（见 docs/architecture/gateway-spec-v0.1.md 第 5 章）。
 *
 * 桶键 `(projectId, keyId, routeClass)`；令牌桶而非固定窗口 —— 固定窗口在边界
 * 会放行 2 倍流量。超限直接拒绝，不排队。
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
  /** 距下次可用的毫秒数，供 Retry-After 使用。 */
  retryAfterMs: number;
  limit: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly configs: Readonly<Record<RouteClass, BucketConfig>> = DEFAULT_BUCKETS,
    private readonly now: () => number = () => Date.now(),
  ) {}

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
    // 系统时钟回拨时保持上次计时水位，防止时间恢复后重复补发令牌。
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
