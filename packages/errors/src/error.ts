/**
 * DFR 统一错误（见 docs/architecture/error-spec-v0.1.md）。
 *
 * 规则：
 * - 所有对外错误必须由 `createDfrError()` 构造，禁止 `throw new Error('...')` 进入响应；
 * - 每条错误都带 requestId，便于跨日志检索；
 * - 与错误无关的内部异常只保留在 `cause`，不进入序列化结果。
 */
import type { ChainError, ChainId, DfrErrorCode, ErrorCategory, ProviderId, RequestId } from '@dfr/types';
import { ERROR_METADATA, type ErrorMetadata } from './metadata.js';
import { redactDetails, redactText } from './redact.js';

export interface CreateDfrErrorOptions {
  requestId: RequestId;
  /** 面向开发者、可直接展示的说明；会被脱敏。省略时使用元数据 title。 */
  message?: string;
  chain?: ChainId;
  provider?: ProviderId;
  details?: Record<string, unknown>;
  /** 来自链或 Provider 的原始错误；只保留 code + 已脱敏 message。 */
  chainError?: ChainError;
  /** 内部异常，仅用于日志与服务端排查，不序列化。 */
  cause?: unknown;
}

/**
 * DFR 领域错误。
 *
 * 继承 Error 以便 `instanceof` / 堆栈正常工作，同时携带规范要求的全部字段。
 */
export class DfrError extends Error {
  override readonly name = 'DfrError';

  readonly code: DfrErrorCode;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly title: string;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly requestId: RequestId;
  readonly chain?: ChainId;
  readonly provider?: ProviderId;
  readonly details?: Record<string, unknown>;
  readonly chainError?: ChainError;
  /** 内部原因；不进入任何序列化输出（见 toErrorResponse）。 */
  override readonly cause?: unknown;

  constructor(code: DfrErrorCode, metadata: ErrorMetadata, options: CreateDfrErrorOptions) {
    const message = redactText(options.message ?? metadata.title);
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    this.code = code;
    this.category = metadata.category;
    this.httpStatus = metadata.httpStatus;
    this.title = metadata.title;
    this.retryable = metadata.retryable;
    this.safeToRetry = metadata.safeToRetry;
    this.requestId = options.requestId;

    if (options.chain !== undefined) this.chain = options.chain;
    if (options.provider !== undefined) this.provider = options.provider;

    const details = options.details === undefined ? undefined : redactDetails(options.details);
    if (details !== undefined && Object.keys(details).length > 0) this.details = details;

    if (options.chainError !== undefined) {
      const rawMessage = options.chainError.message;
      const chainError: ChainError = {};
      if (options.chainError.code !== undefined) chainError.code = options.chainError.code;
      if (rawMessage !== undefined) chainError.message = redactText(rawMessage);
      this.chainError = chainError;
    }
  }

  /** 是否达到某个 HTTP 状态区间（网关做状态码映射时使用）。 */
  isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500;
  }

  isServerError(): boolean {
    return this.httpStatus >= 500;
  }
}

/** 统一错误工厂。 */
export function createDfrError(
  code: DfrErrorCode,
  options: CreateDfrErrorOptions,
): DfrError {
  const metadata = ERROR_METADATA[code];
  return new DfrError(code, metadata, options);
}

/** 类型守卫：跨包边界判断错误是否已被归一化。 */
export function isDfrError(value: unknown): value is DfrError {
  return value instanceof DfrError;
}

/**
 * 把任意异常归一化为 DfrError。
 *
 * 未分类异常降级为 `DFR_INTERNAL_ERROR` 并保留脱敏后的 cause message。
 * 分类不确定时不猜测（error-spec 第 5.2 章第 2 条）。
 */
export function toDfrError(
  cause: unknown,
  options: CreateDfrErrorOptions,
): DfrError {
  if (isDfrError(cause)) {
    // 已归一化的错误只补齐缺失的关联字段，不重新分类。
    if (cause.requestId === options.requestId) return cause;
    return createDfrError(cause.code, {
      requestId: options.requestId,
      message: cause.message,
      ...(cause.chain !== undefined ? { chain: cause.chain } : {}),
      ...(cause.provider !== undefined ? { provider: cause.provider } : {}),
      ...(cause.details !== undefined ? { details: cause.details } : {}),
      ...(cause.chainError !== undefined ? { chainError: cause.chainError } : {}),
      cause,
    });
  }

  const rawMessage = cause instanceof Error ? cause.message : String(cause);
  return createDfrError('DFR_INTERNAL_ERROR', {
    requestId: options.requestId,
    message: redactText(rawMessage),
    ...(options.chain !== undefined ? { chain: options.chain } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    cause,
  });
}
