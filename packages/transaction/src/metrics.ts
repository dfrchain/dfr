/**
 * Transaction lifecycle metrics (DFR-M1-D06).
 *
 * The rendering and bounded-label mechanics live in `@dfr/metrics`' `MetricRegistry` (a zero-dependency leaf package,
 * shared with the Gateway's HTTP metrics). This file only handles the **mapping**:
 * translating domain inputs — lifecycle stage, finality, reorgs, leases — into bounded-label metric writes.
 *
 * Label values all come from bounded enums (chain / stage / status / level / depth_bucket / outcome /
 * DFR error codes), so there is no high-cardinality risk; `MetricRegistry` still applies a value-and-cardinality safety net.
 */
import { MetricRegistry, type MetricRegistryOptions } from '@dfr/metrics';
import type { ChainId, FinalityLevel } from '@dfr/types';

export type TransactionStage = 'build' | 'preflight' | 'simulate' | 'sign' | 'broadcast' | 'confirm' | 'finalize';
export type TransactionStageStatus = 'success' | 'error' | 'timeout' | 'pending';
export type TrackerLeaseOutcome = 'acquired' | 'held_by_other' | 'renewed' | 'lost' | 'released';
export type ReorgDepthBucket = '1-2' | '3-5' | '6+' | 'unknown';

/** Consistent with `@dfr/metrics`' options (this has been the shape since D06). */
export type TransactionMetricsOptions = MetricRegistryOptions;

export interface TransactionMetricsSink {
  recordStage(input: {
    readonly chain: ChainId | string;
    readonly stage: TransactionStage;
    readonly status: TransactionStageStatus;
    readonly errorCode?: string;
    readonly durationSeconds: number;
  }): void;
  recordFinality(input: {
    readonly chain: ChainId | string;
    readonly level: FinalityLevel;
    readonly durationSeconds: number;
  }): void;
  recordReorg(input: { readonly chain: ChainId | string; readonly depthBucket: ReorgDepthBucket }): void;
  recordLease(input: { readonly chain: ChainId | string; readonly outcome: TrackerLeaseOutcome }): void;
}

/** Correlation fields (trace/span); the metrics themselves do not use them, but the injection point needs a uniform shape. */
export interface TraceContext {
  readonly traceId?: string;
  readonly spanId?: string;
}

const STAGE_TOTAL = 'dfr_transaction_stage_total';
const STAGE_DURATION = 'dfr_transaction_stage_duration_seconds';
const FINALITY_WAIT = 'dfr_transaction_finality_wait_seconds';
const REORG_TOTAL = 'dfr_transaction_reorg_total';
const LEASE_TOTAL = 'dfr_transaction_tracker_lease_total';

/** In-process, bounded Prometheus metric registry (M1 transaction lifecycle). */
export class TransactionMetrics implements TransactionMetricsSink {
  private readonly registry: MetricRegistry;

  constructor(options: TransactionMetricsOptions = {}) {
    this.registry = new MetricRegistry(options);
    this.registry.declareCounter(STAGE_TOTAL, 'Transaction lifecycle stage count.');
    this.registry.declareHistogram(
      STAGE_DURATION,
      'Transaction lifecycle stage duration in seconds.',
    );
    this.registry.declareHistogram(
      FINALITY_WAIT,
      'Confirm request wait time until requested finality is observed in seconds.',
    );
    this.registry.declareCounter(REORG_TOTAL, 'Observed included transaction reorg count.');
    this.registry.declareCounter(LEASE_TOTAL, 'Tracker lease outcomes.');
  }

  recordStage(input: Parameters<TransactionMetricsSink['recordStage']>[0]): void {
    // Label order is fixed as chain → stage → status → error_code: existing rendering tests assert on this order.
    this.registry.increment(STAGE_TOTAL, {
      chain: String(input.chain),
      stage: input.stage,
      status: input.status,
      error_code: input.errorCode ?? 'none',
    });
    this.registry.observe(
      STAGE_DURATION,
      { chain: String(input.chain), stage: input.stage },
      input.durationSeconds,
    );
  }

  recordFinality(input: Parameters<TransactionMetricsSink['recordFinality']>[0]): void {
    this.registry.observe(
      FINALITY_WAIT,
      { chain: String(input.chain), level: input.level },
      input.durationSeconds,
    );
  }

  recordReorg(input: Parameters<TransactionMetricsSink['recordReorg']>[0]): void {
    this.registry.increment(REORG_TOTAL, {
      chain: String(input.chain),
      depth_bucket: input.depthBucket,
    });
  }

  recordLease(input: Parameters<TransactionMetricsSink['recordLease']>[0]): void {
    this.registry.increment(LEASE_TOTAL, {
      chain: String(input.chain),
      outcome: input.outcome,
    });
  }

  seriesCount(metric: string): number {
    return this.registry.seriesCount(metric);
  }

  renderPrometheus(): string {
    return this.registry.renderPrometheus();
  }
}
