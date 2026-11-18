/**
 * `Retry-After` on 429 (developer-product task 03, item 7).
 *
 * Why: before this, a rate-limited developer got `429` + `X-RateLimit-*` but no standard
 * `Retry-After`, so generic HTTP retry middleware could not back off correctly. The SDK retry
 * policy consumes exactly this header.
 */
import { describe, expect, it } from 'vitest';
import type { DfrCore } from '@dfr/core';
import {
  TokenBucketLimiter,
  createGatewayServer,
  hashSecret,
} from '../src/index.js';

const KEY_ID = 'RlHdr001';
const SECRET = 'retryAfterSecret0123456789abcdef';
const PEPPER = 'retry-after-pepper';
const KEY = `dfr_${KEY_ID}_${SECRET}`;

describe('429 Retry-After', () => {
  it('sets Retry-After (seconds, rounded up) and keeps the structured retryAfterMs detail', async () => {
    const server = createGatewayServer({
      core: {
        listChains: () => [],
        readiness: () => ({ ready: true, chains: [] }),
        startHealthChecks: () => ({ started: [], skipped: [] }),
        stopHealthChecks: () => undefined,
      } as unknown as DfrCore,
      auth: {
        keyId: KEY_ID,
        currentHash: hashSecret(SECRET, PEPPER),
        pepper: PEPPER,
        projectId: 'retry-after',
        scope: { chains: '*', capabilities: '*', allowWrite: false },
      },
      // One token, refilled at 0.5/s: the second immediate call must wait ~2s.
      limiter: new TokenBucketLimiter({
        read: { capacity: 1, refillPerSecond: 0.5 },
        write: { capacity: 1, refillPerSecond: 0.5 },
        stream: { capacity: 1, refillPerSecond: 0.5 },
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const first = await fetch(`http://127.0.0.1:${port}/v1/chains`, { headers: { 'x-dfr-key': KEY } });
      expect(first.status).toBe(200);

      const second = await fetch(`http://127.0.0.1:${port}/v1/chains`, { headers: { 'x-dfr-key': KEY } });
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBe('2');
      expect(second.headers.get('x-ratelimit-remaining')).toBe('0');
      const body = (await second.json()) as {
        dfr_code: string;
        retryable: boolean;
        details?: { retryAfterMs?: number };
      };
      expect(body.dfr_code).toBe('DFR_RATE_LIMITED');
      expect(body.retryable).toBe(true);
      // Timing between the two requests means the bucket has already refilled slightly.
      expect(body.details?.retryAfterMs).toBeGreaterThanOrEqual(1900);
      expect(body.details?.retryAfterMs).toBeLessThanOrEqual(2000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
