// Core / Adapter / Provider three-layer metrics contract test (observability-spec §5.2/§5.3/§5.4).
//
// The point is not "can it render", but three disciplines that are easy to get wrong:
//   1. all labels are bounded (chain / provider_id / method_class / error_code …);
//   2. **do not fabricate unimplemented metrics** (provider cost, unconfigured quotas);
//   3. read/write classification is correct (only broadcast is a write).
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

describe('CoreMetrics (§5.2)', () => {
  it('operation counts / durations / error classification', () => {
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
    // Success produces no error count.
    expect(out).not.toContain('error_code="none",category');
  });

  it('unsupported capabilities are counted separately (normally 0)', () => {
    const m = new CoreMetrics();
    m.recordCapabilityUnsupported({ chain: 'base-sepolia', capability: 'transaction.broadcast' });
    expect(m.renderPrometheus()).toContain(
      'dfr_core_capability_unsupported_total{chain="base-sepolia",capability="transaction.broadcast"} 1',
    );
  });
});

describe('AdapterMetrics (§5.3)', () => {
  it('call counts carry adapter / version / method_class, with errors counted separately', () => {
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

  it('registry inconsistency counter (spec §8: should be 0)', () => {
    const m = new AdapterMetrics();
    m.recordRegistryMismatch('ethereum-sepolia');
    expect(m.renderPrometheus()).toContain(
      'dfr_adapter_registry_mismatch_total{chain="ethereum-sepolia"} 1',
    );
  });
});

describe('ProviderMetrics (§5.4)', () => {
  it('request counts / durations / retries counted by method class', () => {
    const m = new ProviderMetrics();
    m.recordCall(PROVIDER_RECORD);
    m.recordCall({ ...PROVIDER_RECORD, status: 'error', errorCode: 'DFR_PROVIDER_TIMEOUT', retryCount: 2 });
    const out = m.renderPrometheus();
    expect(out).toContain(
      'dfr_provider_requests_total{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",method_class="read",status="success",error_code="none"} 1',
    );
    expect(out).toContain('dfr_provider_request_duration_seconds_count{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia"} 2');
    // retry_count = 2 → the retry count increases by 2 (not by 1).
    expect(out).toContain(
      'dfr_provider_retries_total{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",reason="read"} 2',
    );
  });

  it('gauges: availability / error rate / score / circuit-breaker state (three 0/1 series)', () => {
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
    // Circuit-breaker state uses three 0/1 series with a state label, for SUM/alerting.
    expect(out).toContain('dfr_provider_circuit_state{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",state="open"} 1');
    expect(out).toContain('dfr_provider_circuit_state{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",state="closed"} 0');
    expect(out).toContain('dfr_provider_circuit_state{provider_id="ethereum-sepolia-primary",chain="ethereum-sepolia",state="half-open"} 0');
  });

  it('availability is 1 when the health window has no samples (a newly registered Provider must not be judged "fully unavailable")', () => {
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

  it('quota_used_ratio is not exposed when no quota is configured (no fabricated 0 or 1)', () => {
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

  it('unimplemented provider cost metrics are not exposed (a fabricated constant 0 is more dangerous than not exposing)', () => {
    const m = new ProviderMetrics();
    m.recordCall(PROVIDER_RECORD);
    // spec §5.4 lists `dfr_provider_cost_usd_total`, but M1 has no cost-accounting subsystem;
    // the descriptor's priceUsd is a unit price, not a cumulative cost. Better not to expose it.
    expect(m.renderPrometheus()).not.toContain('cost_usd');
  });
});

describe('three-layer metrics label discipline', () => {
  it('high-cardinality values (addresses / hashes / URLs) never enter labels as-is', () => {
    const m = new AdapterMetrics();
    // Simulate the worst case of "passing an address as chain".
    m.recordCall({
      ...ADAPTER_RECORD,
      chain: `0x${'ab'.repeat(32)}` as never,
    });
    const out = m.renderPrometheus();
    expect(out).not.toContain('ab'.repeat(32));
    expect(out).toContain('chain="other"');
  });
});

describe('three-layer metrics end-to-end wiring (real startGateway + real RPC)', () => {
  it('one on-chain read produces all three Core / Adapter / Provider metric families', async () => {
    // A local minimal JSON-RPC: let the request really pass through Core → Adapter → Provider.
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
      // §5.4 Provider (with gauges, refreshed once at startup)
      expect(text).toContain('dfr_provider_requests_total');
      expect(text).toContain('dfr_provider_score{provider_id="base-sepolia-primary"');
      expect(text).toContain('dfr_provider_circuit_state{provider_id="base-sepolia-primary"');
      // base-sepolia has no quota configured → that metric is not exposed.
      expect(text).not.toContain('dfr_provider_quota_used_ratio');
      // Unimplemented cost metrics must not appear.
      expect(text).not.toContain('cost_usd');
      // RPC endpoints must not leak.
      expect(text).not.toContain('127.0.0.1');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);
});
