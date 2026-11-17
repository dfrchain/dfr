/**
 * @dfr/errors —— DFR 统一错误模型。
 *
 * 规范来源：docs/architecture/error-spec-v0.1.md（DFR-011）
 */
export { ERROR_METADATA, KNOWN_ERROR_CODES, isKnownErrorCode } from './metadata.js';
export type { ErrorMetadata } from './metadata.js';
export { DfrError, createDfrError, isDfrError, toDfrError } from './error.js';
export type { CreateDfrErrorOptions } from './error.js';
export { ERROR_TYPE_BASE, toErrorResponse, errorHeaders } from './http.js';
export { redactText, redactDetails } from './redact.js';
export { newRequestId, isValidRequestId, resolveRequestId } from './request-id.js';
