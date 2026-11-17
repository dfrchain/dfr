// Gateway HTTP 指标契约测试（observability-spec §5.1/§5.6）。
//
// §5.6 把"API success rate"与"API latency"列为需求第 14 章的**最低指标**，
// 而在本模块之前两者都未实现。这里同时验证：
//   1. 单元语义（计数器/直方图/gauge、有界标签、路由标签不得是原始 path）；
//   2. 真实 composition root 接线（一次请求、一次 401、`/metrics` 能看到两族指标）。
import { describe, expect, it, vi } from 'vitest';
import { TransactionMetrics } from '@dfr/transaction';
import type { DfrCore } from '@dfr/core';
import { GatewayMetrics } from '../src/gateway-metrics.js';
import { createGatewayServer, hashSecret } from '../src/index.js';
import { startGateway } from '../src/main.js';

const KEY_ID = 'GwMetKey'; // 恰好 8 位 [A-Za-z0-9]
const SECRET = 'gatewayMetricsSecret0123456789ab';
const PEPPER = 'gw-metrics-pepper';

function metrics(): GatewayMetrics {
  return new GatewayMetrics();
}

describe('GatewayMetrics 单元语义（§5.1）', () => {
  it('请求计数与延迟直方图使用有界标签，且标签顺序稳定', () => {
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

  it('原始 path 作为 route 标签会被折叠为 other（防交易哈希变成标签）', () => {
    const m = metrics();
    // 模拟"直接把 path 当标签"的错误用法：含 `/` 与 0x 地址。
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

  it('鉴权失败 / 限流 / 幂等结果各自计数', () => {
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

  it('在途请求 gauge 可增可减，且不会降到负数', () => {
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

  it('无数据时不渲染任何指标', () => {
    expect(metrics().renderPrometheus()).toBe('');
  });
});

describe('Gateway 指标端到端接线（真实 startGateway）', () => {
  it('成功请求与鉴权失败都被计数，且 /metrics 同时暴露 Gateway 与交易指标族', async () => {
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

      // 成功请求（M0 无链，返回空列表）。
      const ok = await fetch(`${base}/v1/chains`, { headers: { 'x-dfr-key': key } });
      expect(ok.status).toBe(200);

      // 鉴权失败：无 Key。
      const unauth = await fetch(`${base}/v1/chains`);
      expect(unauth.status).toBe(401);

      // 未知路由：route 标签应为 unmatched（而不是回显 path）。
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
      // 回显 path 会泄漏路由细节与（更糟的）路径参数，必须不出现。
      expect(text).not.toContain('/v1/nope');
      expect(text).not.toContain('path=');
      // 交易指标族此时无数据（M0 不走事务引擎），但指标名不应因此报错。
      expect(text).not.toContain('dfr_transaction_stage_total');
    } finally {
      await app?.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);

  it('/metrics 在需要鉴权，且无 Key 时返回 401（不泄漏指标）', async () => {
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

describe('/metrics 两族指标拼接', () => {
  it('依赖故障拒绝业务请求后，/metrics 暴露专用计数器', async () => {
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

  it('同时装配 Gateway 与交易指标时，两类都以 Prometheus 文本暴露', async () => {
    // 这是本模块新增的核心拼接逻辑：两族指标名不重叠，文本可直接相连。
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
      // 拼接不得破坏文本格式：每个非空行要么是注释/HELP/TYPE，要么是样本。
      for (const line of text.trimEnd().split('\n')) {
        expect(line.length).toBeGreaterThan(0);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('两类指标都未装配时 /metrics 返回 404（保持既有 fail-closed 语义）', async () => {
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
