/**
 * @dfr/sdk-typescript — DFR TypeScript SDK (DFR-010, M0 read-only + M1-B write path).
 *
 * Target developer experience (requirements Chapter 9): switching chains only changes the `chain` field,
 * and callers need not know about RPC, retries, failover, or the differences between Providers.
 *
 * Security: the API Key is only sent as a request header; it never enters logs, errors, or URLs.
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
  LogsPageResponse,
  Transaction,
  TransactionRequest,
  UsageResponse,
} from '@dfr/types';

export interface DfrClientOptions {
  apiKey: string;
  /** Defaults to http://localhost:8787. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Opt-in retry policy. When omitted the SDK makes exactly one attempt (no behavior change
   * for existing callers). Retries only happen for errors the server marks both `retryable`
   * and `safe_to_retry`; `build`/`broadcast` are never retried because the server marks them unsafe.
   */
  retry?: RetryPolicy;
}

export interface RetryPolicy {
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Exponential backoff base in ms. Default 250. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 5000. */
  maxDelayMs?: number;
  /** Add up to `baseDelayMs` of random jitter. Default true. */
  jitter?: boolean;
  /**
   * Extra predicate, called after the built-in `retryable && safe_to_retry` check.
   * Return false to stop retrying (e.g. to exclude 429 on a latency-sensitive path).
   */
  retryOn?: (error: DfrApiError, completedAttempts: number, method: 'GET' | 'POST') => boolean;
  /** Injectable delay, for deterministic tests/embedders. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Client-side error matching docs/architecture/error-spec-v0.1.md. */
export class DfrApiError extends Error {
  override readonly name = 'DfrApiError';
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly requestId: string;
  readonly details?: Record<string, unknown>;
  readonly chainError?: { code?: string; message?: string };
  /** Server `Retry-After`, in ms, when present (used by the retry policy instead of backoff). */
  readonly retryAfterMs?: number;
  /** Number of attempts the SDK made for this logical operation (1 when not retried). */
  readonly attempts?: number;

  constructor(init: {
    code: string;
    message: string;
    status: number;
    retryable: boolean;
    safeToRetry: boolean;
    requestId: string;
    details?: Record<string, unknown>;
    chainError?: { code?: string; message?: string };
    retryAfterMs?: number;
    attempts?: number;
  }) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable;
    this.safeToRetry = init.safeToRetry;
    this.requestId = init.requestId;
    if (init.details !== undefined) this.details = init.details;
    if (init.chainError !== undefined) this.chainError = init.chainError;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.attempts !== undefined) this.attempts = init.attempts;
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
  /** Tagged syntax, e.g. `tag:finalized` / `number:123` / `hash:0x…`. */
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
   * Explicit idempotency key. When build is called without one, the SDK generates it (m1-api-contract Section 2).
   *
   * **Retries must reuse the same key**: the SDK generates a new key on every call, so "calling
   * `buildTransaction` again after a timeout" is not retrying the same operation.
   */
  idempotencyKey?: string;
  /** Caller cancellation signal. Cancellation rethrows the caller's abort reason as-is, without wrapping it in a `DfrApiError`. */
  signal?: AbortSignal;
}

export interface ConfirmTransactionParams extends ConfirmTransactionRequest {
  txHash: string;
}

export interface GetLogsPagedParams {
  chain: string;
  /** Decimal block-number string. */
  fromBlock: string;
  /** Decimal block-number string. */
  toBlock: string;
  address?: string;
  topics?: readonly (string | readonly string[] | null)[];
  /** Blocks per request; default 2000 (the EVM adapter's default `maxBlockRange`). */
  windowBlocks?: number;
}

export interface GetLogsPageParams {
  chain: string;
  /** First-page form; required unless `cursor` is set. */
  fromBlock?: string;
  toBlock?: string;
  address?: string;
  topics?: readonly (string | readonly string[] | null)[];
  /** Page size. */
  limit?: number;
  /** Continuation from a previous `hasMore: true` response. */
  cursor?: string;
}

export interface GetLogsPagedResult {
  logs: readonly ChainLog[];
  /** Number of HTTP requests made. */
  pages: number;
}

/**
 * Generate a `req_<ULID>` in the same format as `@dfr/errors`' `newRequestId()`.
 *
 * Why the SDK generates it itself: the SDK may only depend on `@dfr/types` (browser-safe; it cannot import
 * `node:crypto`). Format consistency is asserted by `sdk/typescript/test/write.test.ts` using
 * `isValidRequestId`, so the two implementations do not drift.
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
  private readonly retry: Required<Omit<RetryPolicy, 'retryOn'>> & Pick<RetryPolicy, 'retryOn'> | undefined;

  constructor(options: DfrClientOptions) {
    if (options.apiKey === undefined || options.apiKey === '') {
      throw new TypeError('DFR: apiKey is required');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'http://localhost:8787').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retry = options.retry === undefined ? undefined : resolveRetryPolicy(options.retry);
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

  /* ------------------------------ Write path ------------------------------ */

  /**
   * Build an unsigned transaction (`POST /v1/transactions/build`, DFR-M1-B09).
   *
   * Consistent with the Gateway contract (m1-api-contract Sections 1/2):
   * - The idempotency key is generated by the SDK by default (8–128 characters); an explicitly passed key wins;
   * - Construct only; no signing, no broadcast;
   * - Return the named envelope (with `transactionId` and `requestId`), never a bare domain object.
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
      // Calling buildTransaction "once more" after a timeout generates a new key → not the same operation, so it is not claimed to be safely retryable.
      safeToRetryOnTimeout: false,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * Abandon an **unbroadcast** transaction (`POST /v1/transactions/{id}/abandon`, ADR-037 option A).
   *
   * `build` immediately occupies an on-chain nonce; when deciding not to submit, it must be explicitly abandoned, otherwise that nonce
   * is permanently occupied, leaving a permanent gap on-chain. Only `built` / `simulated` can be abandoned; idempotent (repeat calls return 200).
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
        // Idempotent: abandoning the same transaction repeatedly is safe.
        safeToRetryOnTimeout: true,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
  }

  /**
   * Read-only preflight (`POST /v1/transactions/preflight`, ADR-037 option B).
   *
   * **No nonce occupied, nothing persisted, no idempotency table written**, so it is safe to call repeatedly.
   * Use it to answer "can this transaction probably pass, and how much gas will it need?"; do **not** use `buildTransaction` as a preflight —
   * build occupies an on-chain nonce, and repeated calls leave permanent gaps on-chain (the measured cause behind ADR-037).
   *
   * A revert **does not throw**: it returns with `simulation.success === false` (200).
   * The returned `unsignedTransaction` is for preview only; it **must not be used for signing or broadcast**.
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
      // Read-only with no side effects; retrying after a timeout is safe.
      safeToRetryOnTimeout: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * Simulate a transaction (`POST /v1/transactions/simulate`, DFR-M1-B09).
   *
   * Must carry the `transactionId` and `UnsignedTransaction` returned by build: the server uses them to
   * locate the record and run the byte-for-byte binding check. Simulation is read-only and may be called repeatedly.
   */
  async simulateTransaction(
    params: SimulateTransactionRequest,
    options: WriteCallOptions = {},
  ): Promise<SimulateTransactionResponse> {
    return this.request<SimulateTransactionResponse>('POST', '/v1/transactions/simulate', {
      body: params,
      // simulate has no side effects and is located by transactionId, so retrying is safe.
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

  /** Wait for the specified finality; when the Gateway wait times out it returns reached=false, and the server keeps tracking read-only in the background. */
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
   * Query event logs by block range (ADR-034, `POST /v1/logs`).
   *
   * `fromBlock`/`toBlock` must be decimal block-number strings; an over-limit span is rejected by the server with 400.
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
   * One page of logs with an opaque continuation (`POST /v1/logs`, cursor pagination).
   *
   * The cursor carries the pinned range and filters, so a resume request sends **only**
   * `{ chain, cursor, limit? }`. Mixing a cursor with `fromBlock`/`toBlock` is rejected locally
   * (the server rejects it too) because guessing which side wins causes reconciliation bugs.
   *
   * Unlike `getLogs`, `limit` here is a real page size: `hasMore` and `nextCursor` describe
   * exactly what was returned, including when a single block holds more logs than one page.
   */
  async getLogsPage(params: GetLogsPageParams): Promise<LogsPageResponse> {
    const { chain, ...body } = params;
    if (body.cursor !== undefined) {
      if (body.fromBlock !== undefined || body.toBlock !== undefined) {
        throw new TypeError('DFR: getLogsPage cursor cannot be combined with fromBlock/toBlock');
      }
    } else {
      if (body.fromBlock === undefined || body.toBlock === undefined) {
        throw new TypeError('DFR: getLogsPage requires either cursor or fromBlock + toBlock');
      }
      if (!/^[0-9]+$/u.test(body.fromBlock) || !/^[0-9]+$/u.test(body.toBlock)) {
        throw new TypeError('DFR: getLogsPage block numbers must be decimal strings');
      }
    }
    if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || body.limit < 1)) {
      throw new TypeError('DFR: getLogsPage limit must be a positive safe integer');
    }
    return this.request<LogsPageResponse>(
      'POST',
      `/v1/logs?chain=${encodeURIComponent(chain)}`,
      { body, safeToRetryOnTimeout: true },
    );
  }

  /**
   * Query logs across a wide block range by splitting it into adapter-safe windows
   * (`getLogsPaged`, developer-product task 03).
   *
   * Why this exists: the HTTP API has no opaque-cursor pagination for logs, and the Gateway
   * rejects a range wider than the chain's `maxBlockRange`. This helper keeps every request
   * inside `windowBlocks` (default 2000, the EVM adapter default), concatenating the disjoint
   * results. It deliberately does not pass `limit`, so a window is never silently truncated.
   * If a single window still contains more logs than the server returns, treat it as a gap and
   * narrow `windowBlocks`.
   */
  async getLogsPaged(params: GetLogsPagedParams): Promise<GetLogsPagedResult> {
    const from = parseBlockNumber(params.fromBlock, 'fromBlock');
    const to = parseBlockNumber(params.toBlock, 'toBlock');
    if (from > to) {
      throw new TypeError('DFR: getLogsPaged requires fromBlock <= toBlock');
    }
    const windowBlocks = params.windowBlocks ?? 2000;
    if (!Number.isSafeInteger(windowBlocks) || windowBlocks < 1) {
      throw new TypeError('DFR: getLogsPaged windowBlocks must be a positive safe integer');
    }
    const window = BigInt(windowBlocks);
    const logs: ChainLog[] = [];
    let pages = 0;
    for (let start = from; start <= to; start += window) {
      const end = start + window - 1n > to ? to : start + window - 1n;
      const page = await this.getLogs({
        chain: params.chain,
        fromBlock: start.toString(10),
        toBlock: end.toString(10),
        ...(params.address !== undefined ? { address: params.address } : {}),
        ...(params.topics !== undefined ? { topics: params.topics } : {}),
      });
      logs.push(...page);
      pages += 1;
    }
    return { logs, pages };
  }

  /**
   * Read-only contract call (ADR-035). Choose one of `data` or `abi+method`.
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

  /**
   * Per-project usage for the current Gateway process (`GET /v1/usage`, developer-product task 03).
   *
   * Returns the project's request counts by route/chain/error code plus the effective rate-limit
   * buckets and Key scope. Counts are process-local and reset on restart — this is a usage view,
   * not an invoice.
   */
  async getUsage(): Promise<UsageResponse> {
    return this.get<UsageResponse>('/v1/usage');
  }

  /** Account existence / contract determination (ADR-036). */
  async getAccount(params: { chain: string; address: string }): Promise<Account> {
    const result = await this.get<{ account: Account }>(
      `/v1/accounts/${encodeURIComponent(params.address)}?chain=${encodeURIComponent(params.chain)}`,
    );
    return result.account;
  }

  /* ------------------------------ Events ------------------------------ */

  /**
   * Issue a one-time SSE ticket (ADR-029).
   *
   * The browser-native `EventSource` cannot set custom headers, so short-lived tickets are used for SSE auth.
   * Tickets are bound to the apiKeyId / client IP / filter digest at issuance: the subscription scope cannot be widened.
   * TTL defaults to 30s, capped at 60s (exceeding it is rejected by the server).
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
   * Subscribe to the event stream (SSE).
   *
   * Server/desktop clients use the `X-DFR-Key` header; browsers first call `createEventTicket`, then use
   * `subscribeEventsWithTicket`. Returns an `AsyncIterable<ChainEvent>`: the caller
   * consumes it with `for await`, or calls `abort()` on the returned `controller` to close the connection.
   *
   * Delivery is at-least-once: consumers must deduplicate by `eventId`. M0/M1 cursors are only valid in-process.
   */
  subscribeEvents(
    filter: EventFilter = {},
    options: { signal?: AbortSignal } = {},
  ): { events: AsyncIterable<ChainEvent>; close: () => void } {
    return this.openStream(filter, undefined, options);
  }

  /**
   * Subscribe with a one-time ticket (browser path).
   *
   * **Must** pass the **same** filter as at issuance: the server compares the filter digest built from the query with the digest bound to the ticket
   * (via `SseTicketStore.consume`) — a digest mismatch always yields `DFR_INVALID_TICKET`.
   * This is exactly the "tickets cannot widen the subscription scope" mechanism: a ticket only admits the filter set from issuance.
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
    // The ticket path carries no Key (the ticket itself is the credential); the header path carries a Key.
    if (ticket === undefined) headers['x-dfr-key'] = this.apiKey;

    const events: AsyncIterable<ChainEvent> = {
      [Symbol.asyncIterator]: (): AsyncIterator<ChainEvent> =>
        this.streamIterator(path, headers, signal),
    };
    return { events, close: () => controller.abort() };
  }

  /** Read SSE frames and parse each into a `ChainEvent`; heartbeats (comment lines) are skipped. */
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
        message: 'DFR event stream connection failed',
        status: 503,
        retryable: true,
        safeToRetry: true,
        requestId: newRequestId(),
      });
    }
    if (!response.ok || response.body === null) {
      // Non-2xx: reuse the unified error parsing (invalid ticket → DFR_INVALID_TICKET, etc.).
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
        // SSE frames are separated by blank lines.
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

  /** Normalize a non-2xx streaming response into an SDK error (without leaking the Key/endpoint). */
  private async parseStreamError(response: Response, text: string): Promise<{
    code: string; message: string; status: number; retryable: boolean; safeToRetry: boolean; requestId: string;
  }> {
    const requestId = response.headers.get('x-request-id') ?? newRequestId();
    try {
      // Same as `request()`: use the server's RFC 9457 + DFR extension (snake_case) envelope.
      const problem = JSON.parse(text) as {
        dfr_code?: string;
        detail?: string;
        retryable?: boolean;
        safe_to_retry?: boolean;
        request_id?: string;
      };
      return {
        code: problem.dfr_code ?? 'DFR_INTERNAL_ERROR',
        message: problem.detail ?? 'DFR event stream was rejected',
        status: response.status,
        retryable: problem.retryable ?? false,
        safeToRetry: problem.safe_to_retry ?? false,
        requestId: problem.request_id ?? requestId,
      };
    } catch {
      return {
        code: 'DFR_INTERNAL_ERROR',
        message: 'DFR event stream was rejected',
        status: response.status,
        retryable: false,
        safeToRetry: false,
        requestId,
      };
    }
  }

  /* ------------------------------ Internals ------------------------------ */

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, { safeToRetryOnTimeout: true });
  }

  /**
   * The unified HTTP exit. Three semantics that cannot be dropped:
   *
   * 1. **Cancellation ≠ failure**: when the caller's signal fires, the caller's abort reason is rethrown as-is;
   * 2. **Timeout** → `DFR_PROVIDER_TIMEOUT`(504), and the SDK has already sent `X-Request-Id`,
   *    so timeouts can still provide a correlatable requestId (the Gateway writes back the same value);
   * 3. **Transport failure** → `DFR_PROVIDER_UNAVAILABLE`(503); the error message carries only method+path,
   *    never the baseUrl (the endpoint may be sensitive), and never the Key.
   *
   * Retry (opt-in, developer-product task 03): the same `X-Request-Id` and the same `Idempotency-Key`
   * are reused across attempts, so a retried read is still one logical operation. Retrying is only
   * possible when the server says `retryable && safe_to_retry`; a caller cancellation is never retried.
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
    // Generated only for error correlation; never enters URLs or logs; stable across retries.
    const requestId = newRequestId();
    const policy = this.retry;
    const maxRetries = policy?.maxRetries ?? 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<T>(method, path, options, requestId, attempt + 1);
      } catch (error) {
        if (policy === undefined || attempt >= maxRetries || !isDfrApiError(error)) throw error;
        if (isAborted(options.signal)) throw options.signal?.reason ?? error;
        const allowed =
          error.retryable &&
          error.safeToRetry &&
          (policy.retryOn === undefined || policy.retryOn(error, attempt + 1, method));
        if (!allowed) throw error;
        const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
        const jitter = policy.jitter ? Math.floor(Math.random() * policy.baseDelayMs) : 0;
        await policy.sleep(error.retryAfterMs ?? backoff + jitter);
        if (isAborted(options.signal)) throw options.signal?.reason;
      }
    }
  }

  /** One HTTP attempt; `attempt` is 1-based and only used for error reporting. */
  private async requestOnce<T>(
    method: 'GET' | 'POST',
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      safeToRetryOnTimeout: boolean;
    },
    requestId: string,
    attempt: number,
  ): Promise<T> {
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
      // The Key appears only in request headers; never in URLs, logs, or errors.
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
          message: `DFR request timed out (${method} ${path}, ${options.timeoutMs ?? this.timeoutMs}ms)`,
          status: 504,
          retryable: true,
          safeToRetry: options.safeToRetryOnTimeout,
          requestId,
          attempts: attempt,
        });
      }
      throw new DfrApiError({
        code: 'DFR_PROVIDER_UNAVAILABLE',
        message: `Cannot connect to the DFR Gateway (${method} ${path})`,
        status: 503,
        retryable: true,
        safeToRetry: options.safeToRetryOnTimeout,
        requestId,
        attempts: attempt,
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
        // Body is not JSON: the error path degrades to a generic error; the success path counts as a corrupted response.
        parsable = false;
      }
    }

    if (!response.ok) {
      const retryAfterMs = retryAfterMsOf(response.headers.get('retry-after'));
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
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        attempts: attempt,
      });
    }

    if (!parsable) {
      throw new DfrApiError({
        code: 'DFR_PROVIDER_INVALID_RESPONSE',
        message: `DFR returned a non-JSON response (${method} ${path}, HTTP ${response.status})`,
        status: 502,
        retryable: true,
        safeToRetry: options.safeToRetryOnTimeout,
        requestId: response.headers.get('x-request-id') ?? requestId,
        attempts: attempt,
      });
    }

    return parsed as T;
  }

  /** Lets callers safely identify the instance in logs: contains no Key material. */
  describe(): string {
    return `DFR(baseUrl=${this.baseUrl})`;
  }
}

/* -------------------------------------------------------------------------- */
/* DfrClient — first-run façade                                                */
/* -------------------------------------------------------------------------- */

/** Options for the first-run client; identical connection options plus an explicit retry policy. */
export interface DfrClientSettings extends DfrClientOptions {
  /**
   * Retry policy override. The façade defaults to two retries of **idempotent GET** requests
   * (chains, balances, usage) with exponential backoff and jitter. Read-only POST `/v1/logs`
   * is never retried automatically, even though the server marks it safe.
   */
  retry?: RetryPolicy;
}

class DfrChainsResource {
  constructor(private readonly dfr: DFR) {}
  /** `GET /v1/chains` */
  list(): Promise<readonly Chain[]> {
    return this.dfr.listChains();
  }
  /** `GET /v1/chains/{chainId}` */
  get(chainId: string): Promise<ChainInfo & { requestId: string }> {
    return this.dfr.getChain(chainId);
  }
}

class DfrBalancesResource {
  constructor(private readonly dfr: DFR) {}
  /** `GET /v1/balances` */
  get(params: GetBalanceParams): Promise<Balance> {
    return this.dfr.getBalance(params);
  }
}

class DfrLogsResource {
  constructor(private readonly dfr: DFR) {}
  /**
   * One page of `POST /v1/logs`. `limit` is a real page size; `hasMore`/`nextCursor` describe
   * exactly what was returned. Continue with `{ chain, cursor, limit }`.
   */
  query(params: GetLogsPageParams): Promise<LogsPageResponse> {
    return this.dfr.getLogsPage(params);
  }

  /**
   * Iterate every log in the pinned range, following the server cursor automatically.
   * Yields `ChainLog` values (not pages), so a consumer can `for await` over the whole range.
   * The cursor pins the range and filters; changing them mid-iteration is rejected by the server.
   */
  async *iterate(params: GetLogsPageParams): AsyncGenerator<ChainLog, void, void> {
    let page = await this.query(params);
    for (;;) {
      for (const log of page.logs) yield log;
      if (!page.hasMore || page.nextCursor === undefined) return;
      page = await this.query({
        chain: params.chain,
        cursor: page.nextCursor,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    }
  }
}

/**
 * Three-line first call:
 *
 * ```ts
 * const client = new DfrClient({ apiKey, baseUrl });
 * const chains = await client.chains.list();
 * const balance = await client.balances.get({ chain: 'base-sepolia', account: '0x…' });
 * ```
 *
 * Every method throws `DfrApiError` with `code`, `requestId`, `retryable`, `safeToRetry`
 * and `attempts`, so callers can branch without parsing messages.
 */
export class DfrClient {
  private readonly dfr: DFR;
  readonly chains: DfrChainsResource;
  readonly balances: DfrBalancesResource;
  readonly logs: DfrLogsResource;

  constructor(settings: DfrClientSettings) {
    // Only idempotent GETs are retried by default. Logs are POST and deliberately excluded;
    // a caller-provided policy can tune delays/attempts but keeps the GET-only guard unless it
    // explicitly supplies its own retryOn.
    const getOnly = (_error: DfrApiError, _attempts: number, method: 'GET' | 'POST'): boolean => method === 'GET';
    const retry =
      settings.retry === undefined
        ? { maxRetries: 2, retryOn: getOnly }
        : { retryOn: getOnly, ...settings.retry };
    this.dfr = new DFR({ ...settings, retry });
    this.chains = new DfrChainsResource(this.dfr);
    this.balances = new DfrBalancesResource(this.dfr);
    this.logs = new DfrLogsResource(this.dfr);
  }

  /** `GET /v1/usage` — per-process request counts + effective limits. */
  usage(): Promise<UsageResponse> {
    return this.dfr.getUsage();
  }

  /** Escape hatch for the full surface (write path, events, receipts). */
  raw(): DFR {
    return this.dfr;
  }

  describe(): string {
    return this.dfr.describe().replace('DFR(', 'DfrClient(');
  }
}

/**
 * Idempotency key: `crypto.randomUUID()` is 36 characters, inside OpenAPI's 8–128 range.
 * Never written to logs; only sent as a request header.
 */
function generateIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * `Idempotency-Key` length contract (matching OpenAPI `IdempotencyKey` / `IdempotencyKeyOptional`
 * and the Gateway-enforced values; see TODO-007).
 *
 * Why the SDK validates too: when the caller passes an invalid key, a local `TypeError` is clearer than waiting for a server 400,
 * and it avoids wasting a network round trip on a request that will certainly be rejected. The boundaries match, so there is no case of
 * "the SDK allows it but the server rejects it" or vice versa.
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Caller cancellation is checked through a helper so TS does not over-narrow a property read. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Strict decimal block number; the HTTP contract never accepts hex or JSON numbers here. */
function parseBlockNumber(value: string, field: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) {
    throw new TypeError(`DFR: getLogsPaged ${field} must be a decimal block-number string`);
  }
  return BigInt(value);
}

function assertIdempotencyKey(value: string, method: string): string {
  if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new TypeError(
      `DFR: ${method} requires an Idempotency-Key of length ` +
        `${IDEMPOTENCY_KEY_MIN_LENGTH}..${IDEMPOTENCY_KEY_MAX_LENGTH} (got ${value.length})`,
    );
  }
  return value;
}

/** Defaults for an explicitly provided retry policy; validates numeric bounds eagerly. */
function resolveRetryPolicy(policy: RetryPolicy): Required<Omit<RetryPolicy, 'retryOn'>> & Pick<RetryPolicy, 'retryOn'> {
  const resolved = {
    maxRetries: policy.maxRetries ?? 2,
    baseDelayMs: policy.baseDelayMs ?? 250,
    maxDelayMs: policy.maxDelayMs ?? 5_000,
    jitter: policy.jitter ?? true,
    sleep:
      policy.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    ...(policy.retryOn !== undefined ? { retryOn: policy.retryOn } : {}),
  };
  if (!Number.isInteger(resolved.maxRetries) || resolved.maxRetries < 0 || resolved.maxRetries > 10) {
    throw new RangeError('DFR: retry.maxRetries must be an integer in 0..10');
  }
  for (const [name, value] of [
    ['baseDelayMs', resolved.baseDelayMs],
    ['maxDelayMs', resolved.maxDelayMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`DFR: retry.${name} must be a non-negative finite number`);
    }
  }
  return resolved;
}

/** `Retry-After` accepts delta-seconds or an HTTP date (RFC 9110). */
function retryAfterMsOf(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
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
  UsageResponse,
  LogsPageResponse,
} from '@dfr/types';

/**
 * Parse a single SSE frame (join `data:` lines; ignore comment lines/heartbeats; only take `data`).
 *
 * Consistent with the ADR-029 event-line protocol: the Gateway sends `ChainEvent` as `data: <json>`.
 * Returning `undefined` means the frame carries no data (heartbeat or pure comment).
 */
function parseSseFrame(frame: string): ChainEvent | undefined {
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '' || line.startsWith(':')) continue; // comment/heartbeat
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
