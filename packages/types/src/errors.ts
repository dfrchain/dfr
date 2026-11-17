/**
 * 统一错误模型（见 docs/architecture/error-spec-v0.1.md）。
 *
 * 规则：
 * - 错误码是稳定契约，只增不改语义；运行时清单见 DFR_ERROR_CODES；
 * - detail 面向开发者，不得包含凭证、私钥、签名原文；
 * - chainError 只保留 code 与已脱敏 message。
 */
import type { ChainId, RequestId, ProviderId } from './primitives.js';

/**
 * 错误码的运行时清单，是 `DfrErrorCode` 的唯一事实来源。
 *
 * 以常量数组形式存在，使契约可被机器校验：一致性测试会断言本数组与
 * `docs/architecture/error-spec-v0.1.md`、`docs/api/openapi.yaml` 中的错误码集合完全相同
 * （见 tests/contract/spec-consistency.test.ts）。
 *
 * 错误码是稳定契约：只增不改语义。
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
  /** SSE 一次性票据无效（过期/已用/未找到/绑定不匹配——统一不区分原因，避免枚举，ADR-029）。 */
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

/** 由运行时清单派生的错误码类型。 */
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
  /** 已脱敏的原始信息，仅供排障。 */
  message?: string;
}

export interface DfrError {
  code: DfrErrorCode;
  category: ErrorCategory;
  message: string;
  /** 传输层是否值得重试。 */
  retryable: boolean;
  /** 业务层是否可安全重复执行。 */
  safeToRetry: boolean;
  requestId: RequestId;
  chain?: ChainId;
  provider?: ProviderId;
  /** 已脱敏的补充信息。 */
  details?: Record<string, unknown>;
  chainError?: ChainError;
}
