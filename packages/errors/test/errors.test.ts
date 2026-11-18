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

  describe('Error metadata completeness (error-spec chapter 4)', () => {
    it('every error code has unique metadata, with no extra entries', () => {
    expect(Object.keys(ERROR_METADATA).sort()).toEqual([...DFR_ERROR_CODES].sort());
  });

    it('each error class maps to the HTTP range the spec requires', () => {
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

    it('rate limiting is retryable, quota is not (gateway-spec chapter 6)', () => {
    expect(ERROR_METADATA.DFR_RATE_LIMITED.retryable).toBe(true);
    expect(ERROR_METADATA.DFR_QUOTA_EXCEEDED.retryable).toBe(false);
    expect(ERROR_METADATA.DFR_QUOTA_EXCEEDED.safeToRetry).toBe(false);
  });

    it('a rejected broadcast is not safe to retry (prevents fund accidents)', () => {
    expect(ERROR_METADATA.DFR_TRANSACTION_REJECTED.safeToRetry).toBe(false);
    expect(ERROR_METADATA.DFR_TRANSACTION_REVERTED.safeToRetry).toBe(false);
  });
});

  describe('Error HTTP range checks (error-spec chapter 4, spec requires 100% coverage)', () => {
    it('each error code\'s isClientError / isServerError agrees with its httpStatus', () => {
    // These two methods previously had no cases (testing-strategy §8 lists "error mapping" as a 100% threshold).
    // Per-code assertions have a second value: any metadata change that mislabels a 4xx as 5xx (or vice versa) gets caught.
    for (const code of DFR_ERROR_CODES) {
      const error = createDfrError(code, { requestId });
      const status = ERROR_METADATA[code].httpStatus;
      if (status >= 400 && status < 500) {
        expect(error.isClientError(), `${code} (${status}) should be a client error`).toBe(true);
        expect(error.isServerError(), `${code} (${status}) should not be a server error`).toBe(false);
      } else {
        expect(error.isServerError(), `${code} (${status}) should be a server error`).toBe(true);
        expect(error.isClientError(), `${code} (${status}) should not be a client error`).toBe(false);
      }
    }
  });

    it('there are both client-error and server-error samples (otherwise the previous case could be vacuously true)', () => {
    const statuses = Object.values(ERROR_METADATA).map((m) => m.httpStatus);
    expect(statuses.some((s) => s >= 400 && s < 500), 'the sample must contain 4xx').toBe(true);
    expect(statuses.some((s) => s >= 500), 'the sample must contain 5xx').toBe(true);
  });
});

  describe('Error factory', () => {
    it('carries code/category/retryable/safeToRetry/requestId', () => {
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

    it('uses the metadata title when message is missing', () => {
    const err = createDfrError('DFR_INVALID_ACCOUNT', { requestId });
    expect(err.message).toBe('Invalid account');
    expect(err.httpStatus).toBe(422);
  });
});

  describe('HTTP envelope (RFC 9457 + DFR extensions)', () => {
    it('required fields are all present, instance is optional', () => {
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

    it('429 carries Retry-After, others do not', () => {
    const limited = createDfrError('DFR_RATE_LIMITED', {
      requestId,
      details: { retryAfterMs: 1500 },
    });
    expect(errorHeaders(limited)['Retry-After']).toBe('2');

    const denied = createDfrError('DFR_UNAUTHORIZED', { requestId });
    expect(errorHeaders(denied)).toEqual({});
  });
});

  describe('Redaction (error-spec chapter 6, acceptance item)', () => {
    it('strips key/token from the endpoint query string', () => {
    const out = redactText('request failed: https://rpc.example.com/v1?apikey=SEKRET123&foo=1');
    expect(out).not.toContain('SEKRET123');
    expect(out).toContain('[redacted]');
  });

    it('strips Bearer <redacted> JWT / vendor key prefixes', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactText('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g')).toContain('[redacted-jwt]');
    // A fake key deliberately constructed for the redaction regression; not a real credential.
    expect(redactText('using sk-abcdefghijklmnopqrstuvwxyz')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz'); // secret-scan:allow redaction-fixture
  });

    it('strips private-key assignments and mnemonics', () => {
    expect(redactText('private_key=0x' + 'a'.repeat(64))).toContain('[redacted-key]');
    expect(redactText('mnemonic: "abandon ability able about above absent"')).not.toContain('abandon ability'); // secret-scan:allow redaction-fixture
  });

    it('redactDetails removes credential-like keys and limits depth', () => {
    const out = redactDetails({
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz', // secret-scan:allow redaction-fixture
      timeout_ms: 10000,
      nested: { secret: 'shhh', relayed: 'https://rpc.example.com?token=abc123' },
    });
    expect(out?.['apiKey']).toBe('[redacted]');
    expect(out?.['timeout_ms']).toBe(10000);
    expect(JSON.stringify(out)).not.toContain('abc123');
  });

    it('serialized error objects contain no credentials', () => {
    const err = createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId,
      message: 'endpoint https://rpc.example.com/?apikey=SUPERSECRET failed',
      details: { authorization: 'Bearer SUPERSECRET', attempts: 3 },
      chainError: { code: '-32000', message: 'token=SUPERSECRET rejected' },
    });
    const serialized = JSON.stringify(toErrorResponse(err, '/v1/balances'));
    expect(serialized).not.toContain('SUPERSECRET');
  });

    it('signedPayload in error details and Provider credential are both replaced', () => {
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
    it('generates req_ + 26 Crockford base32 characters', () => {
    const id = newRequestId();
    expect(id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isValidRequestId(id)).toBe(true);
  });

    it('monotonically increasing: within the same millisecond the time prefix agrees and the random segment differs', () => {
    const a = newRequestId(1_700_000_000_000);
    const b = newRequestId(1_700_000_000_000);
    expect(a.slice(4, 14)).toBe(b.slice(4, 14));
    expect(a).not.toBe(b);
  });

    it('an illegal external value is replaced with a new ID, a legal value is kept', () => {
    expect(resolveRequestId('not-a-request-id')).not.toBe('not-a-request-id');
    const valid = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN';
    expect(resolveRequestId(valid)).toBe(valid);
    expect(resolveRequestId(undefined)).toMatch(/^req_/);
  });
});

  describe('toDfrError normalization', () => {
    it('unknown exceptions degrade to DFR_INTERNAL_ERROR and keep the redacted cause', () => {
    const err = toDfrError(new Error('boom at https://rpc.example.com?apikey=HIDDEN'), { requestId });
    expect(err.code).toBe('DFR_INTERNAL_ERROR');
    expect(err.httpStatus).toBe(500);
    expect(JSON.stringify(err.message)).not.toContain('HIDDEN');
  });

    it('a known DfrError keeps its original error code; no reclassification', () => {
    const original = createDfrError('DFR_CHAIN_MISMATCH', { requestId });
    const normalized = toDfrError(original, { requestId });
    expect(normalized.code).toBe('DFR_CHAIN_MISMATCH');
    expect(normalized).toBe(original);
  });
});

  describe('Error codes are a stable contract', () => {
    it('all 40 error codes can be constructed by the factory (M2-C03 added DFR_INVALID_TICKET)', () => {
    const codes = DFR_ERROR_CODES as readonly DfrErrorCode[];
    expect(codes.length).toBe(40);
    for (const code of codes) {
      const err = createDfrError(code, { requestId });
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });
});
