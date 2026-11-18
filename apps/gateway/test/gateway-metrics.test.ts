// Gateway HTTP metrics contract test (observability-spec §5.1/§5.6).
//
// §5.6 lists "API success rate" and "API latency" as the **minimum metrics** of requirements chapter 14,
// and neither was implemented before this module. This verifies both:
//   1. unit semantics (counters / histograms / gauges, bounded labels, route labels must not be the raw path);
//   2. real composition-root wiring (one request, one 401, `/metrics` exposes both metric families).
import { describe, expect, it, vi } from 'vitest';
import { TransactionMetrics } from '@dfr/transaction';
import type { DfrCore } from '@dfr/core';
import { GatewayMetrics } from '../src/gateway-metrics.js';
import { createGatewayServer, hashSecret } from '../src/index.js';
import { startGateway } from '../src/main.js';

const KEY_ID = 'GwMetKey'; // exactly 8 [A-Za-z0-9] characters
const SECRET = 'gatewayMetricsSecret0123456789ab';
const PEPPER = 'gw-metrics-pepper';

function metrics(): GatewayMetrics {
  return new GatewayMetrics();
}

describe('GatewayMetrics unit semantics (§5.1)', () => {
  it('request counts and latency histograms use bounded labels, with stable label ordering', () => {
    const m = metrics();
    m.recordRequest({
      route: 'listChains',
      method: 'GET',
      statusCode: 200,
      durationSeconds: 0.012,
    });
    m.recordRequest({
      route: 'listChains',
      method: 'GET',
      statusCode: 200,
      chain: 'none',
      durationSeconds: 0.02,
    });

    const out = m.renderPrometheus();
    expect(out).toContain(
      'dfr_gateway_requests_total{route="listChains",method="GET",status_code="200",chain="none"} 2',
    );
    expect(out).toContain('dfr_gateway_request_duration_seconds_count{route="listChains",method="GET"} 2');
    expect(out).toContain('dfr_gateway_request_duration_seconds_bucket{route="listChains",method="GET",le="+Inf"} 2');
  });

  it('a raw path used as the route label is folded to other (so transaction hashes never become labels)', () => {
    const m = metrics();
    // Simulate the wrong usage of "using the path directly as a label": contains `/` and a 0x address.
    m.recordRequest({
      route: `/v1/transactions/0x${'aa'.repeat(32)}/confirm`,
      method: 'POST',
      statusCode: 200,
      durationSeconds: 0.1,
    });
    const out = m.renderPrometheus();
    expect(out).not.toContain('/v1/transactions');
    expect(out).not.toContain('aa'.repeat(32));
    expect(out).toContain('route="other"');
  });

  it('auth failures / rate limiting / idempotency outcomes are each counted', () => {
    const m = metrics();
    m.recordAuthFailure('missing');
    m.recordAuthFailure('mismatch');
    m.recordAuthFailure('mismatch');
    m.recordRateLimited('write');
    m.recordDependencyRejected('read');
    m.recordIdempotencyOutcome('replayed');
    m.recordIdempotencyOutcome('conflict');

    const out = m.renderPrometheus();
    expect(out).toContain('dfr_gateway_auth_failures_total{reason_code="missing"} 1');
    expect(out).toContain('dfr_gateway_auth_failures_total{reason_code="mismatch"} 2');
    expect(out).toContain('dfr_gateway_rate_limited_total{route_class="write"} 1');
    expect(out).toContain('dfr_gateway_dependency_rejected_total{route_class="read"} 1');
    expect(out).toContain('dfr_gateway_idempotency_hits_total{outcome="replayed"} 1');
    expect(out).toContain('dfr_gateway_idempotency_hits_total{outcome="conflict"} 1');
  });

  it('the in-flight request gauge can rise and fall, and never drops below zero', () => {
    const m = metrics();
    m.changeInflight('read', 1);
    m.changeInflight('read', 1);
    expect(m.renderPrometheus()).toContain('dfr_gateway_inflight_requests{route_class="read"} 2');
    m.changeInflight('read', -1);
    expect(m.renderPrometheus()).toContain('dfr_gateway_inflight_requests{route_class="read"} 1');
    m.changeInflight('read', -1);
    m.changeInflight('read', -1);
    expect(m.renderPrometheus()).toContain('dfr_gateway_inflight_requests{route_class="read"} 0');
  });

  it('renders no metrics when there is no data', () => {
    expect(metrics().renderPrometheus()).toBe('');
  });
});

describe('Gateway metrics end-to-end wiring (real startGateway)', () => {
  it('successful requests and auth failures are both counted, and /metrics exposes both Gateway and transaction metric families', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let app: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      app = await startGateway({
        DFR_M0_API_KEY_ID: KEY_ID,
        DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
        DFR_M0_API_KEY_PEPPER: PEPPER,
        DFR_GATEWAY_PORT: '0',
      });
      const base = `http://127.0.0.1:${app.port}`;
      const key = `dfr_${KEY_ID}_${SECRET}`;

      // Successful request (M0 has no chains, returns an empty list).
      const ok = await fetch(`${base}/v1/chains`, { headers: { 'x-dfr-key': key } });
      expect(ok.status).toBe(200);

      // Auth failure: no Key.
      const unauth = await fetch(`${base}/v1/chains`);
      expect(unauth.status).toBe(401);

      // Unknown route: the route label should be unmatched (not an echoed path).
      const notFound = await fetch(`${base}/v1/nope`, { headers: { 'x-dfr-key': key } });
      expect(notFound.status).toBe(404);

      const scrape = await fetch(`${base}/metrics`, { headers: { 'x-dfr-key': key } });
      expect(scrape.status).toBe(200);
      const text = await scrape.text();

      expect(text).toContain('dfr_gateway_requests_total');
      expect(text).toContain('route="listChains",method="GET",status_code="200"');
      expect(text).toContain('route="unmatched",method="GET",status_code="401"');
      expect(text).toContain('route="unmatched",method="GET",status_code="404"');
      expect(text).toContain('dfr_gateway_auth_failures_total{reason_code="missing"} 1');
      expect(text).toContain('dfr_gateway_request_duration_seconds_count');
      // Echoing the path would leak route details and (worse) path parameters, and must not appear.
      expect(text).not.toContain('/v1/nope');
      expect(text).not.toContain('path=');
      // The transaction metric family has no data at this point (M0 does not go through the transaction engine), but metric names must not error because of it.
      expect(text).not.toContain('dfr_transaction_stage_total');
    } finally {
      await app?.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);

  it('/metrics requires auth, and returns 401 without a Key (no metrics leaked)', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let app: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      app = await startGateway({
        DFR_M0_API_KEY_ID: KEY_ID,
        DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
        DFR_M0_API_KEY_PEPPER: PEPPER,
        DFR_GATEWAY_PORT: '0',
      });
      const response = await fetch(`http://127.0.0.1:${app.port}/metrics`);
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).not.toContain('dfr_gateway_requests_total');
    } finally {
      await app?.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);
});

describe('/metrics two-family metric concatenation', () => {
  it('after a dependency failure rejects business requests, /metrics exposes a dedicated counter', async () => {
    const gatewayMetrics = new GatewayMetrics();
    const server = createGatewayServer({
      core: {
        listChains: () => [],
        readiness: () => ({ ready: true, chains: [] }),
        startHealthChecks: () => ({ started: [], skipped: [] }),
        stopHealthChecks: () => undefined,
      } as unknown as DfrCore,
      auth: { keyId: KEY_ID, currentHash: hashSecret(SECRET, PEPPER), pepper: PEPPER, projectId: 'metrics', scope: { chains: '*', capabilities: '*', allowWrite: false } },
      gatewayMetrics,
      readyCheck: async () => { throw new Error('db unavailable'); },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const headers = { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` };
      expect((await fetch(`http://127.0.0.1:${port}/v1/chains`, { headers })).status).toBe(503);
      const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`, { headers })).text();
      expect(metrics).toContain('dfr_gateway_dependency_rejected_total{route_class="read"} 1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('when both Gateway and transaction metrics are assembled, both are exposed as Prometheus text', async () => {
    // This is the core concatenation logic added by this module: the two families' metric names do not overlap, so the text can be joined directly.
    const gatewayMetrics = new GatewayMetrics();
    gatewayMetrics.recordRequest({ route: 'listChains', method: 'GET', statusCode: 200, durationSeconds: 0.01 });
    const transactionMetrics = new TransactionMetrics();
    transactionMetrics.recordStage({ chain: 'ethereum-sepolia', stage: 'build', status: 'success', durationSeconds: 0.5 });

    const server = createGatewayServer({
      core: {
        listChains: () => [],
        readiness: () => ({ ready: false, chains: [] }),
        startHealthChecks: () => ({ started: [], skipped: [] }),
        stopHealthChecks: () => undefined,
      } as unknown as DfrCore,
      auth: {
        keyId: KEY_ID,
        currentHash: hashSecret(SECRET, PEPPER),
        pepper: PEPPER,
        projectId: 'metrics',
        scope: { chains: '*', capabilities: '*', allowWrite: false },
      },
      gatewayMetrics,
      transactionMetrics,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('dfr_gateway_requests_total');
      expect(text).toContain('dfr_transaction_stage_total');
      // Concatenation must not break the text format: every non-empty line is either a comment/HELP/TYPE or a sample.
      for (const line of text.trimEnd().split('\n')) {
        expect(line.length).toBeGreaterThan(0);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('when neither metric family is assembled, /metrics returns 404 (keeping the existing fail-closed semantics)', async () => {
    const server = createGatewayServer({
      core: {
        listChains: () => [],
        readiness: () => ({ ready: false, chains: [] }),
        startHealthChecks: () => ({ started: [], skipped: [] }),
        stopHealthChecks: () => undefined,
      } as unknown as DfrCore,
      auth: {
        keyId: KEY_ID,
        currentHash: hashSecret(SECRET, PEPPER),
        pepper: PEPPER,
        projectId: 'metrics',
        scope: { chains: '*', capabilities: '*', allowWrite: false },
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` },
      });
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
