import { describe, expect, it } from 'vitest';
import { DFR_ERROR_CODES } from '@dfr/types';
import type { DfrErrorCode, RequestId } from '@dfr/types';
import {
  DfrError,
  ERROR_METADATA,
  createDfrError,
  errorHeaders,
  isDfrError,
  isValidRequestId,
  newRequestId,
  redactDetails,
  redactText,
  resolveRequestId,
  toDfrError,
  toErrorResponse,
} from '../src/index.js';

const requestId = 'req_01J8Z6W3Q2K9M4ABCDEFGHJK' as RequestId;

describe('错误元数据完整性（error-spec 第 4 章）', () => {
  it('每个错误码都有唯一元数据，且无多余条目', () => {
    expect(Object.keys(ERROR_METADATA).sort()).toEqual([...DFR_ERROR_CODES].sort());
  });

  it('每类错误映射到规范规定的 HTTP 区间', () => {
    const ranges: Record<string, [number, number]> = {
      client: [400, 422],
      auth: [401, 403],
      policy: [403, 429],
      chain: [404, 503],
      provider: [502, 504],
      internal: [500, 501],
    };
    for (const [code, meta] of Object.entries(ERROR_METADATA)) {
      const [lo, hi] = ranges[meta.category]!;
      expect(meta.httpStatus, code).toBeGreaterThanOrEqual(lo);
      expect(meta.httpStatus, code).toBeLessThanOrEqual(hi);
    }
  });

  it('限流可重试、配额不可重试（gateway-spec 第 6 章）', () => {
    expect(ERROR_METADATA.DFR_RATE_LIMITED.retryable).toBe(true);
    expect(ERROR_METADATA.DFR_QUOTA_EXCEEDED.retryable).toBe(false);
    expect(ERROR_METADATA.DFR_QUOTA_EXCEEDED.safeToRetry).toBe(false);
  });

  it('广播被拒绝时不可安全重试（防资金事故）', () => {
    expect(ERROR_METADATA.DFR_TRANSACTION_REJECTED.safeToRetry).toBe(false);
    expect(ERROR_METADATA.DFR_TRANSACTION_REVERTED.safeToRetry).toBe(false);
  });
});

describe('错误的 HTTP 区间判定（error-spec 第 4 章，规范要求 100% 覆盖）', () => {
  it('每个错误码的 isClientError / isServerError 与它的 httpStatus 一致', () => {
    // 这两个方法此前没有用例（testing-strategy §8 把"错误映射"列为 100% 门槛）。
    // 逐码断言还有一层价值：任何把 4xx 错标成 5xx（或反之）的元数据改动都会被抓到。
    for (const code of DFR_ERROR_CODES) {
      const error = createDfrError(code, { requestId });
      const status = ERROR_METADATA[code].httpStatus;
      if (status >= 400 && status < 500) {
        expect(error.isClientError(), `${code} (${status}) 应为 client error`).toBe(true);
        expect(error.isServerError(), `${code} (${status}) 不应为 server error`).toBe(false);
      } else {
        expect(error.isServerError(), `${code} (${status}) 应为 server error`).toBe(true);
        expect(error.isClientError(), `${code} (${status}) 不应为 client error`).toBe(false);
      }
    }
  });

  it('存在客户端错误与服务端错误两类样本（否则上一条可能恒真）', () => {
    const statuses = Object.values(ERROR_METADATA).map((m) => m.httpStatus);
    expect(statuses.some((s) => s >= 400 && s < 500), '样本里必须有 4xx').toBe(true);
    expect(statuses.some((s) => s >= 500), '样本里必须有 5xx').toBe(true);
  });
});

describe('错误工厂', () => {
  it('携带 code/category/retryable/safeToRetry/requestId', () => {
    const err = createDfrError('DFR_PROVIDER_TIMEOUT', {
      requestId,
      message: 'Provider ethereum-sepolia-secondary timed out after 10000ms',
      chain: 'ethereum-sepolia' as never,
      provider: 'ethereum-sepolia-secondary' as never,
      details: { timeoutMs: 10000, attempts: 3 },
    });
    expect(err).toBeInstanceOf(DfrError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(err.category).toBe('provider');
    expect(err.httpStatus).toBe(504);
    expect(err.retryable).toBe(true);
    expect(err.safeToRetry).toBe(true);
    expect(err.requestId).toBe(requestId);
    expect(isDfrError(err)).toBe(true);
  });

  it('缺少 message 时使用元数据 title', () => {
    const err = createDfrError('DFR_INVALID_ACCOUNT', { requestId });
    expect(err.message).toBe('Invalid account');
    expect(err.httpStatus).toBe(422);
  });
});

describe('HTTP 封套（RFC 9457 + DFR 扩展）', () => {
  it('必填字段齐全，instance 可选', () => {
    const err = createDfrError('DFR_UNAUTHENTICATED', { requestId });
    const body = toErrorResponse(err, '/v1/chains');
    expect(body).toMatchObject({
      type: 'https://docs.dfr.example/errors/DFR_UNAUTHENTICATED',
      title: 'Unauthenticated',
      status: 401,
      dfr_code: 'DFR_UNAUTHENTICATED',
      category: 'auth',
      retryable: false,
      safe_to_retry: false,
      request_id: requestId,
      instance: '/v1/chains',
    });
    expect(JSON.stringify(body)).not.toContain('cause');
  });

  it('429 带 Retry-After，其余不带', () => {
    const limited = createDfrError('DFR_RATE_LIMITED', {
      requestId,
      details: { retryAfterMs: 1500 },
    });
    expect(errorHeaders(limited)['Retry-After']).toBe('2');

    const denied = createDfrError('DFR_UNAUTHORIZED', { requestId });
    expect(errorHeaders(denied)).toEqual({});
  });
});

describe('脱敏（error-spec 第 6 章，验收项）', () => {
  it('剥离 endpoint 查询串中的 key/token', () => {
    const out = redactText('request failed: https://rpc.example.com/v1?apikey=SEKRET123&foo=1');
    expect(out).not.toContain('SEKRET123');
    expect(out).toContain('[redacted]');
  });

  it('剥离 Bearer / JWT / 厂商 Key 前缀', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g')).toContain('[redacted-jwt]');
    // 这是为脱敏回归故意构造的假 Key，不是真实凭证。
    expect(redactText('using sk-abcdefghijklmnopqrstuvwxyz')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz'); // secret-scan:allow redaction-fixture
  });

  it('剥离私钥赋值与助记词', () => {
    expect(redactText('private_key=0x' + 'a'.repeat(64))).toContain('[redacted-key]');
    expect(redactText('mnemonic: "abandon ability able about above absent"')).not.toContain('abandon ability'); // secret-scan:allow redaction-fixture
  });

  it('redactDetails 删除凭证类键并限制深度', () => {
    const out = redactDetails({
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz', // secret-scan:allow redaction-fixture
      timeout_ms: 10000,
      nested: { secret: 'shhh', relayed: 'https://rpc.example.com?token=abc123' },
    });
    expect(out?.['apiKey']).toBe('[redacted]');
    expect(out?.['timeout_ms']).toBe(10000);
    expect(JSON.stringify(out)).not.toContain('abc123');
  });

  it('错误对象序列化后不含凭证', () => {
    const err = createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId,
      message: 'endpoint https://rpc.example.com/?apikey=SUPERSECRET failed',
      details: { authorization: 'Bearer SUPERSECRET', attempts: 3 },
      chainError: { code: '-32000', message: 'token=SUPERSECRET rejected' },
    });
    const serialized = JSON.stringify(toErrorResponse(err, '/v1/balances'));
    expect(serialized).not.toContain('SUPERSECRET');
  });

  it('错误 details 中的 signedPayload 与 Provider credential 均被替换', () => {
    const err = createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId,
      message: 'provider rejected signed payload',
      details: { signedPayload: '0xdeadbeef', credential: 'CREDENTIAL_FIXTURE' },
    });
    const serialized = JSON.stringify(toErrorResponse(err, '/v1/transactions/broadcast'));
    expect(serialized).not.toContain('0xdeadbeef');
    expect(serialized).not.toContain('CREDENTIAL_FIXTURE');
  });
});

describe('requestId', () => {
  it('生成 req_ + 26 位 Crockford base32', () => {
    const id = newRequestId();
    expect(id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isValidRequestId(id)).toBe(true);
  });

  it('单调递增：同一毫秒内时间前缀一致，随机段不同', () => {
    const a = newRequestId(1_700_000_000_000);
    const b = newRequestId(1_700_000_000_000);
    expect(a.slice(4, 14)).toBe(b.slice(4, 14));
    expect(a).not.toBe(b);
  });

  it('非法外部值被替换为新 ID，合法值被沿用', () => {
    expect(resolveRequestId('not-a-request-id')).not.toBe('not-a-request-id');
    const valid = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN';
    expect(resolveRequestId(valid)).toBe(valid);
    expect(resolveRequestId(undefined)).toMatch(/^req_/);
  });
});

describe('toDfrError 归一化', () => {
  it('未知异常降级为 DFR_INTERNAL_ERROR 并保留脱敏原因', () => {
    const err = toDfrError(new Error('boom at https://rpc.example.com?apikey=HIDDEN'), { requestId });
    expect(err.code).toBe('DFR_INTERNAL_ERROR');
    expect(err.httpStatus).toBe(500);
    expect(JSON.stringify(err.message)).not.toContain('HIDDEN');
  });

  it('已知 DfrError 保持原错误码，不重新分类', () => {
    const original = createDfrError('DFR_CHAIN_MISMATCH', { requestId });
    const normalized = toDfrError(original, { requestId });
    expect(normalized.code).toBe('DFR_CHAIN_MISMATCH');
    expect(normalized).toBe(original);
  });
});

describe('错误码是稳定契约', () => {
  it('40 个错误码全部可由工厂构造（M2-C03 新增 DFR_INVALID_TICKET）', () => {
    const codes = DFR_ERROR_CODES as readonly DfrErrorCode[];
    expect(codes.length).toBe(40);
    for (const code of codes) {
      const err = createDfrError(code, { requestId });
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });
});
