/**
 * DfrClient first-run façade contract.
 *
 * Covers the three-line surface (chains/balances/logs/usage), unified errors, GET-only automatic
 * retries (exponential backoff) and cursor iteration. The HTTP request shapes are asserted so the
 * façade cannot drift from the OpenAPI contract.
 */
import { describe, expect, it } from 'vitest';
import { DfrClient, DfrApiError } from '../src/index.js';

const BASE = 'https://gateway.example';
const KEY = 'dfr_Client01_secret0123456789abcdefgh';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const providerError = (retryable = true, safe = true) =>
  json(503, {
    type: 'https://docs.dfr.example/errors/DFR_PROVIDER_UNAVAILABLE',
    title: 'Provider unavailable',
    status: 503,
    detail: 'temporarily unavailable',
    dfr_code: 'DFR_PROVIDER_UNAVAILABLE',
    category: 'provider',
    retryable,
    safe_to_retry: safe,
    request_id: 'req_server',
  });

describe('DfrClient first-run surface', () => {
  it('chains.list / balances.get / usage hit the documented endpoints', async () => {
    const calls: { method: string; path: string }[] = [];
    const client = new DfrClient({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 0 }, // keep this assertion about paths only
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search });
        if (url.pathname === '/v1/chains') return json(200, { items: [{ id: 'base-sepolia' }], requestId: 'req_1' });
        if (url.pathname === '/v1/balances') {
          return json(200, {
            balance: { account: '0xabc', asset: { kind: 'native', chain: 'base-sepolia' }, amount: '1', decimals: 18 },
            requestId: 'req_2',
            observedAt: '2026-11-19T00:00:00.000Z',
          });
        }
        if (url.pathname === '/v1/usage') return json(200, { projectId: 'p', requests: { total: 1 }, limits: {}, requestId: 'req_3' });
        return json(404, { dfr_code: 'DFR_NOT_FOUND', detail: 'no', request_id: 'req_x' });
      },
    });

    await expect(client.chains.list()).resolves.toHaveLength(1);
    await expect(client.balances.get({ chain: 'base-sepolia', account: '0xabc' })).resolves.toMatchObject({ amount: '1' });
    await expect(client.usage()).resolves.toMatchObject({ projectId: 'p' });
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/chains',
      '/v1/balances?chain=base-sepolia&account=0xabc',
      '/v1/usage',
    ]);
  });

  it('automatically retries idempotent GETs with backoff, then succeeds', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new DfrClient({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 2, baseDelayMs: 1, jitter: false, sleep: async (ms) => { sleeps.push(ms); } },
      fetchImpl: async () => {
        calls += 1;
        return calls < 3 ? providerError() : json(200, { items: [], requestId: 'req_ok' });
      },
    });
    await expect(client.chains.list()).resolves.toEqual([]);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1, 2]);
  });

  it('does not auto-retry the read-only POST /v1/logs query', async () => {
    let calls = 0;
    const client = new DfrClient({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 3, baseDelayMs: 1, jitter: false, sleep: async () => undefined },
      fetchImpl: async () => {
        calls += 1;
        return providerError();
      },
    });
    await expect(client.logs.query({ chain: 'base-sepolia', fromBlock: '0', toBlock: '1' })).rejects.toBeInstanceOf(DfrApiError);
    expect(calls).toBe(1);
  });

  it('logs.iterate follows nextCursor and sends only {cursor, limit} on resume', async () => {
    const bodies: Record<string, unknown>[] = [];
    let page = 0;
    const client = new DfrClient({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 0 },
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        page += 1;
        return json(200, {
          logs: [{ index: String(page) }],
          hasMore: page < 2,
          ...(page < 2 ? { nextCursor: 'cursor-' + page } : {}),
          requestId: 'req_' + page,
        });
      },
    });

    const seen: string[] = [];
    for await (const log of client.logs.iterate({ chain: 'base-sepolia', fromBlock: '0', toBlock: '10', limit: 1 })) {
      seen.push(log.index as string);
    }
    expect(seen).toEqual(['1', '2']);
    expect(bodies[0]).toEqual({ fromBlock: '0', toBlock: '10', limit: 1 });
    expect(bodies[1]).toEqual({ cursor: 'cursor-1', limit: 1 });
  });

  it('surfaces the unified error fields from the server', async () => {
    const client = new DfrClient({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 3 },
      fetchImpl: async () =>
        json(400, {
          type: 'https://docs.dfr.example/errors/DFR_VALIDATION_FAILED',
          title: 'Validation failed',
          status: 400,
          detail: 'bad range',
          dfr_code: 'DFR_VALIDATION_FAILED',
          category: 'client',
          retryable: false,
          safe_to_retry: false,
          request_id: 'req_bad',
        }),
    });
    await expect(client.logs.query({ chain: 'base-sepolia', fromBlock: '0', toBlock: '1' })).rejects.toMatchObject({
      code: 'DFR_VALIDATION_FAILED',
      requestId: 'req_bad',
      status: 400,
      attempts: 1,
    });
  });
});
