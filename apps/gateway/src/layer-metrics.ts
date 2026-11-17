/**
 * Core / Adapter / Provider 三层指标（observability-spec §5.2 / §5.3 / §5.4）。
 *
 * 这三层的数据源都已存在，只是此前没有汇成指标：
 * - Core：`onCoreOperation`（§5.2）+ `onCapabilityUnsupported`（§5.2/§5.3 的 mismatch）；
 * - Adapter：`onAdapterCall`（§5.3）；
 * - Provider：`onProviderCall`（§5.4 的计数器）+ `providerObservability()`（§5.4 的 gauge）。
 *
 * 之所以都放在 Gateway：composition root 是唯一同时持有这三条 hook 的地方，
 * 且指标是**部署关注点**而非领域语义——放进 Core/Adapter/Provider 会把
 * Prometheus 的命名与基数约束泄漏进领域层。
 *
 * 未实现项**显式声明**而不伪造：
 * - `dfr_provider_cost_usd_total`：Provider descriptor 的 `cost.priceUsd` 是**单价**，
 *   不是累计费用；累计需要乘每次调用量并按周期结算，属成本核算子系统，M1 没有。
 *   伪造一个恒为 0 的计数器会让人以为"没有成本"，比不暴露更危险。
 * - `dfr_provider_quota_used_ratio`：仅在 descriptor 配置了 `quota.requestsPerDay` 时暴露
 *   （未配置 ≠ 用量为 0）。
 */
import { MetricRegistry, type MetricRegistryOptions } from '@dfr/metrics';
import type { AdapterCallRecord, CoreOperationRecord, ProviderCallRecord, ProviderObservabilitySnapshot } from '@dfr/core';

/* ------------------------------------------------------------------ */
/* §5.2 Core                                                          */
/* ------------------------------------------------------------------ */

const CORE_OPERATIONS = 'dfr_core_operations_total';
const CORE_OPERATION_DURATION = 'dfr_core_operation_duration_seconds';
const CORE_CAPABILITY_UNSUPPORTED = 'dfr_core_capability_unsupported_total';
const CORE_ERRORS = 'dfr_core_errors_total';

export class CoreMetrics {
  private readonly registry: MetricRegistry;

  constructor(options: MetricRegistryOptions = {}) {
    this.registry = new MetricRegistry(options);
    this.registry.declareCounter(CORE_OPERATIONS, 'Core operations by capability and outcome.');
    this.registry.declareHistogram(CORE_OPERATION_DURATION, 'Core operation duration in seconds.');
    this.registry.declareCounter(
      CORE_CAPABILITY_UNSUPPORTED,
      'Operations rejected because the Adapter does not declare the capability.',
    );
    this.registry.declareCounter(CORE_ERRORS, 'Core errors by code and category.');
  }

  recordOperation(record: CoreOperationRecord): void {
    this.registry.increment(CORE_OPERATIONS, {
      operation: record.operation,
      chain: String(record.chain),
      status: record.status,
      error_code: record.errorCode ?? 'none',
    });
    this.registry.observe(
      CORE_OPERATION_DURATION,
      { operation: record.operation, chain: String(record.chain) },
      record.latencyMs / 1000,
    );
    if (record.errorCode !== undefined) {
      this.registry.increment(CORE_ERRORS, {
        error_code: record.errorCode,
        category: record.category ?? 'unknown',
      });
    }
  }

  recordCapabilityUnsupported(input: { chain: string; capability: string }): void {
    this.registry.increment(CORE_CAPABILITY_UNSUPPORTED, {
      chain: input.chain,
      capability: input.capability,
    });
  }

  renderPrometheus(): string {
    return this.registry.renderPrometheus();
  }
}

/* ------------------------------------------------------------------ */
/* §5.3 Adapter                                                       */
/* ------------------------------------------------------------------ */

const ADAPTER_CALLS = 'dfr_adapter_calls_total';
const ADAPTER_CALL_DURATION = 'dfr_adapter_call_duration_seconds';
const ADAPTER_ERRORS = 'dfr_adapter_errors_total';
const ADAPTER_REGISTRY_MISMATCH = 'dfr_adapter_registry_mismatch_total';

export class AdapterMetrics {
  private readonly registry: MetricRegistry;

  constructor(options: MetricRegistryOptions = {}) {
    this.registry = new MetricRegistry(options);
    this.registry.declareCounter(ADAPTER_CALLS, 'Adapter calls by adapter, chain and outcome.');
    this.registry.declareHistogram(ADAPTER_CALL_DURATION, 'Adapter call duration in seconds.');
    this.registry.declareCounter(ADAPTER_ERRORS, 'Adapter errors by chain and error code.');
    this.registry.declareCounter(
      ADAPTER_REGISTRY_MISMATCH,
      'Declared capability without an Adapter method (should be 0).',
    );
  }

  recordCall(record: AdapterCallRecord): void {
    this.registry.increment(ADAPTER_CALLS, {
      adapter: record.adapter,
      adapter_version: record.adapterVersion,
      chain: String(record.chain),
      method_class: record.methodClass,
      status: record.status,
    });
    this.registry.observe(
      ADAPTER_CALL_DURATION,
      {
        adapter: record.adapter,
        chain: String(record.chain),
        method_class: record.methodClass,
      },
      record.latencyMs / 1000,
    );
    if (record.errorCode !== undefined) {
      this.registry.increment(ADAPTER_ERRORS, {
        adapter: record.adapter,
        chain: String(record.chain),
        error_code: record.errorCode,
      });
    }
  }

  /** Registry 声明了能力但 Adapter 没有对应方法（spec §8：说明启动校验被绕过）。 */
  recordRegistryMismatch(chain: string): void {
    this.registry.increment(ADAPTER_REGISTRY_MISMATCH, { chain });
  }

  renderPrometheus(): string {
    return this.registry.renderPrometheus();
  }
}

/* ------------------------------------------------------------------ */
/* §5.4 Provider                                                      */
/* ------------------------------------------------------------------ */

const PROVIDER_REQUESTS = 'dfr_provider_requests_total';
const PROVIDER_REQUEST_DURATION = 'dfr_provider_request_duration_seconds';
const PROVIDER_AVAILABILITY = 'dfr_provider_availability_ratio';
const PROVIDER_ERROR_RATIO = 'dfr_provider_error_ratio';
const PROVIDER_CIRCUIT_STATE = 'dfr_provider_circuit_state';
const PROVIDER_RETRIES = 'dfr_provider_retries_total';
const PROVIDER_SCORE = 'dfr_provider_score';
const PROVIDER_QUOTA_USED = 'dfr_provider_quota_used_ratio';

export class ProviderMetrics {
  private readonly registry: MetricRegistry;

  constructor(options: MetricRegistryOptions = {}) {
    this.registry = new MetricRegistry(options);
    this.registry.declareCounter(PROVIDER_REQUESTS, 'Provider requests by outcome.');
    this.registry.declareHistogram(PROVIDER_REQUEST_DURATION, 'Provider request duration in seconds.');
    this.registry.declareGauge(PROVIDER_AVAILABILITY, 'Provider availability ratio (0..1).');
    this.registry.declareGauge(PROVIDER_ERROR_RATIO, 'Provider error ratio (0..1).');
    this.registry.declareGauge(PROVIDER_CIRCUIT_STATE, 'Provider circuit state (1 = open).');
    this.registry.declareCounter(PROVIDER_RETRIES, 'Provider retries by reason.');
    this.registry.declareGauge(PROVIDER_SCORE, 'Provider selection score (0..100).');
    this.registry.declareGauge(PROVIDER_QUOTA_USED, 'Provider daily quota used ratio (0..1).');
  }

  /**
   * 每次 Provider 调用（含失败与重试）都计数。
   *
   * `retry_count > 0` 时额外记一次重试：spec §5.4 的 `retries_total{reason}` 需要
   * "为什么重试"，而记录里没有原因字段，因此用**分类**代替——
   * 只有 `safe-read` 允许重试（写路径重试恒为 0），所以 reason 取方法类别是诚实的：
   * 写路径若出现 retry_count > 0，本身就是一个必须告警的异常（会体现在 method_class 上）。
   */
  recordCall(record: ProviderCallRecord): void {
    this.registry.increment(PROVIDER_REQUESTS, {
      provider_id: record.providerId,
      chain: String(record.chain),
      method_class: record.methodClass,
      status: record.status,
      error_code: record.errorCode ?? 'none',
    });
    this.registry.observe(
      PROVIDER_REQUEST_DURATION,
      { provider_id: record.providerId, chain: String(record.chain) },
      record.latencyMs / 1000,
    );
    if (record.retryCount > 0) {
      this.registry.increment(
        PROVIDER_RETRIES,
        { provider_id: record.providerId, chain: String(record.chain), reason: record.methodClass },
        record.retryCount,
      );
    }
  }

  /**
   * 用观测快照刷新 gauge。由巡检周期调用（不是每次请求）——
   * gauge 是"当前状态"，高频写入只会浪费 CPU 与序列内存。
   */
  refreshGauges(byChain: Record<string, readonly ProviderObservabilitySnapshot[]>): void {
    for (const [chain, snapshots] of Object.entries(byChain)) {
      for (const snapshot of snapshots) {
        const labels = { provider_id: snapshot.providerId, chain };
        // availability：健康窗口里没有样本时视为 1（尚无失败证据），而不是 0
        // ——否则刚注册的 Provider 会被报成"完全不可用"。
        const errorRate = snapshot.health.errorRate ?? 0;
        this.registry.setGauge(PROVIDER_AVAILABILITY, labels, Math.max(0, 1 - errorRate));
        this.registry.setGauge(PROVIDER_ERROR_RATIO, labels, errorRate);
        this.registry.setGauge(PROVIDER_SCORE, labels, snapshot.score);
        // circuit_state 是 0/1 的两个序列（state 作为标签），便于按状态聚合与告警。
        for (const state of ['closed', 'half-open', 'open'] as const) {
          this.registry.setGauge(
            PROVIDER_CIRCUIT_STATE,
            { ...labels, state },
            snapshot.circuitState === state ? 1 : 0,
          );
        }
        if (snapshot.quotaUsedRatio !== undefined) {
          this.registry.setGauge(PROVIDER_QUOTA_USED, labels, snapshot.quotaUsedRatio);
        }
      }
    }
  }

  renderPrometheus(): string {
    return this.registry.renderPrometheus();
  }
}
