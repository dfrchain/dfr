/**
 * SDK block-range pagination (`getLogsPaged`, developer-product task 03, item 7).
 *
 * Honesty note: the HTTP API has **no opaque-cursor pagination** for logs. The Gateway forbids
 * ranges wider than the chain's `maxBlockRange` and `limit` truncates silently, so the SDK exposes
 * a ranged iterator that keeps every request inside one window and concatenates the disjoint
 * results. Server-side cursors remain listed as a gap in docs/api/capability-matrix.md.
 */
import { describe, expect, it } from 'vitest';
import { DFR } from '../src/index.js';

const BASE = 'https://gateway.example';
const KEY = 'dfr_LogsKey_secret0123456789abcdef';

interface Captured {
  url: string;
  body: { fromBlock: string; toBlock: string; limit?: number };
}

function capturing(logsPerCall: readonly (readonly unknown[])[]): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({
      url,
      body: JSON.parse(String(init?.body)) as Captured['body'],
    });
    const logs = logsPerCall[calls.length - 1] ?? [];
    return new Response(JSON.stringify({ logs, requestId: 'req_ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

describe('DFR.getLogsPaged', () => {
  it('splits a wide range into maxBlockRange-sized windows and concatenates results', async () => {
    const { fetchImpl, calls } = capturing([
      [{ blockNumber: '0' }],
      [{ blockNumber: '2000' }],
      [{ blockNumber: '4000' }],
    ]);
    const dfr = new DFR({ apiKey: KEY, baseUrl: BASE, fetchImpl });

    const result = await dfr.getLogsPaged({
      chain: 'base-sepolia',
      fromBlock: '0',
      toBlock: '4500',
      windowBlocks: 2000,
    });

    expect(result.pages).toBe(3);
    expect(result.logs).toHaveLength(3);
    expect(calls.map((c) => [c.body.fromBlock, c.body.toBlock])).toEqual([
      ['0', '1999'],
      ['2000', '3999'],
      ['4000', '4500'],
    ]);
    // Chain travels in the query string, exactly like getLogs.
    expect(calls[0]?.url).toContain('/v1/logs?chain=base-sepolia');
    // No limit: the helper must not silently truncate a window.
    expect(calls.every((c) => c.body.limit === undefined)).toBe(true);
  });

  it('uses a single request when the range fits in one window', async () => {
    const { fetchImpl, calls } = capturing([[{ blockNumber: '100' }]]);
    const dfr = new DFR({ apiKey: KEY, baseUrl: BASE, fetchImpl });
    const result = await dfr.getLogsPaged({
      chain: 'base-sepolia',
      fromBlock: '100',
      toBlock: '200',
    });
    expect(result.pages).toBe(1);
    expect(result.logs).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ fromBlock: '100', toBlock: '200' });
  });

  it('rejects invalid ranges locally instead of burning an HTTP round trip', async () => {
    const { fetchImpl, calls } = capturing([]);
    const dfr = new DFR({ apiKey: KEY, baseUrl: BASE, fetchImpl });
    await expect(
      dfr.getLogsPaged({ chain: 'base-sepolia', fromBlock: '10', toBlock: '5' }),
    ).rejects.toThrow(TypeError);
    await expect(
      dfr.getLogsPaged({ chain: 'base-sepolia', fromBlock: '0x10', toBlock: '20' }),
    ).rejects.toThrow(TypeError);
    await expect(
      dfr.getLogsPaged({ chain: 'base-sepolia', fromBlock: '0', toBlock: '20', windowBlocks: 0 }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});
