/**
 * Retry policy (see docs/architecture/provider-spec-v0.1.md, chapter 6).
 *
 * | idempotency          | auto-retry                                       |
 * |----------------------|-----------------------------------------------|
 * | safe-read            | yes, at most min(3, available Provider count), never the same Provider twice |
 * | idempotent-write     | cautious, at most 1 retry on the same Provider, explicit authorization required        |
 * | non-idempotent-write | no (broadcasts; duplicate submissions are deduped upstream by transaction hash)           |
 */
import { isDfrError } from '@dfr/errors';
import type { IdempotencyClass } from '@dfr/types';

/** Error codes that forbid retry (error-spec + provider-spec chapter 6). */
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

/** Exponential backoff base (milliseconds): 50 / 150 / 400. */
export const BACKOFF_SCHEDULE_MS = [50, 150, 400] as const;

export interface RetryDecision {
  retry: boolean;
  /** The backoff duration to use when a retry is needed (with jitter). */
  delayMs?: number;
}

export interface RetryInput {
  error: unknown;
  idempotency: IdempotencyClass;
  /** The number of attempts completed (1 after the first call). */
  attempts: number;
  /** The safe-read retry budget: min(3, available Provider count). */
  safeReadBudget: number;
  /** Whether any Provider has not been tried yet. */
  hasUntriedProvider: boolean;
  /** Whether idempotent-write is explicitly authorized to retry on the same Provider. */
  allowIdempotentWriteRetry: boolean;
  /** The random jitter source, 0..1. */
  jitter: number;
}

/** Decide whether to retry; a pure function, easy to map to regression cases one by one. */
export function decideRetry(input: RetryInput): RetryDecision {
  const { error, idempotency } = input;
  if (!isDfrError(error)) return { retry: false };

  // HTTP 4xx (except 408/429) forbid retry. The upstream status is in details.httpStatus.
  const httpStatus = error.details?.['httpStatus'];
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
    if (httpStatus !== 408 && httpStatus !== 429) return { retry: false };
  }

  switch (idempotency) {
    case 'non-idempotent-write':
      // Broadcasts are never auto-retried — this is the core constraint against funds accidents.
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
  // ±30% jitter, so multiple callers retrying at once do not create a synchronized storm.
  return Math.round(baseMs * (0.7 + 0.6 * clamped));
}
