/**
 * SDK cursor pagination (`getLogsPage`, developer-product follow-up).
 *
 * `getLogs` stays array-only for backwards compatibility. `getLogsPage` exposes the server's
 * `hasMore` / `nextCursor` so consumers can continue without re-sending the range or filters.
 */
import { describe, expect, it } from 'vitest';
import { DFR } from '../src/index.js';

const BASE = 'https://gateway.example';
const KEY = 'dfr_LogsCursorKey_secret0123456789ab';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function capturing(responses: readonly unknown[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const body = responses[calls.length - 1] ?? { logs: [], hasMore: false, requestId: 'req_ok' };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

describe('DFR.getLogsPage', () => {
  it('sends the first-page body and returns the continuation cursor', async () => {
    const { fetchImpl, calls } = capturing([
      {
        logs: [{ index: '1', blockRef: { kind: 'number', number: '100' } }],
        hasMore: true,
        nextCursor: 'cursor-1',
        requestId: 'req_page1',
      },
    ]);
    const dfr = new DFR({ apiKey: KEY, baseUrl: BASE, fetchImpl });

    const page = await dfr.getLogsPage({
      chain: 'base-sepolia',
      fromBlock: '100',
      toBlock: '200',
      address: '0x1111111111111111111111111111111111111111',
      limit: 1,
    });

    expect(calls[0]?.url).toBe(`${BASE}/v1/logs?chain=base-sepolia`);
    expect(calls[0]?.body).toEqual({
      fromBlock: '100',
      toBlock: '200',
      address: '0x1111111111111111111111111111111111111111',
      limit: 1,
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('cursor-1');
    expect(page.logs).toHaveLength(1);
  });

  it('resumes with only the cursor and page size', async () => {
    const { fetchImpl, calls } = capturing([
      { logs: [], hasMore: true, nextCursor: 'cursor-1', requestId: 'req_page1' },
      { logs: [], hasMore: false, requestId: 'req_page2' },
    ]);
    const dfr = new DFR({ apiKey: KEY, baseUrl: BASE, fetchImpl });

    await dfr.getLogsPage({ chain: 'base-sepolia', fromBlock: '100', toBlock: '200', limit: 1 });
    const second = await dfr.getLogsPage({ chain: 'base-sepolia', cursor: 'cursor-1', limit: 1 });

    expect(calls[1]?.body).toEqual({ cursor: 'cursor-1', limit: 1 });
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it('rejects ambiguous or incomplete parameters locally, without a round trip', async () => {
    const { fetchImpl, calls } = capturing([]);
    const dfr = new DFR({ apiKey: KEY, baseUrl: BASE, fetchImpl });

    await expect(
      dfr.getLogsPage({ chain: 'base-sepolia', cursor: 'c', fromBlock: '1', toBlock: '2' }),
    ).rejects.toThrow(TypeError);
    await expect(dfr.getLogsPage({ chain: 'base-sepolia', fromBlock: '1' })).rejects.toThrow(TypeError);
    await expect(
      dfr.getLogsPage({ chain: 'base-sepolia', fromBlock: '0x1', toBlock: '2' }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('maps an invalid-cursor 400 to DfrApiError', async () => {
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: 'https://docs.dfr.example/errors/DFR_VALIDATION_FAILED',
            title: 'Validation failed',
            status: 400,
            detail: 'Invalid logs cursor',
            dfr_code: 'DFR_VALIDATION_FAILED',
            category: 'client',
            retryable: false,
            safe_to_retry: false,
            request_id: 'req_bad_cursor',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    });
    await expect(dfr.getLogsPage({ chain: 'base-sepolia', cursor: 'tampered' })).rejects.toMatchObject({
      code: 'DFR_VALIDATION_FAILED',
      status: 400,
      requestId: 'req_bad_cursor',
    });
  });
});
