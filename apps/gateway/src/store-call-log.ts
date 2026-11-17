/**
 * Store 调用记录 → 结构化日志字段（observability-spec 第 4 章 `store.read` / `store.write`）。
 *
 * 与 provider / adapter 日志同构：**白名单**而非透传。Store 调用的参数含地址、nonce、
 * 载荷与租约 token，返回值含完整交易记录——这些都不入日志。白名单还确保未来给
 * `StoreCallRecord` 加字段时，不会静默把业务值写进生产日志。
 */
import type { StoreCallRecord } from '@dfr/transaction';

export const STORE_CALL_LOG_FIELDS = {
  requestId: 'request_id',
  traceId: 'trace_id',
  spanId: 'span_id',
  store: 'store',
  operation: 'operation',
  kind: 'kind',
  status: 'status',
  errorCode: 'error_code',
  latencyMs: 'latency_ms',
} as const satisfies Partial<Record<keyof StoreCallRecord, string>>;

/**
 * 已知但**故意不写日志**的字段。
 *
 * 当前为空：`StoreCallRecord` 的每个字段都可入日志（它本身已被设计为"只有调用形状"）。
 * 保留该常量是为了让契约测试能区分"新增字段忘了归类"与"有意排除"。
 */
export const STORE_CALL_LOG_EXCLUDED: readonly (keyof StoreCallRecord)[] = [];

/**
 * `kind` 在日志里展开为 observability-spec 的 span 名称（`store.read` / `store.write`），
 * 这样看板与 Trace 可以直接按 span 名称对齐，而不必在查询侧再做映射。
 */
export function storeCallLogFields(record: StoreCallRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceKey, logKey] of Object.entries(STORE_CALL_LOG_FIELDS) as [
    keyof StoreCallRecord,
    string,
  ][]) {
    const value = record[sourceKey];
    if (value !== undefined) out[logKey] = value;
  }
  out['span'] = record.kind === 'read' ? 'store.read' : 'store.write';
  out['level'] = record.status === 'success' ? 'info' : 'warn';
  out['msg'] = 'store call';
  return out;
}

/** 构造 Store 调用日志出口；出口不得抛错（观测失败不影响业务）。 */
export function createStoreCallLogger(
  write: (line: string) => void,
): (record: StoreCallRecord) => void {
  return (record) => {
    try {
      write(`${JSON.stringify(storeCallLogFields(record))}\n`);
    } catch {
      // 观测是尽力而为。
    }
  };
}
