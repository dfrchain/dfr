/**
 * Span 导出（M5 生产加固 E6）。
 *
 * 两个实现，语义刻意不同：
 * - `InMemorySpanExporter`：测试与本地诊断用；
 * - `JsonlSpanExporter`：把 OTLP/JSON 行写到一个 sink（默认 stdout），
 *   便于被 filebeat / fluent-bit / collector 采集。
 *
 * 为什么不直接调远程 OTLP endpoint：`pnpm verify` 必须离线；而且把网络调用
 * 放进请求路径会把"观测后端抖动"变成"业务失败"。导出是**尽力而为**：
 * `export()` 永不抛错（与各层日志出口同一约定）。
 *
 * 格式：OTLP/JSON 的 `resourceSpans → scopeSpans → spans` 形状。
 * 只填我们真正拥有的字段，不伪造 SDK 元数据。
 */

import type { SpanRecord } from './span.js';

export interface SpanExporter {
  /** 导出（尽力而为，**不得抛错**）。 */
  export(spans: readonly SpanRecord[]): void;
  /** 关闭/刷盘（可选）。 */
  shutdown?(): void;
}

/** 内存导出器：测试断言用。按导出顺序保留原始记录。 */
export class InMemorySpanExporter implements SpanExporter {
  private readonly spans: SpanRecord[] = [];

  export(spans: readonly SpanRecord[]): void {
    this.spans.push(...spans);
  }

  /** 已导出的 span 快照（副本，避免调用方改动内部状态）。 */
  get exported(): readonly SpanRecord[] {
    return [...this.spans];
  }

  reset(): void {
    this.spans.length = 0;
  }
}

/**
 * JSONL 导出器。
 *
 * `sink` 默认 `process.stdout.write`；调用方负责不在这里写敏感内容——
 * span 属性已经过各层白名单，本模块不再二次过滤（重复过滤会掩盖白名单的漏洞）。
 */
export class JsonlSpanExporter implements SpanExporter {
  readonly #sink: (line: string) => void;
  readonly #serviceName: string;

  constructor(sink: (line: string) => void, serviceName = 'dfr-gateway') {
    this.#sink = sink;
    this.#serviceName = serviceName;
  }

  export(spans: readonly SpanRecord[]): void {
    if (spans.length === 0) return;
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: this.#serviceName } }],
          },
          scopeSpans: [
            {
              scope: { name: '@dfr/telemetry' },
              spans: spans.map((span) => toOtlpSpan(span)),
            },
          ],
        },
      ],
    };
    try {
      this.#sink(`${JSON.stringify(payload)}\n`);
    } catch {
      // 观测失败不影响业务（与各层日志出口同一约定）。
    }
  }
}

/** `SpanRecord` → OTLP span。未设置的字段**不出现**，不用空值占位。 */
export function toOtlpSpan(span: SpanRecord): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL：这些都是进程内调用，不是 RPC 客户端/服务端语义。
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value: otlpValue(value),
    })),
    status: {
      // OTLP: 0=UNSET, 1=OK, 2=ERROR。失败时带 errorCode 作为描述。
      code: span.status === 'ok' ? 1 : 2,
      ...(span.errorCode !== undefined ? { message: span.errorCode } : {}),
    },
  };
}

function otlpValue(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  // 整数用 intValue（十进制字符串，OTLP 规定 int64 用字符串编码）。
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}
