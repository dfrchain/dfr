/**
 * 交易生命周期指标（DFR-M1-D06）。
 *
 * 渲染与有界标签的机制在 `@dfr/metrics` 的 `MetricRegistry`（零依赖叶子包，
 * 与 Gateway 的 HTTP 指标共用同一实现）。本文件只负责**映射**：
 * 把生命周期阶段、finality、重组、租约这些领域输入翻译成有界标签的指标写入。
 *
 * 标签取值全部来自有界枚举（chain / stage / status / level / depth_bucket / outcome /
 * DFR 错误码），因此不存在高基数风险；`MetricRegistry` 仍会做一层值与基数兜底。
 */
import { MetricRegistry, type MetricRegistryOptions } from '@dfr/metrics';
import type { ChainId, FinalityLevel } from '@dfr/types';

export type TransactionStage = 'build' | 'preflight' | 'simulate' | 'sign' | 'broadcast' | 'confirm' | 'finalize';
export type TransactionStageStatus = 'success' | 'error' | 'timeout' | 'pending';
export type TrackerLeaseOutcome = 'acquired' | 'held_by_other' | 'renewed' | 'lost' | 'released';
export type ReorgDepthBucket = '1-2' | '3-5' | '6+' | 'unknown';

/** 与 `@dfr/metrics` 的选项一致（从 D06 起就是这个形状）。 */
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

/** 关联字段（trace/span）；指标本身不使用它们，但注入点需要统一形状。 */
export interface TraceContext {
  readonly traceId?: string;
  readonly spanId?: string;
}

const STAGE_TOTAL = 'dfr_transaction_stage_total';
const STAGE_DURATION = 'dfr_transaction_stage_duration_seconds';
const FINALITY_WAIT = 'dfr_transaction_finality_wait_seconds';
const REORG_TOTAL = 'dfr_transaction_reorg_total';
const LEASE_TOTAL = 'dfr_transaction_tracker_lease_total';

/** 进程内、有界的 Prometheus 指标注册表（M1 交易生命周期）。 */
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
    // 标签顺序固定为 chain → stage → status → error_code：既有渲染测试按此顺序断言。
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
