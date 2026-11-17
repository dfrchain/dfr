/**
 * 错误码元数据表（见 docs/architecture/error-spec-v0.1.md 第 4 章）。
 *
 * 类型为 `Record<DfrErrorCode, ErrorMetadata>`：新增错误码却忘记补元数据时，
 * 这里会直接编译失败，而不是在运行时退化成一个没有 HTTP 状态的错误。
 */
import { DFR_ERROR_CODES, type DfrErrorCode, type ErrorCategory } from '@dfr/types';

export interface ErrorMetadata {
  category: ErrorCategory;
  httpStatus: number;
  /** 传输层是否值得重试（网络/超时/5xx 类）。 */
  retryable: boolean;
  /** 业务层是否可安全重复执行。 */
  safeToRetry: boolean;
  /** RFC 9457 title，稳定英文短语。 */
  title: string;
}

export const ERROR_METADATA: Readonly<Record<DfrErrorCode, ErrorMetadata>> = {
  /* client */
  DFR_INVALID_REQUEST: { category: 'client', httpStatus: 400, retryable: false, safeToRetry: false, title: 'Invalid request' },
  DFR_VALIDATION_FAILED: { category: 'client', httpStatus: 400, retryable: false, safeToRetry: false, title: 'Validation failed' },
  DFR_INVALID_ACCOUNT: { category: 'client', httpStatus: 422, retryable: false, safeToRetry: false, title: 'Invalid account' },
  DFR_INVALID_ASSET: { category: 'client', httpStatus: 422, retryable: false, safeToRetry: false, title: 'Invalid asset' },
  DFR_NOT_FOUND: { category: 'client', httpStatus: 404, retryable: false, safeToRetry: false, title: 'Not found' },
  DFR_UNSUPPORTED_CAPABILITY: { category: 'client', httpStatus: 422, retryable: false, safeToRetry: false, title: 'Unsupported capability' },
  DFR_UNSUPPORTED_VERSION: { category: 'client', httpStatus: 400, retryable: false, safeToRetry: false, title: 'Unsupported version' },
  DFR_IDEMPOTENCY_CONFLICT: { category: 'client', httpStatus: 409, retryable: false, safeToRetry: false, title: 'Idempotency conflict' },
  DFR_PAYLOAD_TOO_LARGE: { category: 'client', httpStatus: 413, retryable: false, safeToRetry: false, title: 'Payload too large' },

  /* auth */
  DFR_UNAUTHENTICATED: { category: 'auth', httpStatus: 401, retryable: false, safeToRetry: false, title: 'Unauthenticated' },
  DFR_INVALID_TICKET: { category: 'auth', httpStatus: 401, retryable: false, safeToRetry: false, title: 'Invalid ticket' },
  DFR_UNAUTHORIZED: { category: 'auth', httpStatus: 403, retryable: false, safeToRetry: false, title: 'Unauthorized' },
  DFR_PROJECT_SCOPE_DENIED: { category: 'auth', httpStatus: 403, retryable: false, safeToRetry: false, title: 'Project scope denied' },
  DFR_IP_NOT_ALLOWED: { category: 'auth', httpStatus: 403, retryable: false, safeToRetry: false, title: 'IP not allowed' },

  /* policy */
  DFR_RATE_LIMITED: { category: 'policy', httpStatus: 429, retryable: true, safeToRetry: true, title: 'Rate limited' },
  DFR_QUOTA_EXCEEDED: { category: 'policy', httpStatus: 429, retryable: false, safeToRetry: false, title: 'Quota exceeded' },
  DFR_POLICY_DENIED: { category: 'policy', httpStatus: 403, retryable: false, safeToRetry: false, title: 'Policy denied' },
  DFR_APPROVAL_REQUIRED: { category: 'policy', httpStatus: 409, retryable: false, safeToRetry: false, title: 'Approval required' },
  DFR_SPENDING_LIMIT_EXCEEDED: { category: 'policy', httpStatus: 403, retryable: false, safeToRetry: false, title: 'Spending limit exceeded' },

  /* chain */
  DFR_CHAIN_UNAVAILABLE: { category: 'chain', httpStatus: 503, retryable: true, safeToRetry: true, title: 'Chain unavailable' },
  DFR_CHAIN_MISMATCH: { category: 'chain', httpStatus: 502, retryable: false, safeToRetry: false, title: 'Chain mismatch' },
  DFR_CHAIN_REORG: { category: 'chain', httpStatus: 409, retryable: false, safeToRetry: true, title: 'Chain reorg' },
  DFR_TRANSACTION_REVERTED: { category: 'chain', httpStatus: 422, retryable: false, safeToRetry: false, title: 'Transaction reverted' },
  DFR_TRANSACTION_REJECTED: { category: 'chain', httpStatus: 422, retryable: false, safeToRetry: false, title: 'Transaction rejected' },
  DFR_TRANSACTION_NOT_FOUND: { category: 'chain', httpStatus: 404, retryable: false, safeToRetry: true, title: 'Transaction not found' },
  DFR_TRANSACTION_DROPPED: { category: 'chain', httpStatus: 409, retryable: false, safeToRetry: true, title: 'Transaction dropped' },
  DFR_TRANSACTION_REPLACED: { category: 'chain', httpStatus: 409, retryable: false, safeToRetry: false, title: 'Transaction replaced' },
  DFR_FINALITY_NOT_REACHED: { category: 'chain', httpStatus: 409, retryable: true, safeToRetry: true, title: 'Finality not reached' },
  DFR_INSUFFICIENT_FUNDS: { category: 'chain', httpStatus: 422, retryable: false, safeToRetry: false, title: 'Insufficient funds' },
  DFR_NONCE_CONFLICT: { category: 'chain', httpStatus: 409, retryable: false, safeToRetry: true, title: 'Nonce conflict' },
  DFR_BLOCKHASH_EXPIRED: { category: 'chain', httpStatus: 409, retryable: false, safeToRetry: true, title: 'Blockhash expired' },

  /* provider */
  DFR_PROVIDER_UNAVAILABLE: { category: 'provider', httpStatus: 503, retryable: true, safeToRetry: true, title: 'Provider unavailable' },
  DFR_PROVIDER_TIMEOUT: { category: 'provider', httpStatus: 504, retryable: true, safeToRetry: true, title: 'Provider timeout' },
  DFR_PROVIDER_RATE_LIMITED: { category: 'provider', httpStatus: 503, retryable: true, safeToRetry: true, title: 'Provider rate limited' },
  DFR_PROVIDER_INVALID_RESPONSE: { category: 'provider', httpStatus: 502, retryable: true, safeToRetry: true, title: 'Provider invalid response' },
  DFR_PROVIDER_CIRCUIT_OPEN: { category: 'provider', httpStatus: 503, retryable: true, safeToRetry: true, title: 'Provider circuit open' },

  /* internal */
  DFR_INTERNAL_ERROR: { category: 'internal', httpStatus: 500, retryable: false, safeToRetry: false, title: 'Internal error' },
  DFR_NOT_IMPLEMENTED: { category: 'internal', httpStatus: 501, retryable: false, safeToRetry: false, title: 'Not implemented' },
  DFR_CONFIGURATION_ERROR: { category: 'internal', httpStatus: 500, retryable: false, safeToRetry: false, title: 'Configuration error' },
  DFR_SIGNING_FAILED: { category: 'internal', httpStatus: 500, retryable: false, safeToRetry: false, title: 'Signing failed' },
};

/** 已知错误码集合，供网关与 SDK 校验外部输入。 */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(DFR_ERROR_CODES);

export function isKnownErrorCode(value: string): value is DfrErrorCode {
  return KNOWN_ERROR_CODES.has(value);
}
