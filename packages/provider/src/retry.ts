/**
 * 重试策略（见 docs/architecture/provider-spec-v0.1.md 第 6 章）。
 *
 * | idempotency          | 自动重试                                       |
 * |----------------------|-----------------------------------------------|
 * | safe-read            | 是，最多 min(3, 可用 Provider 数)，不得重复同一 Provider |
 * | idempotent-write     | 谨慎，最多在同一 Provider 重试 1 次，需显式授权        |
 * | non-idempotent-write | 否（广播类，重复提交由上层按交易哈希去重）           |
 */
import { isDfrError } from '@dfr/errors';
import type { IdempotencyClass } from '@dfr/types';

/** 禁止重试的错误码（error-spec + provider-spec 第 6 章）。 */
const NEVER_RETRY_CODES: ReadonlySet<string> = new Set([
  'DFR_INVALID_REQUEST',
  'DFR_VALIDATION_FAILED',
  'DFR_INVALID_ACCOUNT',
  'DFR_INVALID_ASSET',
  'DFR_NOT_FOUND',
  'DFR_UNSUPPORTED_CAPABILITY',
  'DFR_UNSUPPORTED_VERSION',
  'DFR_IDEMPOTENCY_CONFLICT',
  'DFR_PAYLOAD_TOO_LARGE',
  'DFR_UNAUTHENTICATED',
  'DFR_UNAUTHORIZED',
  'DFR_PROJECT_SCOPE_DENIED',
  'DFR_IP_NOT_ALLOWED',
  'DFR_POLICY_DENIED',
  'DFR_SPENDING_LIMIT_EXCEEDED',
  'DFR_TRANSACTION_REVERTED',
  'DFR_TRANSACTION_REJECTED',
  'DFR_INSUFFICIENT_FUNDS',
]);

/** 指数退避基数（毫秒）：50 / 150 / 400。 */
export const BACKOFF_SCHEDULE_MS = [50, 150, 400] as const;

export interface RetryDecision {
  retry: boolean;
  /** 需要重试时使用的退避时长（含抖动）。 */
  delayMs?: number;
}

export interface RetryInput {
  error: unknown;
  idempotency: IdempotencyClass;
  /** 已完成的尝试次数（首次调用后为 1）。 */
  attempts: number;
  /** safe-read 的重试预算：min(3, 可用 Provider 数)。 */
  safeReadBudget: number;
  /** 是否还有未被尝试过的 Provider。 */
  hasUntriedProvider: boolean;
  /** idempotent-write 是否被显式授权重试同一 Provider。 */
  allowIdempotentWriteRetry: boolean;
  /** 随机抖动来源 0..1。 */
  jitter: number;
}

/** 判定是否重试；纯函数，便于逐条回归映射表。 */
export function decideRetry(input: RetryInput): RetryDecision {
  const { error, idempotency } = input;
  if (!isDfrError(error)) return { retry: false };

  // HTTP 4xx（除 408/429）禁止重试。上游状态在 details.httpStatus 里。
  const httpStatus = error.details?.['httpStatus'];
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
    if (httpStatus !== 408 && httpStatus !== 429) return { retry: false };
  }

  switch (idempotency) {
    case 'non-idempotent-write':
      // 广播类绝不自动重试 —— 这是防资金事故的核心约束。
      return { retry: false };
    case 'idempotent-write': {
      if (!input.allowIdempotentWriteRetry) return { retry: false };
      if (NEVER_RETRY_CODES.has(error.code)) return { retry: false };
      if (input.attempts >= 2) return { retry: false };
      return { retry: true, delayMs: withJitter(BACKOFF_SCHEDULE_MS[0], input.jitter) };
    }
    case 'safe-read': {
      if (NEVER_RETRY_CODES.has(error.code)) return { retry: false };
      if (!error.retryable) return { retry: false };
      if (input.attempts >= input.safeReadBudget) return { retry: false };
      if (!input.hasUntriedProvider) return { retry: false };
      const base = BACKOFF_SCHEDULE_MS[Math.min(input.attempts - 1, BACKOFF_SCHEDULE_MS.length - 1)] ?? 400;
      return { retry: true, delayMs: withJitter(base, input.jitter) };
    }
    default:
      return { retry: false };
  }
}

function withJitter(baseMs: number, jitter: number): number {
  const clamped = Math.min(1, Math.max(0, jitter));
  // ±30% 抖动，避免多个调用方同时重试造成同步风暴。
  return Math.round(baseMs * (0.7 + 0.6 * clamped));
}
