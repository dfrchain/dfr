import { describe, expect, it } from 'vitest';
import { TransactionMetrics, TransactionEngine } from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

describe('transaction metrics', () => {
  it('exports transaction stage/finality/reorg/lease series without high-cardinality labels', () => {
    const metrics = new TransactionMetrics();
    metrics.recordStage({ chain: 'ethereum-sepolia', stage: 'confirm', status: 'timeout', durationSeconds: 1.25 });
    metrics.recordFinality({ chain: 'ethereum-sepolia', level: 'finalized', durationSeconds: 12 });
    metrics.recordReorg({ chain: 'ethereum-sepolia', depthBucket: '1-2' });
    metrics.recordLease({ chain: 'ethereum-sepolia', outcome: 'held_by_other' });

    const output = metrics.renderPrometheus();
    expect(output).toContain('dfr_transaction_stage_total{chain="ethereum-sepolia",stage="confirm",status="timeout",error_code="none"} 1');
    expect(output).toContain('dfr_transaction_stage_duration_seconds_sum{chain="ethereum-sepolia",stage="confirm"} 1.25');
    expect(output).toContain('dfr_transaction_finality_wait_seconds_count{chain="ethereum-sepolia",level="finalized"} 1');
    expect(output).toContain('dfr_transaction_reorg_total{chain="ethereum-sepolia",depth_bucket="1-2"} 1');
    expect(output).toContain('dfr_transaction_tracker_lease_total{chain="ethereum-sepolia",outcome="held_by_other"} 1');
    expect(output).not.toMatch(/tx_hash|account|request_id|trace_id|0x[0-9a-f]{64}/iu);
  });

  it('bounds metric series and normalizes unsafe/high-cardinality label values', () => {
    const metrics = new TransactionMetrics({ maxSeriesPerMetric: 2 });
    metrics.recordLease({ chain: 'chain-a', outcome: 'acquired' });
    metrics.recordLease({ chain: 'chain-b', outcome: 'acquired' });
    metrics.recordLease({ chain: 'arbitrary/user/value', outcome: 'acquired' });

    const output = metrics.renderPrometheus();
    expect(output).toContain('chain="other"');
    expect(output).not.toContain('arbitrary/user/value');
    expect(metrics.seriesCount('dfr_transaction_tracker_lease_total')).toBeLessThanOrEqual(2);
  });

  it('records real engine stage outcomes and never labels them with trace/request identifiers', async () => {
    const metrics = new TransactionMetrics();
    const stores = createInMemoryTransactionStores();
    const engine = new TransactionEngine({
      stores,
      metrics,
      chain: {
        getPendingNonce: async () => '7' as never,
        build: async ({ request }) => ({
          schemaVersion: '1',
          chain: request.chain,
          payload: '0x1234',
          meta: { encoding: 'hex', requiresNonce: request.nonce ?? ('0' as never) },
        }),
        simulate: async () => ({ success: true, gasEstimate: '21000' as never, warnings: [] }),
      },
      newTransactionId: () => 'txn_metrics' as never,
    });
    await engine.build({
      request: {
        chain: 'ethereum-sepolia' as never,
        from: { chain: 'ethereum-sepolia' as never, address: '0x1111111111111111111111111111111111111111' },
        to: { chain: 'ethereum-sepolia' as never, address: '0x2222222222222222222222222222222222222222' },
        value: { asset: { kind: 'native', chain: 'ethereum-sepolia' as never }, amount: '1' as never },
      },
      requestId: 'req_sensitive_label' as never,
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
    const output = metrics.renderPrometheus();
    expect(output).toContain('dfr_transaction_stage_total{chain="ethereum-sepolia",stage="build",status="success",error_code="none"} 1');
    expect(output).not.toContain('req_sensitive_label');
    expect(output).not.toContain('a'.repeat(32));
    expect(output).not.toContain('b'.repeat(16));
  });
});
