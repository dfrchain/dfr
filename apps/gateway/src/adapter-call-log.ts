/**
 * Adapter 调用记录 → 结构化日志字段（DFR-M1-E02 观测补充）。
 *
 * 权威来源：observability-spec 第 3 章统一关联字段、第 4 章 span 层级
 * （`core.operation` → `adapter.call` → `provider.request`）。
 *
 * 与 `provider-call-log.ts` 同构：**白名单**而非透传。Adapter 的调用参数可能含
 * calldata / unsigned payload / 地址列表，返回值可能含完整交易；这些都不入日志。
 * 白名单确保未来给 `AdapterCallRecord` 加字段时不会静默把参数或载荷写进生产日志。
 */
import type { AdapterCallRecord } from '@dfr/core';

export const ADAPTER_CALL_LOG_FIELDS = {
  requestId: 'request_id',
  traceId: 'trace_id',
  spanId: 'span_id',
  adapter: 'adapter',
  adapterVersion: 'adapter_version',
  chain: 'chain',
  method: 'method',
  methodClass: 'method_class',
  status: 'status',
  errorCode: 'error_code',
  latencyMs: 'latency_ms',
} as const satisfies Partial<Record<keyof AdapterCallRecord, string>>;

/**
 * 已知但**故意不写日志**的字段。
 *
 * 当前为空：`AdapterCallRecord` 的每个字段都可入日志。保留该常量是为了让契约测试
 * 能区分"新增字段忘了归类"与"有意排除"，与 provider 日志保持同一种结构。
 */
export const ADAPTER_CALL_LOG_EXCLUDED: readonly (keyof AdapterCallRecord)[] = [];

/** 从一条 Adapter 调用记录构造日志字段；只取白名单键，undefined 一律丢弃。 */
export function adapterCallLogFields(record: AdapterCallRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceKey, logKey] of Object.entries(ADAPTER_CALL_LOG_FIELDS) as [
    keyof AdapterCallRecord,
    string,
  ][]) {
    const value = record[sourceKey];
    if (value !== undefined) out[logKey] = value;
  }
  out['level'] = record.status === 'success' ? 'info' : 'warn';
  out['msg'] = 'adapter call';
  return out;
}

/**
 * 构造 `DfrCore.onAdapterCall` 的日志出口。
 *
 * 与 Provider 版本相同的约定：出口**不得抛错**，观测失败不能影响业务路径。
 * 之所以再加一层 try/catch（Core 已经包了一层），是因为序列化本身也可能失败
 * （例如循环引用），而这里最清楚如何安全降级。
 */
export function createAdapterCallLogger(
  write: (line: string) => void,
): (record: AdapterCallRecord) => void {
  return (record) => {
    try {
      write(`${JSON.stringify(adapterCallLogFields(record))}\n`);
    } catch {
      // 观测是尽力而为。
    }
  };
}
