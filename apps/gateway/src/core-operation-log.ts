/**
 * Core 操作日志（observability-spec §4 的 `core.operation` span 层）。
 *
 * §4 的 span 层级是：
 *
 * ```text
 * http.request（Gateway）
 *   └─ core.operation（Core 领域编排）
 *        ├─ adapter.call
 *        │    └─ provider.request
 *        └─ store.read / store.write
 * ```
 *
 * 前四层与 store.* 都已落日志（`{provider,adapter,store}-call-log.ts`），
 * 只有 `core.operation` 缺一个出口——本文件补上。
 *
 * **诚实的边界**：M1 用 `trace_id` + `request_id` 关联重建层级，而不是真正的
 * parent/child `span_id`。当前三层共享同一个请求 span（网关生成的 spanId）。
 * 真正的父子 span（每层独立 spanId + 父引用）需要 OpenTelemetry SDK，
 * 属后续任务；本节不假装已经做到。
 *
 * 与其他层同构：**白名单**映射，`CoreOperationRecord` 新增字段会迫使契约测试失败。
 */
import type { CoreOperationRecord } from '@dfr/core';

export const CORE_OPERATION_LOG_FIELDS = {
  requestId: 'request_id',
  traceId: 'trace_id',
  spanId: 'span_id',
  operation: 'operation',
  chain: 'chain',
  status: 'status',
  errorCode: 'error_code',
  category: 'error_category',
  latencyMs: 'latency_ms',
} as const satisfies Partial<Record<keyof CoreOperationRecord, string>>;

/** 已知但故意不写日志的字段；当前为空（记录里只有形状与关联字段）。 */
export const CORE_OPERATION_LOG_EXCLUDED: readonly (keyof CoreOperationRecord)[] = [];

export function coreOperationLogFields(record: CoreOperationRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceKey, logKey] of Object.entries(CORE_OPERATION_LOG_FIELDS) as [
    keyof CoreOperationRecord,
    string,
  ][]) {
    const value = record[sourceKey];
    if (value !== undefined) out[logKey] = value;
  }
  out['span'] = 'core.operation';
  out['level'] = record.status === 'success' ? 'info' : 'warn';
  out['msg'] = 'core operation';
  return out;
}

/** 日志出口；不得抛错（观测失败不影响业务）。 */
export function createCoreOperationLogger(
  write: (line: string) => void,
): (record: CoreOperationRecord) => void {
  return (record) => {
    try {
      write(`${JSON.stringify(coreOperationLogFields(record))}\n`);
    } catch {
      // 观测是尽力而为。
    }
  };
}
