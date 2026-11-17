// Core / Adapter / Provider 三层指标契约测试（observability-spec §5.2/§5.3/§5.4）。
//
// 重点不是"能不能渲染"，而是三条容易做错的纪律：
//   1. 标签全部有界（chain / provider_id / method_class / error_code …）；
//   2. **不伪造未实现的指标**（provider 成本、未配置的配额）；
//   3. 读写分类正确（只有 broadcast 是写）。
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../src/index.js';
import { startGateway } from '../src/main.js';
import type { AdapterCallRecord, CoreOperationRecord, ProviderCallRecord, ProviderObservabilitySnapshot } from '@dfr/core';
import { AdapterMetrics, CoreMetrics, ProviderMetrics } from '../src/layer-metrics.js';

const CORE_RECORD: CoreOperationRecord = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  operation: 'getBlock',
  chain: 'ethereum-sepolia' as never,
  status: 'success',
  latencyMs: 120,
};

const ADAPTER_RECORD: AdapterCallRecord = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  adapter: 'evm',
  adapterVersion: '0.1.0',
  chain: 'ethereum-sepolia' as never,
  method: 'getBlock',
  methodClass: 'read',
  status: 'success',
  latencyMs: 100,
};

const PROVIDER_RECORD: ProviderCallRecord = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  chain: 'ethereum-sepolia' as never,
  network: 'testnet',
  providerId: 'ethereum-sepolia-primary',
  providerKind: 'json-rpc-http',
  method: 'eth_getBalance',
  methodClass: 'read',
  latencyMs: 42,
  status: 'success',
  retryCount: 0,
  circuitState: 'closed',
  scoreAtCall: 87,
  failover: false,
};

describe('CoreMetrics（§5.2）', () => {
  it('操作计数 / 耗时 / 错误分类', () => {
    const m = new CoreMetrics();
    m.recordOperation(CORE_RECORD);
    m.recordOperation({
      ...CORE_RECORD,
      status: 'error',
      errorCode: 'DFR_CHAIN_UNAVAILABLE',
      category: 'availability',
      latencyMs: 300,
    });
    const out = m.renderPrometheus();
    expect(out).toContain(
      'dfr_core_operations_total{operation="getBlock",chain="ethereum-sepolia",status="success",error_code="none"} 1',
    );
    expect(out).toContain(
      'dfr_core_operations_total{operation="getBlock",chain="ethereum-sepolia",status="error",error_code="DFR_CHAIN_UNAVAILABLE"} 1',
    );
    expect(out).toContain('dfr_core_operation_duration_seconds_sum{operation="getBlock",chain="ethereum-sepolia"} 0.42');
    expect(out).toContain(
      'dfr_core_errors_total{error_code="DFR_CHAIN_UNAVAILABLE",category="availability"} 1',
    );
    // 成功不产生 error 计数。
    expect(out).not.toContain('error_code="none",category');
  });

  it('capability 不支持单独计数（正常为 0）', () => {
    const m = new CoreMetrics();
    m.recordCapabilityUnsupported({ chain: 'base-sepolia', capability: 'transaction.broadcast' });
    expect(m.renderPrometheus()).toContain(
      'dfr_core_capability_unsupported_total{chain="base-sepolia",capability="transaction.broadcast"} 1',
    );
  });
});

describe('AdapterMetrics（§5.3）', () => {
  it('调用计数带 adapter / version / method_class，错误单独计数', () => {
    const m = new AdapterMetrics();
    m.recordCall(ADAPTER_RECORD);
    m.recordCall({
      ...ADAPTER_RECORD,
      method: 'broadcast',
      methodClass: 'write',
      status: 'error',
      errorCode: 'DFR_TRANSACTION_REJECTED',
    });
    const out = m.renderPrometheus();
    expect(out).toContain(
      'dfr_adapter_calls_total{adapter="evm",adapter_version="0.1.0",chain="ethereum-sepolia",method_class="read",status="success"} 1',
    );
    expect(out).toContain(
      'dfr_adapter_calls_total{adapter="evm",adapter_version="0.1.0",chain="ethereum-sepolia",method_class="write",status="error"} 1',
    );
    expect(out).toContain('dfr_adapter_call_duration_seconds_count{adapter="evm",chain="ethereum-sepolia",method_class="read"} 1');
    expect(out).toContain(
      'dfr_adapter_errors_total{adapter="evm",chain="ethereum-sepolia",error_code="DFR_TRANSACTION_REJECTED"} 1',
    );
  });

  it('registry 不一致计数器（spec §8：应为 0）', () => {
    const m = new AdapterMetrics();
    m.recordRegistryMismatch('ethereum-sepolia');
    expect(m.renderPrometheus()).toContain(
      'dfr_adapter_registry_mismatch_total{chain="ethereum-sepolia"} 1',
    );
  });
});

describe('ProviderMetrics（§5.4）', () => {
  it('请求计数 / 耗时 / 重试按方法类别计数', () => {
    const m = new ProviderMetrics();
    m.recordCall(PROVIDER_RECORD);
    m.recordCall({ ...PROVIDER_RECORD, status: 'error', errorCode: 'DFR_PROVIDER_TIMEOUT', retryCount: 2 });
    const out = m.renderPrometheus();
    expect(out).toContain(
      'dfr_provider_requests_total{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",method_class="read",status="success",error_code="none"} 1',
    );
    expect(out).toContain('dfr_provider_request_duration_seconds_count{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia"} 2');
    // retry_count = 2 → 重试计数加 2（不是加 1）。
    expect(out).toContain(
      'dfr_provider_retries_total{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",reason="read"} 2',
    );
  });

  it('gauge：可用率 / 错误率 / 评分 / 熔断状态（0/1 三序列）', () => {
    const m = new ProviderMetrics();
    const snapshot: ProviderObservabilitySnapshot = {
      providerId: 'ethereum-sepolia-primary',
      network: 'testnet',
      health: {
        status: 'healthy',
        lastCheckedAt: '2026-10-05T00:00:00.000Z' as never,
        consecutiveFailures: 0,
        errorRate: 0.25,
        latencyP50Ms: 40,
        latencyP95Ms: 120,
      },
      circuitState: 'open',
      score: 73,
    };
    m.refreshGauges({ 'ethereum-sepolia': [snapshot] });
    const out = m.renderPrometheus();
    expect(out).toContain('dfr_provider_availability_ratio{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia"} 0.75');
    expect(out).toContain('dfr_provider_error_ratio{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia"} 0.25');
    expect(out).toContain('dfr_provider_score{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia"} 73');
    // 熔断状态用 state 标签的三条 0/1 序列，便于 SUM/告警。
    expect(out).toContain('dfr_provider_circuit_state{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",state="open"} 1');
    expect(out).toContain('dfr_provider_circuit_state{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",state="closed"} 0');
    expect(out).toContain('dfr_provider_circuit_state{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",state="half-open"} 0');
  });

  it('健康窗口无样本时可用率为 1（新注册 Provider 不得被判成"完全不可用"）', () => {
    const m = new ProviderMetrics();
    m.refreshGauges({
      'ethereum-sepolia': [
        {
          providerId: 'fresh',
          network: 'testnet',
          health: {
            status: 'unknown',
            lastCheckedAt: '2026-10-05T00:00:00.000Z' as never,
            consecutiveFailures: 0,
          },
          circuitState: 'closed',
          score: 50,
        },
      ],
    });
    expect(m.renderPrometheus()).toContain('dfr_provider_availability_ratio{provider_id="fresh",chain="ethereum-sepolia"} 1');
  });

  it('未配置 quota 时不暴露 quota_used_ratio（不伪造 0 或 1）', () => {
    const m = new ProviderMetrics();
    m.refreshGauges({
      'ethereum-sepolia': [
        {
          providerId: 'no-quota',
          network: 'testnet',
          health: { status: 'healthy', lastCheckedAt: '2026-10-05T00:00:00.000Z' as never, consecutiveFailures: 0 },
          circuitState: 'closed',
          score: 90,
        },
      ],
    });
    expect(m.renderPrometheus()).not.toContain('dfr_provider_quota_used_ratio');

    m.refreshGauges({
      'ethereum-sepolia': [
        {
          providerId: 'no-quota',
          network: 'testnet',
          health: { status: 'healthy', lastCheckedAt: '2026-10-05T00:00:00.000Z' as never, consecutiveFailures: 0 },
          circuitState: 'closed',
          score: 90,
          quotaUsedRatio: 0.4,
        },
      ],
    });
    expect(m.renderPrometheus()).toContain('dfr_provider_quota_used_ratio{provider_id="no-quota",chain="ethereum-sepolia"} 0.4');
  });

  it('不暴露未实现的 provider 成本指标（伪造恒为 0 比不暴露更危险）', () => {
    const m = new ProviderMetrics();
    m.recordCall(PROVIDER_RECORD);
    // spec §5.4 列了 `dfr_provider_cost_usd_total`，但 M1 没有成本核算子系统；
    // descriptor 里的 priceUsd 是单价、不是累计费用。宁可不暴露。
    expect(m.renderPrometheus()).not.toContain('cost_usd');
  });
});

describe('三层指标标签纪律', () => {
  it('高基数形态的值（地址 / 哈希 / URL）不会原样进入标签', () => {
    const m = new AdapterMetrics();
    // 模拟"把地址当 chain 传"的最坏情况。
    m.recordCall({
      ...ADAPTER_RECORD,
      chain: `0x${'ab'.repeat(32)}` as never,
    });
    const out = m.renderPrometheus();
    expect(out).not.toContain('ab'.repeat(32));
    expect(out).toContain('chain="other"');
  });
});

describe('三层指标的端到端接线（真实 startGateway + 真实 RPC）', () => {
  it('一次链上读同时产生 Core / Adapter / Provider 三族指标', async () => {
    // 本地最小 JSON-RPC：让请求真的穿过 Core → Adapter → Provider。
    const rpc = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
        const value =
          parsed.method === 'eth_chainId'
            ? '0x14a34'
            : parsed.method === 'eth_getBlockByNumber'
              ? {
                  number: '0x1',
                  hash: `0x${'11'.repeat(32)}`,
                  parentHash: `0x${'22'.repeat(32)}`,
                  timestamp: '0x67f00000',
                  transactions: [],
                }
              : '0x0';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result: value }));
      });
    });
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    const rpcPort = (rpc.address() as { port: number }).port;

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let app: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      app = await startGateway({
        DFR_M0_API_KEY_ID: 'LayerKy1',
        DFR_M0_API_KEY_HASH: hashSecret('layerMetricsSecret0123456789abc', 'p'),
        DFR_M0_API_KEY_PEPPER: 'p',
        DFR_GATEWAY_PORT: '0',
        DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
        DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
        DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
        DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
        DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
      }, async () => ({
        stores: {
          transaction: { listRecoverable: async () => [] } as never,
          idempotency: { pruneExpired: async () => 0 } as never,
          nonce: { releaseExpiredOrphaned: async () => 0 } as never,
          tracker: { listRecoverable: async () => [] } as never,
        },
        healthCheck: async () => undefined,
        close: async () => undefined,
      }));

      const headers = { 'x-dfr-key': 'dfr_LayerKy1_layerMetricsSecret0123456789abc' };
      const read = await fetch(`http://127.0.0.1:${app.port}/v1/chains/base-sepolia`, { headers });
      expect(read.status).toBe(200);

      const scrape = await fetch(`http://127.0.0.1:${app.port}/metrics`, { headers });
      expect(scrape.status).toBe(200);
      const text = await scrape.text();

      // §5.2 Core
      expect(text).toContain('dfr_core_operations_total');
      expect(text).toContain('dfr_core_operation_duration_seconds_count');
      // §5.3 Adapter
      expect(text).toContain('dfr_adapter_calls_total{adapter="evm",adapter_version="0.1.0"');
      expect(text).toContain('dfr_adapter_call_duration_seconds_count');
      // §5.4 Provider（含 gauge，启动时已刷过一次）
      expect(text).toContain('dfr_provider_requests_total');
      expect(text).toContain('dfr_provider_score{provider_id="base-sepolia-primary"');
      expect(text).toContain('dfr_provider_circuit_state{provider_id="base-sepolia-primary"');
      // base-sepolia 未配置 quota → 不暴露该指标。
      expect(text).not.toContain('dfr_provider_quota_used_ratio');
      // 未实现的成本指标不得出现。
      expect(text).not.toContain('cost_usd');
      // 不得泄漏 RPC 端点。
      expect(text).not.toContain('127.0.0.1');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);
});
