/**
 * Developer-product usage endpoint (`GET /v1/usage`, DFR developer-product task 03).
 *
 * Why this endpoint exists: the commercial acceptance bar says a developer must be able to
 * "view usage". Before this module there was **no** usage surface at all — only Prometheus
 * counters, which are an operator tool, not a developer tool and not attributable to a project
 * at the HTTP contract level.
 *
 * Scope honesty: this meter counts authenticated requests **in this process**. It is not a
 * billing ledger; durable cross-process aggregation and invoicing are explicitly out of scope
 * (documented in docs/api/capability-matrix.md).
 */
import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import {
  UsageMeter,
  createGatewayServer,
  hashSecret,
  TokenBucketLimiter,
} from '../src/index.js';

const KEY_ID = 'UsageKy1';
const SECRET = 'usageEndpointSecret0123456789ab';
const PEPPER = 'usage-pepper';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const PROJECT = 'usage-project';

interface Started {
  port: number;
  close(): Promise<void>;
}

async function start(overrides: { meter?: UsageMeter; limiter?: TokenBucketLimiter } = {}): Promise<Started> {
  const server: Server = createGatewayServer({
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
      projectId: PROJECT,
      scope: { chains: '*', capabilities: '*', allowWrite: false },
    },
    limiter:
      overrides.limiter ??
      new TokenBucketLimiter({
        read: { capacity: 100, refillPerSecond: 100 },
        write: { capacity: 100, refillPerSecond: 100 },
        stream: { capacity: 100, refillPerSecond: 100 },
      }),
    ...(overrides.meter !== undefined ? { usageMeter: overrides.meter } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

describe('GET /v1/usage', () => {
  it('requires authentication (no usage for anonymous callers)', async () => {
    const app = await start();
    try {
      const response = await fetch(url(app.port, '/v1/usage'));
      expect(response.status).toBe(401);
      expect((await response.json()) as { dfr_code: string }).toMatchObject({
        dfr_code: 'DFR_UNAUTHENTICATED',
      });
    } finally {
      await app.close();
    }
  });

  it('reports authenticated requests by route class, route, chain and error code', async () => {
    const app = await start();
    try {
      // 1 success
      expect((await fetch(url(app.port, '/v1/chains'), { headers: { 'x-dfr-key': KEY } })).status).toBe(200);
      // 2 validation failures (matched route, malformed blockRef)
      for (let i = 0; i < 2; i += 1) {
        const bad = await fetch(
          url(app.port, '/v1/blocks/not-a-ref?chain=ethereum-sepolia'),
          { headers: { 'x-dfr-key': KEY } },
        );
        expect(bad.status).toBe(400);
        expect((await bad.json()) as { dfr_code: string }).toMatchObject({
          dfr_code: 'DFR_VALIDATION_FAILED',
        });
      }

      const response = await fetch(url(app.port, '/v1/usage'), { headers: { 'x-dfr-key': KEY } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        projectId: string;
        period: { start: string; end: string };
        requests: {
          total: number;
          byRouteClass: Record<string, number>;
          byStatusClass: Record<string, number>;
          byRoute: Record<string, number>;
          byChain: Record<string, number>;
          byErrorCode: Record<string, number>;
        };
        limits: {
          rateLimits: Record<string, { capacity: number; refillPerSecond: number }>;
          scope: { chains: unknown; capabilities: unknown; allowWrite: boolean };
        };
        requestId: string;
      };

      expect(body.projectId).toBe(PROJECT);
      expect(body.requestId).toMatch(/^req_/);
      expect(Date.parse(body.period.start)).not.toBeNaN();
      expect(Date.parse(body.period.end)).not.toBeNaN();
      // The usage read itself is excluded, so a client can poll it without inflating the numbers.
      expect(body.requests.total).toBe(3);
      expect(body.requests.byRouteClass).toEqual({ read: 3 });
      expect(body.requests.byStatusClass).toEqual({ success: 1, clientError: 2 });
      expect(body.requests.byRoute).toEqual({ listChains: 1, getBlock: 2 });
      expect(body.requests.byChain).toEqual({ 'ethereum-sepolia': 2 });
      expect(body.requests.byErrorCode).toEqual({ DFR_VALIDATION_FAILED: 2 });
      expect(body.limits.rateLimits.read).toEqual({ capacity: 100, refillPerSecond: 100 });
      expect(body.limits.scope).toEqual({ chains: '*', capabilities: '*', allowWrite: false });
    } finally {
      await app.close();
    }
  });

  it('is empty (not an error) for a project that has not made a request yet', async () => {
    const meter = new UsageMeter();
    const snapshot = meter.snapshot('fresh-project');
    expect(snapshot.projectId).toBe('fresh-project');
    expect(snapshot.requests.total).toBe(0);
    expect(snapshot.requests.byRoute).toEqual({});
    expect(snapshot.lastRequestAt).toBeUndefined();
  });

  it('counts stream subscriptions in their own route class', async () => {
    const meter = new UsageMeter();
    meter.record({
      projectId: PROJECT,
      route: 'subscribeEvents',
      routeClass: 'stream',
      statusCode: 200,
      chain: 'ethereum-sepolia',
    });
    const snapshot = meter.snapshot(PROJECT);
    expect(snapshot.requests.total).toBe(1);
    expect(snapshot.requests.byRouteClass).toEqual({ stream: 1 });
    expect(snapshot.requests.byStatusClass).toEqual({ success: 1 });
  });

  it('isolates counters per project and never mixes keys', () => {
    const meter = new UsageMeter();
    meter.record({ projectId: 'a', route: 'listChains', routeClass: 'read', statusCode: 200 });
    meter.record({ projectId: 'b', route: 'listChains', routeClass: 'read', statusCode: 200 });
    meter.record({ projectId: 'b', route: 'listChains', routeClass: 'read', statusCode: 200 });
    expect(meter.snapshot('a').requests.total).toBe(1);
    expect(meter.snapshot('b').requests.total).toBe(2);
  });

  it('bounds chain cardinality so caller-supplied strings cannot grow the meter without limit', () => {
    const meter = new UsageMeter({ maxChainLabels: 2 });
    for (const chain of ['a', 'b', 'c', 'd', 'e']) {
      meter.record({ projectId: PROJECT, route: 'getBlock', routeClass: 'read', statusCode: 200, chain });
    }
    const snapshot = meter.snapshot(PROJECT);
    expect(Object.keys(snapshot.requests.byChain).sort()).toEqual(['a', 'b', 'other']);
    expect(snapshot.requests.byChain['other']).toBe(3);
    // The total is never distorted by label collapsing.
    expect(snapshot.requests.total).toBe(5);
  });
});
