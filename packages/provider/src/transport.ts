/**
 * JSON-RPC over HTTP 传输实现（见 docs/architecture/provider-spec-v0.1.md 第 2 章）。
 *
 * 边界：Provider 只负责传输与错误归一化，**不理解链语义**。
 * `method` / `params` 由 Adapter 构造，Provider 原样转发。
 *
 * 安全：endpoint 与 credential 只存在于实例私有字段，永不进入日志或错误。
 */
import { createDfrError, isDfrError } from '@dfr/errors';
import type {
  ChainId,
  NetworkId,
  ProviderDescriptor,
  ProviderHealth,
  ProviderId,
  ProviderKind,
} from '@dfr/types';
import type { MethodClass } from './circuit.js';
import { HealthTracker } from './health.js';

/** 规范的传输接口（provider-spec 第 2 章）。 */
export interface Provider {
  readonly id: ProviderId;
  readonly chain: ChainId;
  readonly network: NetworkId;
  readonly kind: ProviderKind;
  readonly descriptor: ProviderDescriptor;
  request<T>(call: TransportCall, ctx: TransportContext): Promise<T>;
  health(): Promise<ProviderHealth>;
  /** 低权重探针方法名，例如 EVM 的 eth_chainId。 */
  readonly probeMethod: string;
  /** 供评分使用的健康快照（由 request() 自动记录，无需外部再报）。 */
  healthSnapshot(now: number): ProviderHealth;
  /** 探针是否需要运行（单飞 + 间隔控制由 Manager 负责）。 */
  readonly tracker: HealthTracker;
}

export interface TransportCall {
  method: string;
  params: readonly unknown[];
  idempotency: 'safe-read' | 'idempotent-write' | 'non-idempotent-write';
  timeoutMs: number;
}

export interface TransportContext {
  requestId: string;
  traceId?: string;
  spanId?: string;
  signal: AbortSignal;
}

/** 从幂等性推导熔断器/指标的方法类别。 */
export function methodClassOf(idempotency: TransportCall['idempotency']): MethodClass {
  return idempotency === 'safe-read' ? 'read' : 'write';
}

export interface JsonRpcProviderOptions {
  descriptor: ProviderDescriptor;
  endpoint: string;
  credential?: string | undefined;
  /** 注入 fetch 以便测试与 sandbox 环境替换。 */
  fetchImpl?: typeof fetch;
  /** 探针方法；EVM 默认 eth_chainId。 */
  probeMethod?: string;
  /** 凭证注入方式；默认 Authorization: Bearer。 */
  credentialHeader?: (credential: string) => Record<string, string>;
  /**
   * 单调时钟；默认 Date.now()。
   *
   * 必须可注入：健康窗口、评分与健康检查调度都基于同一个时钟，
   * 如果这里偷偷用 Date.now() 而调度用注入时钟，两者的时间轴会错位。
   */
  now?: () => number;
}

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: unknown;
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
}

export class JsonRpcHttpProvider implements Provider {
  readonly id: ProviderId;
  readonly chain: ChainId;
  readonly network: NetworkId;
  readonly kind: ProviderKind;
  readonly descriptor: ProviderDescriptor;
  readonly probeMethod: string;
  readonly tracker = new HealthTracker();

  private readonly endpoint: string;
  private readonly credential: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly credentialHeader: (credential: string) => Record<string, string>;
  private readonly now: () => number;
  private requestSeq = 0;

  constructor(options: JsonRpcProviderOptions) {
    const { descriptor } = options;
    this.descriptor = descriptor;
    this.id = descriptor.id;
    this.chain = descriptor.chain;
    this.network = descriptor.network;
    this.kind = descriptor.kind;
    this.endpoint = options.endpoint;
    this.credential = options.credential;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.probeMethod = options.probeMethod ?? 'eth_chainId';
    this.credentialHeader =
      options.credentialHeader ?? ((value: string) => ({ Authorization: `Bearer ${value}` }));
    this.now = options.now ?? (() => Date.now());
  }

  async request<T>(call: TransportCall, ctx: TransportContext): Promise<T> {
    const started = this.now();
    const timeoutMs = Math.max(1, Math.min(call.timeoutMs, this.descriptor.timeoutMs));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('dfr-timeout')), timeoutMs);
    const onAbort = (): void => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++this.requestSeq,
      method: call.method,
      params: call.params,
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (ctx.traceId !== undefined && ctx.spanId !== undefined &&
        /^[0-9a-f]{32}$/iu.test(ctx.traceId) && /^[0-9a-f]{16}$/iu.test(ctx.spanId)) {
      headers['traceparent'] = `00-${ctx.traceId}-${ctx.spanId}-01`;
    }
    if (this.credential !== undefined && this.credential !== '') {
      Object.assign(headers, this.credentialHeader(this.credential));
    }

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw this.httpError(response.status, call.method, ctx.requestId);
      }

      let parsed: JsonRpcResponse<T>;
      try {
        parsed = (await response.json()) as JsonRpcResponse<T>;
      } catch (cause) {
        throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
          requestId: ctx.requestId as never,
          message: `Provider ${this.id} 返回非 JSON 响应`,
          provider: this.id,
          chain: this.chain,
          cause,
        });
      }

      if (parsed.error !== undefined) {
        throw this.rpcError(parsed.error, ctx.requestId, call.method);
      }
      if (parsed.result === undefined) {
        throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
          requestId: ctx.requestId as never,
          message: `Provider ${this.id} 响应缺少 result`,
          provider: this.id,
          chain: this.chain,
        });
      }
      this.tracker.recordSuccess(this.now() - started, this.now());
      return parsed.result;
    } catch (err) {
      // 已归一化的错误直接上抛，避免二次分类。
      if (isDfrError(err)) throw err;

      const abortedByUs = controller.signal.aborted;
      const elapsed = this.now() - started;
      const timedOut = abortedByUs && elapsed >= timeoutMs - 5;
      const code = timedOut ? 'DFR_PROVIDER_TIMEOUT' : 'DFR_PROVIDER_UNAVAILABLE';
      this.tracker.recordFailure(this.now());
      throw createDfrError(code, {
        requestId: ctx.requestId as never,
        message: timedOut
          ? `Provider ${this.id} 在 ${timeoutMs}ms 后超时`
          : `Provider ${this.id} 连接失败`,
        provider: this.id,
        chain: this.chain,
        details: { timeoutMs, elapsedMs: elapsed, method: call.method },
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  async health(): Promise<ProviderHealth> {
    return this.tracker.snapshot(this.now());
  }

  healthSnapshot(now: number): ProviderHealth {
    return this.tracker.snapshot(now === undefined ? this.now() : now);
  }

  private httpError(status: number, method: string, requestId: string): Error {
    if (status === 429) {
      return createDfrError('DFR_PROVIDER_RATE_LIMITED', {
        requestId: requestId as never,
        message: `Provider ${this.id} 触发上游限流`,
        provider: this.id,
        chain: this.chain,
        details: { status, method },
      });
    }
    if (status >= 500) {
      return createDfrError('DFR_PROVIDER_UNAVAILABLE', {
        requestId: requestId as never,
        message: `Provider ${this.id} 返回 HTTP ${status}`,
        provider: this.id,
        chain: this.chain,
        details: { status, method },
      });
    }
    return createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
      requestId: requestId as never,
      message: `Provider ${this.id} 返回 HTTP ${status}`,
      provider: this.id,
      chain: this.chain,
      details: { status, method },
    });
  }

  /**
   * JSON-RPC error → DFR error（error-spec 第 5.1 章映射表）。
   *
   * 注意：不把原始 message 直接作为 message，只放进已脱敏的 chainError。
   */
  private rpcError(
    error: { code?: number; message?: string },
    requestId: string,
    method: string,
  ): Error {
    const raw = `${error.message ?? ''}`.toLowerCase();
    const chainError = {
      ...(error.code !== undefined ? { code: String(error.code) } : {}),
      ...(error.message !== undefined ? { message: error.message } : {}),
    };

    if (raw.includes('nonce too low')) {
      return createDfrError('DFR_NONCE_CONFLICT', {
        requestId: requestId as never,
        message: `nonce 冲突（${method}）`,
        provider: this.id,
        chain: this.chain,
        chainError,
      });
    }
    if (raw.includes('insufficient funds')) {
      return createDfrError('DFR_INSUFFICIENT_FUNDS', {
        requestId: requestId as never,
        message: `余额不足以支付费用（${method}）`,
        provider: this.id,
        chain: this.chain,
        chainError,
      });
    }
    if (raw.includes('execution reverted')) {
      return createDfrError('DFR_TRANSACTION_REVERTED', {
        requestId: requestId as never,
        message: `执行回滚（${method}）`,
        provider: this.id,
        chain: this.chain,
        chainError,
      });
    }
    // 分类不确定时降级，不猜测（error-spec 第 5.2 章第 2 条）。
    return createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId: requestId as never,
      message: `Provider ${this.id} 返回 JSON-RPC 错误`,
      provider: this.id,
      chain: this.chain,
      chainError,
    });
  }
}
