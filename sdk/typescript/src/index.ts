/**
 * @dfr/sdk-typescript —— DFR TypeScript SDK（DFR-010，M0 只读 + M1-B 写路径）。
 *
 * 目标开发者体验（需求第 9 章）：换链只改 `chain` 字段，
 * 调用方不需要了解 RPC、重试、失败切换或各家 Provider 的差异。
 *
 * 安全：API Key 只作为请求头发送，不进入日志、错误或 URL。
 */
import type {
  Balance,
  Block,
  BuildTransactionResponse,
  BroadcastTransactionRequest,
  BroadcastTransactionResponse,
  Chain,
  ChainId,
  ChainInfo,
  ConfirmTransactionRequest,
  ConfirmTransactionResponse,
  Receipt,
  Account,
  ChainLog,
  ChainEvent,
  EventFilter,
  AbandonTransactionResponse,
  PreflightTransactionResponse,
  SimulateTransactionRequest,
  SimulateTransactionResponse,
  Transaction,
  TransactionRequest,
} from '@dfr/types';

export interface DfrClientOptions {
  apiKey: string;
  /** 默认 http://localhost:8787。 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 与 docs/architecture/error-spec-v0.1.md 对应的客户端错误。 */
export class DfrApiError extends Error {
  override readonly name = 'DfrApiError';
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  readonly chainError?: { code?: string; message?: string };

  constructor(init: {
    code: string;
    message: string;
    status: number;
    retryable: boolean;
    safeToRetry: boolean;
    requestId: string;
    details?: Record<string, unknown>;
    chainError?: { code?: string; message?: string };
  }) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable;
    this.safeToRetry = init.safeToRetry;
    this.requestId = init.requestId;
    if (init.details !== undefined) this.details = init.details;
    if (init.chainError !== undefined) this.chainError = init.chainError;
  }
}

export function isDfrApiError(value: unknown): value is DfrApiError {
  return value instanceof DfrApiError;
}

export interface GetBalanceParams {
  chain: ChainId | string;
  account: string;
  assetId?: string;
  consistency?: 'best-effort' | 'at-block' | 'finalized';
  /** 带标签语法，例如 `tag:finalized` / `number:123` / `hash:0x…`。 */
  blockRef?: string;
}

export interface GetBlockParams {
  chain: ChainId | string;
  blockRef: string;
}

export interface GetTransactionParams {
  chain: ChainId | string;
  txHash: string;
  includeReceipt?: boolean;
}

export interface WriteCallOptions {
  /**
   * 显式幂等键。build 不传时 SDK 自动生成（m1-api-contract 第 2 节）。
   *
   * **重试必须复用同一个键**：SDK 每次调用都会生成新键，因此"超时后重新调用
   * `buildTransaction`"不是重试同一个操作。
   */
  idempotencyKey?: string;
  /** 调用方取消信号。取消会把调用方的 abort 原因原样抛出，不包装成 `DfrApiError`。 */
  signal?: AbortSignal;
}

export interface ConfirmTransactionParams extends ConfirmTransactionRequest {
  txHash: string;
}

/**
 * 生成与 `@dfr/errors` 的 `newRequestId()` 同格式的 `req_<ULID>`。
 *
 * 为什么 SDK 自己生成：SDK 只允许依赖 `@dfr/types`（浏览器可用，不能引入
 * `node:crypto`）。格式一致性由 `sdk/typescript/test/write.test.ts` 用
 * `isValidRequestId` 断言，避免两份实现漂移。
 */
function newRequestId(): string {
  const encoding = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const timeChars: string[] = new Array<string>(10);
  let remaining = Date.now();
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = encoding[remaining % 32] as string;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let random = 0n;
  for (const byte of bytes) random = (random << 8n) | BigInt(byte);
  const randomChars: string[] = new Array<string>(16);
  for (let i = 15; i >= 0; i -= 1) {
    randomChars[i] = encoding[Number(random & 31n)] as string;
    random >>= 5n;
  }
  return `req_${timeChars.join('')}${randomChars.join('')}`;
}

export class DFR {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DfrClientOptions) {
    if (options.apiKey === undefined || options.apiKey === '') {
      throw new TypeError('DFR: apiKey is required');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'http://localhost:8787').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async listChains(): Promise<readonly Chain[]> {
    const body = await this.get<{ items: readonly Chain[]; requestId: string }>('/v1/chains');
    return body.items;
  }

  async getChain(chainId: string): Promise<ChainInfo & { requestId: string }> {
    return this.get<ChainInfo & { requestId: string }>(`/v1/chains/${encodeURIComponent(chainId)}`);
  }

  async getBalance(params: GetBalanceParams): Promise<Balance> {
    const query = new URLSearchParams({ chain: String(params.chain), account: params.account });
    if (params.assetId !== undefined) query.set('assetId', params.assetId);
    if (params.consistency !== undefined) query.set('consistency', params.consistency);
    if (params.blockRef !== undefined) query.set('blockRef', params.blockRef);
    const body = await this.get<{ balance: Balance }>(`/v1/balances?${query.toString()}`);
    return body.balance;
  }

  async getBlock(params: GetBlockParams): Promise<Block> {
    const query = new URLSearchParams({ chain: String(params.chain) });
    const body = await this.get<{ block: Block }>(
      `/v1/blocks/${encodeURIComponent(params.blockRef)}?${query.toString()}`,
    );
    return body.block;
  }

  async getTransaction(params: GetTransactionParams): Promise<Transaction> {
    const query = new URLSearchParams({ chain: String(params.chain) });
    if (params.includeReceipt === true) query.set('includeReceipt', 'true');
    const body = await this.get<{ transaction: Transaction }>(
      `/v1/transactions/${encodeURIComponent(params.txHash)}?${query.toString()}`,
    );
    return body.transaction;
  }

  async getReceipt(params: GetTransactionParams): Promise<Receipt | null> {
    const query = new URLSearchParams({ chain: String(params.chain), includeReceipt: 'true' });
    const body = await this.get<{ receipt?: Receipt }>(
      `/v1/transactions/${encodeURIComponent(params.txHash)}?${query.toString()}`,
    );
    return body.receipt ?? null;
  }

  /* ------------------------------ 写路径 ------------------------------ */

  /**
   * 构造未签名交易（`POST /v1/transactions/build`，DFR-M1-B09）。
   *
   * 与 Gateway 契约一致（m1-api-contract 第 1/2 节）：
   * - 幂等键默认由 SDK 生成（8–128 字符），显式传入时以调用方为准；
   * - 只构造，不签名、不广播；
   * - 返回命名封套（含 `transactionId` 与 `requestId`），不返回裸领域对象。
   */
  async buildTransaction(
    request: TransactionRequest,
    options: WriteCallOptions = {},
  ): Promise<BuildTransactionResponse> {
    const idempotencyKey =
      options.idempotencyKey === undefined
        ? generateIdempotencyKey()
        : assertIdempotencyKey(options.idempotencyKey, 'buildTransaction');
    return this.request<BuildTransactionResponse>('POST', '/v1/transactions/build', {
      body: request,
      idempotencyKey,
      // 超时后"再调一次 buildTransaction"会生成新键 → 不是同一个操作，故不宣称可安全重试。
      safeToRetryOnTimeout: false,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * 作废一笔**未广播**的交易（`POST /v1/transactions/{id}/abandon`，ADR-037 方案 A）。
   *
   * `build` 会立即占用一个链上 nonce；决定不提交时必须显式作废，否则该 nonce
   * 永久占位、链上形成永久空洞。仅 `built` / `simulated` 可作废；幂等（重复调用返回 200）。
   */
  async abandonTransaction(
    transactionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AbandonTransactionResponse> {
    return this.request<AbandonTransactionResponse>(
      'POST',
      `/v1/transactions/${encodeURIComponent(transactionId)}/abandon`,
      {
        body: {},
        // 幂等：重复作废同一笔交易是安全的。
        safeToRetryOnTimeout: true,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
  }

  /**
   * 只读预检（`POST /v1/transactions/preflight`，ADR-037 方案 B）。
   *
   * **不占 nonce、不落库、不写幂等表**，因此可以安全地反复调用。
   * 用它回答"这笔交易大概能不能过、要多少 gas"，**不要**用 `buildTransaction` 当预检——
   * build 会占用一个链上 nonce，反复调用会在链上留下永久空洞（ADR-037 的实测成因）。
   *
   * 回滚**不会抛错**：以 `simulation.success === false` 返回（200）。
   * 返回的 `unsignedTransaction` 仅供预览，**不可用于签名与广播**。
   */
  async preflightTransaction(
    request: TransactionRequest,
    options: WriteCallOptions = {},
  ): Promise<PreflightTransactionResponse> {
    const idempotencyKey =
      options.idempotencyKey === undefined
        ? generateIdempotencyKey()
        : assertIdempotencyKey(options.idempotencyKey, 'preflightTransaction');
    return this.request<PreflightTransactionResponse>('POST', '/v1/transactions/preflight', {
      body: request,
      idempotencyKey,
      // 只读且无副作用，超时后重试是安全的。
      safeToRetryOnTimeout: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * 模拟交易（`POST /v1/transactions/simulate`，DFR-M1-B09）。
   *
   * 必须携带 build 返回的 `transactionId` 与 `UnsignedTransaction`：服务端据此
   * 定位记录并做逐字节绑定校验。模拟是只读的，允许重复调用。
   */
  async simulateTransaction(
    params: SimulateTransactionRequest,
    options: WriteCallOptions = {},
  ): Promise<SimulateTransactionResponse> {
    return this.request<SimulateTransactionResponse>('POST', '/v1/transactions/simulate', {
      body: params,
      // simulate 无副作用且以 transactionId 定位，重试安全。
      safeToRetryOnTimeout: true,
      ...(options.idempotencyKey !== undefined
        ? { idempotencyKey: assertIdempotencyKey(options.idempotencyKey, 'simulateTransaction') }
        : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  async broadcastTransaction(
    request: BroadcastTransactionRequest,
    options: WriteCallOptions & { rebroadcast?: boolean } = {},
  ): Promise<BroadcastTransactionResponse> {
    if (options.idempotencyKey === undefined) {
      throw new TypeError('DFR: broadcastTransaction requires an explicit Idempotency-Key');
    }
    const broadcastKey = assertIdempotencyKey(options.idempotencyKey, 'broadcastTransaction');
    return this.request<BroadcastTransactionResponse>('POST', '/v1/transactions/broadcast', {
      body: { ...request, ...(options.rebroadcast === true ? { rebroadcast: true } : {}) },
      idempotencyKey: broadcastKey,
      safeToRetryOnTimeout: false,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /** 等待指定最终性；Gateway 等待超时返回 reached=false，服务端后台继续只读跟踪。 */
  async confirmTransaction(
    params: ConfirmTransactionParams,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConfirmTransactionResponse> {
    const { txHash, ...body } = params;
    const serverWaitMs = params.timeoutMs ?? 60_000;
    return this.request<ConfirmTransactionResponse>(
      'POST',
      `/v1/transactions/${encodeURIComponent(txHash)}/confirm`,
      {
        body,
        timeoutMs: Math.max(this.timeoutMs, serverWaitMs + 5_000),
        safeToRetryOnTimeout: true,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
  }

  /**
   * 按区块区间查询事件日志（ADR-034，`POST /v1/logs`）。
   *
   * `fromBlock`/`toBlock` 必须是十进制区块号字符串；跨度超限由服务端 400 拒绝。
   */
  async getLogs(params: {
    chain: string;
    fromBlock: string;
    toBlock: string;
    address?: string;
    topics?: readonly (string | readonly string[] | null)[];
    limit?: number;
  }): Promise<readonly ChainLog[]> {
    const { chain, ...body } = params;
    const result = await this.request<{ logs: readonly ChainLog[] }>(
      'POST',
      `/v1/logs?chain=${encodeURIComponent(chain)}`,
      { body, safeToRetryOnTimeout: true },
    );
    return result.logs;
  }

  /**
   * 只读合约调用（ADR-035）。`data` 与 `abi+method` 二选一。
   */
  async readContract(params: {
    chain: string;
    contract: string;
    data?: string;
    abi?: readonly (string | Record<string, unknown>)[];
    method?: string;
    args?: readonly unknown[];
  }): Promise<{ data: string; decoded?: unknown }> {
    const { chain, ...body } = params;
    const result = await this.request<{ result: { data: string; decoded?: unknown } }>(
      'POST',
      `/v1/contracts/read?chain=${encodeURIComponent(chain)}`,
      { body, safeToRetryOnTimeout: true },
    );
    return result.result;
  }

  /** 账户存在性 / 合约判定（ADR-036）。 */
  async getAccount(params: { chain: string; address: string }): Promise<Account> {
    const result = await this.get<{ account: Account }>(
      `/v1/accounts/${encodeURIComponent(params.address)}?chain=${encodeURIComponent(params.chain)}`,
    );
    return result.account;
  }

  /* ------------------------------ 事件 ------------------------------ */

  /**
   * 签发一次性 SSE 票据（ADR-029）。
   *
   * 浏览器原生 `EventSource` 无法设置自定义 header，因此用短时票据做 SSE 鉴权。
   * 票据绑定签发时的 apiKeyId / 客户端 IP / filter 摘要：不能扩大订阅范围。
   * TTL 默认 30s、上限 60s（超过由服务端拒绝）。
   */
  async createEventTicket(
    params: { filter: EventFilter; ttlMs?: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ ticket: string; expiresAt: string; requestId: string }> {
    return this.request('POST', '/v1/events/tickets', {
      body: {
        filter: params.filter,
        ...(params.ttlMs !== undefined ? { ttlMs: params.ttlMs } : {}),
      },
      safeToRetryOnTimeout: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * 订阅事件流（SSE）。
   *
   * 服务端/桌面客户端用 `X-DFR-Key` header；浏览器先 `createEventTicket` 再用
   * `subscribeEventsWithTicket`。返回一个 `AsyncIterable<ChainEvent>`：调用方
   * `for await` 消费，或对返回的 `controller` 调 `abort()` 关闭连接。
   *
   * 投递是 at-least-once：消费端必须按 `eventId` 去重。M0/M1 的 cursor 仅在进程内有效。
   */
  subscribeEvents(
    filter: EventFilter = {},
    options: { signal?: AbortSignal } = {},
  ): { events: AsyncIterable<ChainEvent>; close: () => void } {
    return this.openStream(filter, undefined, options);
  }

  /**
   * 用一次性票据订阅（浏览器路径）。
   *
   * **必须**传入与签发时**相同**的 filter：服务端会用 query 构造的 filter 摘要与票据
   * 绑定的摘要比对（`SseTicketStore.consume`）——摘要不符一律 `DFR_INVALID_TICKET`。
   * 这正是"票据不能扩大订阅范围"的机制：票据只放行签发时那一组过滤条件。
   */
  subscribeEventsWithTicket(
    ticket: string,
    filter: EventFilter = {},
    options: { signal?: AbortSignal } = {},
  ): { events: AsyncIterable<ChainEvent>; close: () => void } {
    return this.openStream(filter, ticket, options);
  }

  private openStream(
    filter: EventFilter,
    ticket: string | undefined,
    options: { signal?: AbortSignal },
  ): { events: AsyncIterable<ChainEvent>; close: () => void } {
    const query = new URLSearchParams();
    if (filter.chain !== undefined) query.set('chain', String(filter.chain));
    if (filter.types !== undefined && filter.types.length > 0) {
      query.set('types', filter.types.join(','));
    }
    if (filter.afterCursor !== undefined) query.set('afterCursor', String(filter.afterCursor));
    if (ticket !== undefined) query.set('ticket', ticket);
    const path = `/v1/events/subscribe${query.toString() !== '' ? `?${query.toString()}` : ''}`;

    const controller = new AbortController();
    const signal =
      options.signal !== undefined
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;

    const headers: Record<string, string> = { accept: 'text/event-stream' };
    // 票据路径不带 Key（票据本身就是凭据）；header 路径带 Key。
    if (ticket === undefined) headers['x-dfr-key'] = this.apiKey;

    const events: AsyncIterable<ChainEvent> = {
      [Symbol.asyncIterator]: (): AsyncIterator<ChainEvent> =>
        this.streamIterator(path, headers, signal),
    };
    return { events, close: () => controller.abort() };
  }

  /** 读取 SSE 帧并逐条解析为 `ChainEvent`；心跳（注释行）被跳过。 */
  private async *streamIterator(
    path: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): AsyncGenerator<ChainEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET', headers, signal });
    } catch {
      if (signal.aborted) return;
      throw new DfrApiError({
        code: 'DFR_PROVIDER_UNAVAILABLE',
        message: 'DFR 事件流连接失败',
        status: 503,
        retryable: true,
        safeToRetry: true,
        requestId: newRequestId(),
      });
    }
    if (!response.ok || response.body === null) {
      // 非 2xx：复用统一的错误解析（票据无效 → DFR_INVALID_TICKET 等）。
      const text = await response.text().catch(() => '');
      throw new DfrApiError(await this.parseStreamError(response, text));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        // SSE 帧以空行分隔。
        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const event = parseSseFrame(frame);
          if (event !== undefined) yield event;
          separator = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /** 把非 2xx 的流式响应归一化为 SDK 错误（不泄漏 Key/端点）。 */
  private async parseStreamError(response: Response, text: string): Promise<{
    code: string; message: string; status: number; retryable: boolean; safeToRetry: boolean; requestId: string;
  }> {
    const requestId = response.headers.get('x-request-id') ?? newRequestId();
    try {
      // 与 `request()` 一致：使用服务端的 RFC 9457 + DFR 扩展（snake_case）封套。
      const problem = JSON.parse(text) as {
        dfr_code?: string;
        detail?: string;
        retryable?: boolean;
        safe_to_retry?: boolean;
        request_id?: string;
      };
      return {
        code: problem.dfr_code ?? 'DFR_INTERNAL_ERROR',
        message: problem.detail ?? 'DFR 事件流被拒绝',
        status: response.status,
        retryable: problem.retryable ?? false,
        safeToRetry: problem.safe_to_retry ?? false,
        requestId: problem.request_id ?? requestId,
      };
    } catch {
      return {
        code: 'DFR_INTERNAL_ERROR',
        message: 'DFR 事件流被拒绝',
        status: response.status,
        retryable: false,
        safeToRetry: false,
        requestId,
      };
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, { safeToRetryOnTimeout: true });
  }

  /**
   * 统一的 HTTP 出口。三条不能省的语义：
   *
   * 1. **取消 ≠ 失败**：调用方 signal 触发时原样抛出调用方的 abort 原因；
   * 2. **超时** → `DFR_PROVIDER_TIMEOUT`(504)，并且 SDK 已经发送 `X-Request-Id`，
   *    因此超时也能给出可关联的 requestId（Gateway 会回写同一个值）；
   * 3. **传输失败** → `DFR_PROVIDER_UNAVAILABLE`(503)，错误信息只带 method+path，
   *    不带 baseUrl（端点可能敏感），更不带 Key。
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      safeToRetryOnTimeout: boolean;
    },
  ): Promise<T> {
    // 只为错误关联生成；不进入 URL、日志。
    const requestId = newRequestId();
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new Error('sdk-timeout')),
      options.timeoutMs ?? this.timeoutMs,
    );
    const signal =
      options.signal !== undefined
        ? AbortSignal.any([timeoutController.signal, options.signal])
        : timeoutController.signal;

    const headers: Record<string, string> = {
      // Key 只出现在请求头；不进入 URL、日志或错误。
      'x-dfr-key': this.apiKey,
      accept: 'application/json',
      'x-request-id': requestId,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey !== undefined) {
      headers['idempotency-key'] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
      });
    } catch (err) {
      if (options.signal?.aborted === true) {
        throw options.signal.reason ?? err;
      }
      if (timeoutController.signal.aborted) {
        throw new DfrApiError({
          code: 'DFR_PROVIDER_TIMEOUT',
          message: `DFR 请求超时（${method} ${path}，${options.timeoutMs ?? this.timeoutMs}ms）`,
          status: 504,
          retryable: true,
          safeToRetry: options.safeToRetryOnTimeout,
          requestId,
        });
      }
      throw new DfrApiError({
        code: 'DFR_PROVIDER_UNAVAILABLE',
        message: `无法连接 DFR Gateway（${method} ${path}）`,
        status: 503,
        retryable: true,
        safeToRetry: options.safeToRetryOnTimeout,
        requestId,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = {};
    let parsable = true;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        // body 不是 JSON：错误路径降级为通用错误；成功路径视为响应损坏。
        parsable = false;
      }
    }

    if (!response.ok) {
      const problem = (parsable ? parsed : {}) as {
        dfr_code?: string;
        detail?: string;
        status?: number;
        retryable?: boolean;
        safe_to_retry?: boolean;
        request_id?: string;
        details?: Record<string, unknown>;
        chain_error?: { code?: string; message?: string };
      };
      throw new DfrApiError({
        code: problem.dfr_code ?? 'DFR_INTERNAL_ERROR',
        message: problem.detail ?? `DFR request failed with HTTP ${response.status}`,
        status: problem.status ?? response.status,
        retryable: problem.retryable ?? false,
        safeToRetry: problem.safe_to_retry ?? false,
        requestId: problem.request_id ?? (response.headers.get('x-request-id') ?? requestId),
        ...(problem.details !== undefined ? { details: problem.details } : {}),
        ...(problem.chain_error !== undefined ? { chainError: problem.chain_error } : {}),
      });
    }

    if (!parsable) {
      throw new DfrApiError({
        code: 'DFR_PROVIDER_INVALID_RESPONSE',
        message: `DFR 返回了非 JSON 响应（${method} ${path}，HTTP ${response.status}）`,
        status: 502,
        retryable: true,
        safeToRetry: options.safeToRetryOnTimeout,
        requestId: response.headers.get('x-request-id') ?? requestId,
      });
    }

    return parsed as T;
  }

  /** 供调用方在日志中安全标识实例：不含 Key 本体。 */
  describe(): string {
    return `DFR(baseUrl=${this.baseUrl})`;
  }
}

/**
 * 幂等键：`crypto.randomUUID()` 是 36 字符，落在 OpenAPI 的 8–128 区间内。
 * 不写入日志；只作为请求头发送。
 */
function generateIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * `Idempotency-Key` 长度契约（与 OpenAPI `IdempotencyKey` / `IdempotencyKeyOptional`
 * 及 Gateway 强制值一致；见 TODO-007）。
 *
 * 为什么 SDK 也要校验：调用方传了非法键时，本地抛 `TypeError` 比等服务端 400 更清晰，
 * 也避免把网络往返浪费在一个必然被拒的请求上。两者边界相同，因此不会出现
 * "SDK 放行但服务端拒绝"或反之的分歧。
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

function assertIdempotencyKey(value: string, method: string): string {
  if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new TypeError(
      `DFR: ${method} requires an Idempotency-Key of length ` +
        `${IDEMPOTENCY_KEY_MIN_LENGTH}..${IDEMPOTENCY_KEY_MAX_LENGTH} (got ${value.length})`,
    );
  }
  return value;
}

export type {
  Balance,
  Block,
  BuildTransactionResponse,
  BroadcastTransactionRequest,
  BroadcastTransactionResponse,
  Chain,
  ChainId,
  ChainInfo,
  Receipt,
  SimulateTransactionRequest,
  SimulateTransactionResponse,
  Transaction,
  TransactionRequest,
  UnsignedTransaction,
} from '@dfr/types';

/**
 * 解析单个 SSE 帧（`data:` 行拼接；注释行/心跳忽略；只取 `data`）。
 *
 * 与 ADR-029 的事件线协议一致：Gateway 用 `data: <json>` 发送 `ChainEvent`。
 * 返回 `undefined` 表示该帧不含数据（心跳或纯注释）。
 */
function parseSseFrame(frame: string): ChainEvent | undefined {
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '' || line.startsWith(':')) continue; // 注释/心跳
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /u, ''));
    }
  }
  if (dataLines.length === 0) return undefined;
  try {
    return JSON.parse(dataLines.join('\n')) as ChainEvent;
  } catch {
    return undefined;
  }
}
