/**
 * Unified error model (see docs/architecture/error-spec-v0.1.md).
 *
 * Rules:
 * - Error codes are a stable contract: only additions, never semantic changes; the runtime list is DFR_ERROR_CODES;
 * - detail is developer-facing and must not contain credentials, private keys, or raw signatures;
 * - chainError keeps only code and the redacted message.
 */
import type { ChainId, RequestId, ProviderId } from './primitives.js';

/**
 * The runtime list of error codes, the only fact source for `DfrErrorCode`.
 *
 * Exists as a constant array so the contract is machine-checkable: consistency tests assert this array is
 * exactly the same as the error-code sets in `docs/architecture/error-spec-v0.1.md` and `docs/api/openapi.yaml`
 * (see tests/contract/spec-consistency.test.ts).
 *
 * Error codes are a stable contract: only additions, never semantic changes.
 */
export const DFR_ERROR_CODES = [
  /* client */
  'DFR_INVALID_REQUEST',
  'DFR_VALIDATION_FAILED',
  'DFR_INVALID_ACCOUNT',
  'DFR_INVALID_ASSET',
  'DFR_NOT_FOUND',
  'DFR_UNSUPPORTED_CAPABILITY',
  'DFR_UNSUPPORTED_VERSION',
  'DFR_IDEMPOTENCY_CONFLICT',
  'DFR_PAYLOAD_TOO_LARGE',
  /* auth */
  'DFR_UNAUTHENTICATED',
  /** SSE one-time ticket invalid (expired/used/not found/binding mismatch — deliberately not distinguished, to avoid enumeration, ADR-029). */
  'DFR_INVALID_TICKET',
  'DFR_UNAUTHORIZED',
  'DFR_PROJECT_SCOPE_DENIED',
  'DFR_IP_NOT_ALLOWED',
  /* policy */
  'DFR_RATE_LIMITED',
  'DFR_QUOTA_EXCEEDED',
  'DFR_POLICY_DENIED',
  'DFR_APPROVAL_REQUIRED',
  'DFR_SPENDING_LIMIT_EXCEEDED',
  /* chain */
  'DFR_CHAIN_UNAVAILABLE',
  'DFR_CHAIN_MISMATCH',
  'DFR_CHAIN_REORG',
  'DFR_TRANSACTION_REVERTED',
  'DFR_TRANSACTION_REJECTED',
  'DFR_TRANSACTION_NOT_FOUND',
  'DFR_TRANSACTION_DROPPED',
  'DFR_TRANSACTION_REPLACED',
  'DFR_FINALITY_NOT_REACHED',
  'DFR_INSUFFICIENT_FUNDS',
  'DFR_NONCE_CONFLICT',
  'DFR_BLOCKHASH_EXPIRED',
  /* provider */
  'DFR_PROVIDER_UNAVAILABLE',
  'DFR_PROVIDER_TIMEOUT',
  'DFR_PROVIDER_RATE_LIMITED',
  'DFR_PROVIDER_INVALID_RESPONSE',
  'DFR_PROVIDER_CIRCUIT_OPEN',
  /* internal */
  'DFR_INTERNAL_ERROR',
  'DFR_NOT_IMPLEMENTED',
  'DFR_CONFIGURATION_ERROR',
  'DFR_SIGNING_FAILED',
] as const;

/** Error-code type derived from the runtime list. */
export type DfrErrorCode = (typeof DFR_ERROR_CODES)[number];

export type ErrorCategory =
  | 'client'
  | 'auth'
  | 'policy'
  | 'chain'
  | 'provider'
  | 'internal';

export interface ChainError {
  code?: string;
  /** Redacted raw information, for troubleshooting only. */
  message?: string;
}

export interface DfrError {
  code: DfrErrorCode;
  category: ErrorCategory;
  message: string;
  /** Whether the transport layer is worth retrying. */
  retryable: boolean;
  /** Whether the business layer can be safely executed again. */
  safeToRetry: boolean;
  requestId: RequestId;
  chain?: ChainId;
  provider?: ProviderId;
  /** Redacted supplementary information. */
  details?: Record<string, unknown>;
  chainError?: ChainError;
}
