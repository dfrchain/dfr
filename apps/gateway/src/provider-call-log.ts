/**
 * Provider 调用记录 → 结构化日志字段（DFR-M1-E02 观测补充）。
 *
 * 权威来源：docs/architecture/observability-spec-v0.1.md 第 3/7 节（统一关联字段与脱敏规则）、
 * provider-spec 第 9 章（`ProviderCallRecord` 字段）。
 *
 * 为什么需要显式 allowlist：`ProviderCallRecord` 由 `@dfr/provider` 定义，未来可能新增字段。
 * 若直接 `JSON.stringify(record)` 落日志，一个新增字段（例如端点、凭证引用、请求体）
 * 就会静默进入生产日志，而这类泄漏几乎无法事后补救。因此这里**只**挑出白名单字段，
 * 并由 `apps/gateway/test/provider-call-log.test.ts` 断言"记录的每个字段要么在白名单内、
 * 要么在显式排除列表内"——新增字段会立刻让测试失败，强制人工确认它是否可入日志。
 */
import type { ProviderCallRecord } from '@dfr/provider';

/**
 * 允许写入日志的字段，映射到 observability-spec 第 3 章的 snake_case 统一命名。
 *
 * 刻意排除：`network` 与 `providerKind`（内部拓扑细节，且当前未列入规范命名表）；
 * 更关键的是——记录里本就**不含** endpoint / credential / 请求体 / 响应体。
 */
export const PROVIDER_CALL_LOG_FIELDS = {
  requestId: 'request_id',
  traceId: 'trace_id',
  spanId: 'span_id',
  chain: 'chain',
  providerId: 'provider_id',
  method: 'method',
  methodClass: 'method_class',
  status: 'status',
  errorCode: 'error_code',
  latencyMs: 'latency_ms',
  retryCount: 'retry_count',
  circuitState: 'circuit_state',
  scoreAtCall: 'score_at_call',
  failover: 'failover',
} as const satisfies Partial<Record<keyof ProviderCallRecord, string>>;

/**
 * 已知但**故意不写日志**的字段；必须显式列出，否则下面的契约测试无法区分
 * "忘了加" 与 "有意排除"。
 */
export const PROVIDER_CALL_LOG_EXCLUDED: readonly (keyof ProviderCallRecord)[] = [
  'network',
  'providerKind',
];

/** 从一条调用记录构造日志字段；只取白名单键，undefined 一律丢弃。 */
export function providerCallLogFields(record: ProviderCallRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceKey, logKey] of Object.entries(PROVIDER_CALL_LOG_FIELDS) as [
    keyof ProviderCallRecord,
    string,
  ][]) {
    const value = record[sourceKey];
    if (value !== undefined) out[logKey] = value;
  }
  // 便于按失败率与熔断状态建看板；不影响脱敏。
  out['level'] = record.status === 'success' ? 'info' : 'warn';
  out['msg'] = 'provider call';
  return out;
}

/**
 * 构造 `DfrCore.onProviderCall` 的日志出口。
 *
 * `write` 注入点：生产传 `process.stdout.write`，测试可捕获输出。
 * 返回的回调**不得抛错**：观测失败不能影响被观测的调用路径。
 */
export function createProviderCallLogger(
  write: (line: string) => void,
): (record: ProviderCallRecord) => void {
  return (record) => {
    try {
      write(`${JSON.stringify(providerCallLogFields(record))}\n`);
    } catch {
      // 观测是尽力而为：序列化失败也不得冒泡到 Provider 调用栈。
    }
  };
}
