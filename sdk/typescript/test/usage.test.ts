/**
 * SDK usage-method contract (`DFR.getUsage`, developer-product task 03).
 *
 * The SDK must expose the usage endpoint with the same envelope discipline as every other
 * method: request only `GET /v1/usage`, unpack the body as-is, and map failures to
 * `DfrApiError` so callers can branch on `code` / `retryable` / `safeToRetry`.
 */
import { describe, expect, it } from 'vitest';
import { DFR, isDfrApiError } from '../src/index.js';
import type { Iso8601, RequestId, UsageResponse } from '@dfr/types';

const BASE = 'https://gateway.example';
const KEY = 'dfr_UsageKey_secret0123456789abcdef';

const USAGE: UsageResponse = {
  projectId: 'proj-1',
  period: {
    start: '2026-11-19T00:00:00.000Z' as Iso8601,
    end: '2026-11-19T01:00:00.000Z' as Iso8601,
  },
  requests: {
    total: 3,
    byRouteClass: { read: 3 },
    byStatusClass: { success: 2, clientError: 1 },
    byRoute: { listChains: 3 },
    byChain: {},
    byCapability: { 'account.balance': 1 },
    byErrorCode: { DFR_VALIDATION_FAILED: 1 },
  },
  lastRequestAt: '2026-11-19T00:59:59.000Z' as Iso8601,
  limits: {
    rateLimits: {
      read: { capacity: 40, refillPerSecond: 20 },
      write: { capacity: 10, refillPerSecond: 2 },
      stream: { capacity: 5, refillPerSecond: 1 },
    },
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  },
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId,
};

describe('DFR.getUsage', () => {
  it('GETs /v1/usage with the key header and returns the envelope', async () => {
    const seen: { url: string; method: string; key?: string }[] = [];
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: async (input, init) => {
        const key = (init?.headers as Record<string, string>)['x-dfr-key'];
        seen.push({
          url: String(input),
          method: init?.method ?? 'GET',
          ...(key !== undefined ? { key } : {}),
        });
        return new Response(JSON.stringify(USAGE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const usage = await dfr.getUsage();
    expect(seen).toEqual([{ url: `${BASE}/v1/usage`, method: 'GET', key: KEY }]);
    expect(usage).toEqual(USAGE);
    expect(usage.limits.rateLimits.read.capacity).toBe(40);
  });

  it('maps a 401 to DfrApiError with the server code and requestId', async () => {
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: 'https://docs.dfr.example/errors/DFR_UNAUTHENTICATED',
            title: 'Unauthenticated',
            status: 401,
            detail: 'Invalid API Key',
            dfr_code: 'DFR_UNAUTHENTICATED',
            category: 'auth',
            retryable: false,
            safe_to_retry: false,
            request_id: 'req_server',
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(dfr.getUsage()).rejects.toSatisfy((error: unknown) => {
      if (!isDfrApiError(error)) return false;
      expect(error.code).toBe('DFR_UNAUTHENTICATED');
      expect(error.status).toBe(401);
      expect(error.requestId).toBe('req_server');
      expect(error.safeToRetry).toBe(false);
      return true;
    });
  });
});
