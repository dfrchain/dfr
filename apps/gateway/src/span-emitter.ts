/**
 * Gateway 的 span 导出接线（M5 生产加固 E6）。
 *
 * 把 observability-spec §4 的四层记录（`core.operation` / `adapter.call` /
 * `provider.request` / `store.read|write`）转成**真实 span**，并交给 `SpanExporter`。
 *
 * 与已有日志出口的关系：**并存，不替换**。
 * - 日志出口（`*-call-log.ts`）保持原样：它们是运维检索的主入口；
 * - 本模块额外产出 OTLP span，供 Trace 后端（Collector/Jaeger/Tempo）重建层级。
 *
 * 为什么 opt-in（`DFR_OTLP_SPANS=true`）：现有部署可能没有 Trace 后端，
 * 无条件输出会让 stdout 翻倍。默认关闭即"行为不变"，这是本仓对既有部署的一贯要求。
 *
 * 为什么属性走各层自己的白名单函数：白名单已经在日志路径上被测试锁定；
 * 复用它意味着 span 不会引入**新的**字段暴露面——不存在"日志过滤了、span 泄漏了"。
 */
import {
  createSpanBridge,
  JsonlSpanExporter,
  type SpanExporter,
} from '@dfr/telemetry';
import type { ProviderCallRecord } from '@dfr/provider';
import type { AdapterCallRecord, CoreOperationRecord } from '@dfr/core';
import type { StoreCallRecord } from '@dfr/transaction';
import { providerCallLogFields } from './provider-call-log.js';
import { adapterCallLogFields } from './adapter-call-log.js';
import { coreOperationLogFields } from './core-operation-log.js';
import { storeCallLogFields } from './store-call-log.js';

/** 一层观测记录 → span 名称的映射（与 observability-spec §4 的层级名一一对应）。 */
export const SPAN_NAMES = {
  coreOperation: 'core.operation',
  adapterCall: 'adapter.call',
  providerRequest: 'provider.request',
} as const;

/** store 的 span 名称由 kind 决定（`store.read` / `store.write`），与日志口径一致。 */
export function storeSpanName(kind: StoreCallRecord['kind']): string {
  return kind === 'read' ? 'store.read' : 'store.write';
}

/**
 * 把日志白名单产出的 `snake_case` 字段转成 span 属性。
 *
 * `request_id`/`trace_id`/`span_id` 三个**关联字段不进属性**：它们是 span 自身的
 * 身份与父子关系，放进属性会把同一信息存两份并可能不一致。`span`/`level`/`msg`
 * 是日志专用键，同样不属于 span 属性。
 */
const NON_ATTRIBUTE_KEYS = new Set(['request_id', 'trace_id', 'span_id', 'span', 'level', 'msg']);

export function attributesFromLogFields(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (NON_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/** 四层桥接器集合；`undefined` 表示该层未装配。 */
export interface SpanEmitters {
  readonly coreOperation?: (record: CoreOperationRecord) => void;
  readonly adapterCall?: (record: AdapterCallRecord) => void;
  readonly providerRequest?: (record: ProviderCallRecord) => void;
  readonly storeCall?: (record: StoreCallRecord) => void;
}

/**
 * 构造四层 span 发射器。
 *
 * 传 `exporter` 便于测试注入内存导出器；生产用默认 stdout JSONL。
 */
export function createSpanEmitters(exporter?: SpanExporter): SpanEmitters {
  const sink: SpanExporter =
    exporter ?? new JsonlSpanExporter((line) => process.stdout.write(line));

  return {
    coreOperation: createSpanBridge({
      spanName: SPAN_NAMES.coreOperation,
      exporter: sink,
      attributesOf: (record) => attributesFromLogFields(coreOperationLogFields(record as CoreOperationRecord)),
    }),
    adapterCall: createSpanBridge({
      spanName: SPAN_NAMES.adapterCall,
      exporter: sink,
      attributesOf: (record) => attributesFromLogFields(adapterCallLogFields(record as AdapterCallRecord)),
    }),
    providerRequest: createSpanBridge({
      spanName: SPAN_NAMES.providerRequest,
      exporter: sink,
      attributesOf: (record) => attributesFromLogFields(providerCallLogFields(record as ProviderCallRecord)),
    }),
    storeCall: (record) => {
      // store 层的 span 名称依赖 kind，因此每次调用构造一个桥接器；
      // 桥接器本身无状态（只有 name 与 exporter），这点开销可接受。
      createSpanBridge({
        spanName: storeSpanName(record.kind),
        exporter: sink,
        attributesOf: (r) => attributesFromLogFields(storeCallLogFields(r as StoreCallRecord)),
      })(record);
    },
  };
}
