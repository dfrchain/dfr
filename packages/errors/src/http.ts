/**
 * HTTP error mapping (see docs/architecture/error-spec-v0.1.md chapter 2).
 *
 * Response body = RFC 9457 Problem Details + DFR extension fields.
 * The gateway only passes through and maps status codes; it does not reclassify (gateway-spec chapter 8).
 */
import type { DfrErrorResponse } from '@dfr/types';
import type { DfrError } from './error.js';

/** Error-code documentation site prefix, part of the stable contract. */
export const ERROR_TYPE_BASE = 'https://docs.dfr.example/errors';

export function toErrorResponse(error: DfrError, instance?: string): DfrErrorResponse {
  const body: DfrErrorResponse = {
    type: `${ERROR_TYPE_BASE}/${error.code}`,
    title: error.title,
    status: error.httpStatus,
    detail: error.message,
    dfr_code: error.code,
    category: error.category,
    retryable: error.retryable,
    safe_to_retry: error.safeToRetry,
    request_id: error.requestId,
  };
  if (instance !== undefined) body.instance = instance;
  if (error.chain !== undefined) body.chain = error.chain;
  if (error.provider !== undefined) body.provider = error.provider;
  if (error.details !== undefined) body.details = error.details;
  if (error.chainError !== undefined) body.chain_error = error.chainError;
  return body;
}

/**
 * A 429 response must carry Retry-After; other errors omit it.
 *
 * Return value is a set of HTTP response headers; key names are case-insensitive.
 */
export function errorHeaders(error: DfrError): Record<string, string> {
  const headers: Record<string, string> = {};
  if (error.code === 'DFR_RATE_LIMITED') {
    const retryAfterMs = error.details?.['retryAfterMs'];
    const seconds = typeof retryAfterMs === 'number' ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 1;
    headers['Retry-After'] = String(seconds);
  }
  return headers;
}
