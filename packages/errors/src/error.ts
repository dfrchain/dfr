/**
 * DFR unified error (see docs/architecture/error-spec-v0.1.md).
 *
 * Rules:
 * - Every outward-facing error must be constructed by `createDfrError()`; `throw new Error('...')` must never reach a response;
 * - Every error carries a requestId for cross-log lookup;
 * - Internal exceptions unrelated to the error are kept only in `cause`, never in serialized output.
 */
import type { ChainError, ChainId, DfrErrorCode, ErrorCategory, ProviderId, RequestId } from '@dfr/types';
import { ERROR_METADATA, type ErrorMetadata } from './metadata.js';
import { redactDetails, redactText } from './redact.js';

export interface CreateDfrErrorOptions {
  requestId: RequestId;
  /** Developer-facing, display-ready explanation; it is redacted. When omitted, the metadata title is used. */
  message?: string;
  chain?: ChainId;
  provider?: ProviderId;
  details?: Record<string, unknown>;
  /** Raw error from the chain or Provider; only code + redacted message are kept. */
  chainError?: ChainError;
  /** Internal exception, only for logs and server-side debugging, never serialized. */
  cause?: unknown;
}

/**
 * DFR domain error.
 *
 * Extends Error so `instanceof` / stack traces work normally, while carrying every field the spec requires.
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
  /** Internal cause; never enters any serialized output (see toErrorResponse). */
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

  /** Whether it falls in a given HTTP status range (used by the gateway when mapping status codes). */
  isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500;
  }

  isServerError(): boolean {
    return this.httpStatus >= 500;
  }
}

/** Unified error factory. */
export function createDfrError(
  code: DfrErrorCode,
  options: CreateDfrErrorOptions,
): DfrError {
  const metadata = ERROR_METADATA[code];
  return new DfrError(code, metadata, options);
}

/** Type guard: decide across package boundaries whether an error has already been normalized. */
export function isDfrError(value: unknown): value is DfrError {
  return value instanceof DfrError;
}

/**
 * Normalize any exception into a DfrError.
 *
 * Unclassified exceptions degrade to `DFR_INTERNAL_ERROR`, keeping the redacted cause message.
 * When classification is uncertain, do not guess (error-spec section 5.2, rule 2).
 */
export function toDfrError(
  cause: unknown,
  options: CreateDfrErrorOptions,
): DfrError {
  if (isDfrError(cause)) {
    // An already-normalized error only gets its missing correlation fields filled in; it is not reclassified.
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
