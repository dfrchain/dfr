/**
 * HTTP 错误映射（见 docs/architecture/error-spec-v0.1.md 第 2 章）。
 *
 * 响应体 = RFC 9457 Problem Details + DFR 扩展字段。
 * 网关只做透传与状态码映射，不重新分类（gateway-spec 第 8 章）。
 */
import type { DfrErrorResponse } from '@dfr/types';
import type { DfrError } from './error.js';

/** 错误码文档站前缀，稳定契约的一部分。 */
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
 * 429 响应必须带 Retry-After；其余错误不写。
 *
 * 返回值为 HTTP 响应头集合，键名大小写不敏感。
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
