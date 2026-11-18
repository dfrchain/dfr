/**
 * JSON-RPC over HTTP transport implementation (see docs/architecture/provider-spec-v0.1.md, chapter 2).
 *
 * Boundary: the Provider only handles transport and error normalization; it does **not** understand chain semantics.
 * `method` / `params` are constructed by the Adapter; the Provider forwards them verbatim.
 *
 * Security: endpoint and credential live only in instance private fields, never entering logs or errors.
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

/** The canonical transport interface (provider-spec chapter 2). */
export interface Provider {
  readonly id: ProviderId;
  readonly chain: ChainId;
  readonly network: NetworkId;
  readonly kind: ProviderKind;
  readonly descriptor: ProviderDescriptor;
  request<T>(call: TransportCall, ctx: TransportContext): Promise<T>;
  health(): Promise<ProviderHealth>;
  /** The low-weight probe method name, e.g. EVM's eth_chainId. */
  readonly probeMethod: string;
  /** Health snapshot for scoring (recorded automatically by request(); no external reporting needed). */
  healthSnapshot(now: number): ProviderHealth;
  /** Whether the probe needs to run (single-flight + interval control is the Manager's job). */
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

/** Method categories derived from idempotency for circuit breaker / metrics. */
export function methodClassOf(idempotency: TransportCall['idempotency']): MethodClass {
  return idempotency === 'safe-read' ? 'read' : 'write';
}

export interface JsonRpcProviderOptions {
  descriptor: ProviderDescriptor;
  endpoint: string;
  credential?: string | undefined;
  /** Inject fetch so tests and sandbox environments can replace it. */
  fetchImpl?: typeof fetch;
  /** Probe method; EVM default eth_chainId. */
  probeMethod?: string;
  /** Credential injection method; default Authorization: Bearer. */
  credentialHeader?: (credential: string) => Record<string, string>;
  /**
   * Monotonic clock; default Date.now().
   *
   * Must be injectable: the health window, scoring, and health-check scheduling all run on the same clock;
   * if this secretly used Date.now() while scheduling used the injected clock, their timelines would drift apart.
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
          message: `Provider ${this.id} returned a non-JSON response`,
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
          message: `Provider ${this.id} response is missing result`,
          provider: this.id,
          chain: this.chain,
        });
      }
      this.tracker.recordSuccess(this.now() - started, this.now());
      return parsed.result;
    } catch (err) {
      // An already-normalized error is rethrown directly to avoid double classification.
      if (isDfrError(err)) throw err;

      const abortedByUs = controller.signal.aborted;
      const elapsed = this.now() - started;
      const timedOut = abortedByUs && elapsed >= timeoutMs - 5;
      const code = timedOut ? 'DFR_PROVIDER_TIMEOUT' : 'DFR_PROVIDER_UNAVAILABLE';
      this.tracker.recordFailure(this.now());
      throw createDfrError(code, {
        requestId: ctx.requestId as never,
        message: timedOut
          ? `Provider ${this.id} timed out after ${timeoutMs}ms`
          : `Provider ${this.id} connection failed`,
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
        message: `Provider ${this.id} triggered upstream rate limiting`,
        provider: this.id,
        chain: this.chain,
        details: { status, method },
      });
    }
    if (status >= 500) {
      return createDfrError('DFR_PROVIDER_UNAVAILABLE', {
        requestId: requestId as never,
        message: `Provider ${this.id} returned HTTP ${status}`,
        provider: this.id,
        chain: this.chain,
        details: { status, method },
      });
    }
    return createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
      requestId: requestId as never,
      message: `Provider ${this.id} returned HTTP ${status}`,
      provider: this.id,
      chain: this.chain,
      details: { status, method },
    });
  }

  /**
   * JSON-RPC error -> DFR error (error-spec section 5.1 mapping table).
   *
   * Note: the raw message is never used directly as the message; it only goes into the redacted chainError.
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
        message: `nonce conflict (${method})`,
        provider: this.id,
        chain: this.chain,
        chainError,
      });
    }
    if (raw.includes('insufficient funds')) {
      return createDfrError('DFR_INSUFFICIENT_FUNDS', {
        requestId: requestId as never,
        message: `insufficient balance to pay the fee (${method})`,
        provider: this.id,
        chain: this.chain,
        chainError,
      });
    }
    if (raw.includes('execution reverted')) {
      return createDfrError('DFR_TRANSACTION_REVERTED', {
        requestId: requestId as never,
        message: `execution reverted (${method})`,
        provider: this.id,
        chain: this.chain,
        chainError,
      });
    }
    // On uncertain classification, degrade rather than guess (error-spec section 5.2, rule 2).
    return createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId: requestId as never,
      message: `Provider ${this.id} returned a JSON-RPC error`,
      provider: this.id,
      chain: this.chain,
      chainError,
    });
  }
}
