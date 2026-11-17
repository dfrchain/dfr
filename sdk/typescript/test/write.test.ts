/**
 * SDK 写路径契约测试（DFR-M1-B09）。
 *
 * 权威来源：docs/architecture/m1-api-contract.md 第 1/2/5 节、
 * docs/architecture/error-spec-v0.1.md 第 7 节（客户端处理建议）。
 *
 * 本文件只验证 SDK 的职责：默认生成幂等键、请求体原样透传、把 HTTP/传输失败
 * 归一化为 `DfrApiError`，并且**取消（caller abort）与超时是两种不同结果**。
 */
import { describe, expect, it, vi } from 'vitest';
import { isValidRequestId } from '@dfr/errors';
import type { TransactionId, TransactionRequest, UnsignedTransaction } from '@dfr/types';
import {
  DFR,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  isDfrApiError,
  type DfrApiError,
} from '../src/index.js';

const BASE = 'https://gateway.example';
const KEY = 'dfr_B09_KeySecret0123456789abcdef';

const CHAIN = 'ethereum-sepolia' as never;

const UNSIGNED: UnsignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN,
  payload: '0x02f8',
  meta: { encoding: 'hex', requiresNonce: '42' as never },
};

const REQUEST: TransactionRequest = {
  chain: CHAIN,
  from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
  to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
  value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' as never },
};

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function capture(
  handler: (call: Captured) => Response | Promise<Response>,
  seen: Captured[],
): typeof fetch {
  return async (input, init) => {
    const call: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
      signal: init?.signal ?? undefined,
    };
    seen.push(call);
    return handler(call);
  };
}

function client(fetchImpl: typeof fetch, timeoutMs?: number): DFR {
  return new DFR({
    apiKey: KEY,
    baseUrl: BASE,
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

const OK_BUILD = {
  transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
  unsignedTransaction: UNSIGNED,
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
};

describe('SDK confirmTransaction（DFR-M1-D05）', () => {
  it('POST confirm path/body，保留 requestId 封套与 reached=false', async () => {
    const seen: Captured[] = [];
    const txHash = `0x${'a'.repeat(64)}`;
    const payload = {
      confirmation: {
        ref: { kind: 'hash', hash: txHash },
        status: 'included',
        finality: 'included',
        requiredFinality: 'finalized',
        confirmations: '3',
        reached: false,
      },
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
    };
    const dfr = client(capture(() => jsonResponse(200, payload), seen), 100);
    const result = await dfr.confirmTransaction({ chain: CHAIN, txHash, minFinality: 'finalized', timeoutMs: 60_000 });
    expect(seen[0]?.url).toBe(`${BASE}/v1/transactions/${encodeURIComponent(txHash)}/confirm`);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toEqual({ chain: CHAIN, minFinality: 'finalized', timeoutMs: 60_000 });
    expect(seen[0]?.signal?.aborted).toBe(false);
    expect(result).toEqual(payload);
  });

  it('本地 HTTP 超时不会早于服务端 timeoutMs 等待窗口', async () => {
    const txHash = `0x${'b'.repeat(32)}`;
    const dfr = client(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return jsonResponse(200, {
        confirmation: {
          ref: { kind: 'hash', hash: txHash },
          status: 'included',
          finality: 'included',
          reached: false,
        },
        requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
      });
    }, 20);
    await expect(dfr.confirmTransaction({ chain: CHAIN, txHash, timeoutMs: 1_000 })).resolves.toMatchObject({
      confirmation: { reached: false },
    });
  });
});

describe('SDK buildTransaction（DFR-M1-B09）', () => {
  it('POST /v1/transactions/build，默认生成幂等键，并返回契约封套', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, OK_BUILD), seen));

    const result = await dfr.buildTransaction(REQUEST);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${BASE}/v1/transactions/build`);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toEqual(REQUEST);
    expect(seen[0]?.headers['x-dfr-key']).toBe(KEY);
    const key = seen[0]?.headers['idempotency-key'];
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThanOrEqual(8);
    expect((key as string).length).toBeLessThanOrEqual(128);

    expect(result.transactionId).toBe(OK_BUILD.transactionId);
    expect(result.unsignedTransaction).toEqual(UNSIGNED);
    expect(result.requestId).toBe(OK_BUILD.requestId);
  });

  it('每次调用生成不同的幂等键（重试要显式复用同一个键）', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, OK_BUILD), seen));

    await dfr.buildTransaction(REQUEST);
    await dfr.buildTransaction(REQUEST);

    expect(seen[0]?.headers['idempotency-key']).not.toBe(seen[1]?.headers['idempotency-key']);
  });

  it('调用方显式给出的幂等键优先于自动生成', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, OK_BUILD), seen));

    await dfr.buildTransaction(REQUEST, { idempotencyKey: 'my-own-key-0001' });

    expect(seen[0]?.headers['idempotency-key']).toBe('my-own-key-0001');
  });
});

describe('SDK simulateTransaction（DFR-M1-B09）', () => {
  it('POST /v1/transactions/simulate，body 为 transactionId + unsignedTransaction', async () => {
    const seen: Captured[] = [];
    const dfr = client(
      capture(
        () =>
          jsonResponse(200, {
            transactionId: OK_BUILD.transactionId,
            simulation: { success: true },
            requestId: OK_BUILD.requestId,
          }),
        seen,
      ),
    );

    const result = await dfr.simulateTransaction({
      transactionId: OK_BUILD.transactionId as TransactionId,
      unsignedTransaction: UNSIGNED,
    });

    expect(seen[0]?.url).toBe(`${BASE}/v1/transactions/simulate`);
    expect(seen[0]?.body).toEqual({
      transactionId: OK_BUILD.transactionId,
      unsignedTransaction: UNSIGNED,
    });
    // simulate 由 transactionId 定位；不自动生成幂等键。
    expect(seen[0]?.headers['idempotency-key']).toBeUndefined();
    expect(result.simulation).toEqual({ success: true });
  });
});

describe('SDK 错误与取消语义（DFR-M1-B09）', () => {
  it('HTTP 错误 → DfrApiError（code/status/requestId 来自错误封套），不重试', async () => {
    const seen: Captured[] = [];
    const dfr = client(
      capture(
        () =>
          jsonResponse(
            422,
            {
              dfr_code: 'DFR_TRANSACTION_REVERTED',
              detail: 'execution reverted',
              status: 422,
              retryable: false,
              safe_to_retry: false,
              request_id: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
            },
            { 'x-request-id': 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' },
          ),
        seen,
      ),
    );

    await expect(
      dfr.simulateTransaction({
        transactionId: OK_BUILD.transactionId as TransactionId,
        unsignedTransaction: UNSIGNED,
      }),
    ).rejects.toMatchObject({
      code: 'DFR_TRANSACTION_REVERTED',
      status: 422,
      retryable: false,
      safeToRetry: false,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
    });
    expect(seen).toHaveLength(1);
  });

  it('响应体不是错误封套时仍给可用的 DfrApiError（不泄漏 Key）', async () => {
    const dfr = client(
      capture(() => new Response('<html>502</html>', { status: 502 }), []),
    );

    const err = await dfr.buildTransaction(REQUEST).catch((e: unknown) => e);
    expect(isDfrApiError(err)).toBe(true);
    const apiError = err as DfrApiError;
    expect(apiError.status).toBe(502);
    expect(apiError.code).toBe('DFR_INTERNAL_ERROR');
    expect(JSON.stringify(apiError.message)).not.toContain(KEY);
  });

  it('超时 → DfrApiError DFR_PROVIDER_TIMEOUT(504)，可重试且带上调用方 requestId', async () => {
    const dfr = client(neverResponds, 20);

    const err = await dfr
      .simulateTransaction({
        transactionId: OK_BUILD.transactionId as TransactionId,
        unsignedTransaction: UNSIGNED,
      })
      .catch((e: unknown) => e);

    expect(isDfrApiError(err)).toBe(true);
    const apiError = err as DfrApiError;
    expect(apiError.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(apiError.status).toBe(504);
    expect(apiError.retryable).toBe(true);
    // SDK 发送 X-Request-Id（Gateway 会回写同一个值），因此超时也能关联服务端日志。
    // 用 @dfr/errors 的真实校验器断言格式，防止两份 ID 实现漂移。
    expect(isValidRequestId(apiError.requestId)).toBe(true);
  });

  it('调用方取消 → 原样抛出调用方的 abort 原因，不伪装成 DfrApiError', async () => {
    const dfr = client(neverResponds, 10_000);
    const controller = new AbortController();
    const reason = new Error('caller-cancelled');
    const promise = dfr.buildTransaction(REQUEST, { signal: controller.signal });
    controller.abort(reason);

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(isDfrApiError(err)).toBe(false);
  });

  it('传输失败（fetch reject）→ DfrApiError DFR_PROVIDER_UNAVAILABLE，且不含 Key/URL 细节', async () => {
    const dfr = client(
      async () => {
        throw new TypeError('fetch failed: connect ECONNREFUSED');
      },
      undefined,
    );

    const err = await dfr.buildTransaction(REQUEST).catch((e: unknown) => e);
    expect(isDfrApiError(err)).toBe(true);
    const apiError = err as DfrApiError;
    expect(apiError.code).toBe('DFR_PROVIDER_UNAVAILABLE');
    expect(apiError.message).not.toContain(KEY);
    expect(apiError.message).not.toContain(BASE);
  });

  it('describe() 与错误信息不包含 API Key', async () => {
    const dfr = client(capture(() => jsonResponse(200, OK_BUILD), []));
    expect(dfr.describe()).toBe(`DFR(baseUrl=${BASE})`);
    expect(dfr.describe()).not.toContain(KEY);

    let message = 'no-error';
    try {
      await client(async () => {
        throw new Error(`boom ${KEY}`);
      }).buildTransaction(REQUEST);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(KEY);
  });
});

/** 永不 resolve，但会把 abort 转成 fetch 的 rejection（模拟真实 fetch 行为）。 */
const neverResponds: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal ?? undefined;
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

void vi;

describe('SDK Idempotency-Key 长度契约（TODO-007）', () => {
  // 与 OpenAPI `IdempotencyKey` / `IdempotencyKeyOptional` 及 Gateway 强制值一致。
  // 本地 fail-fast 的价值：调用方立刻拿到清晰错误，且不浪费一次必然被拒的网络往返。
  it('常量与 OpenAPI 一致（8..128）', () => {
    expect(IDEMPOTENCY_KEY_MIN_LENGTH).toBe(8);
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  });

  it('buildTransaction：过短 / 过长 / 边界值', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, OK_BUILD), seen));

    await expect(
      dfr.buildTransaction(REQUEST, { idempotencyKey: 'a'.repeat(7) }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      dfr.buildTransaction(REQUEST, { idempotencyKey: 'a'.repeat(129) }),
    ).rejects.toBeInstanceOf(TypeError);
    // 边界值合法，且不得发出请求前就被拒。
    await dfr.buildTransaction(REQUEST, { idempotencyKey: 'b'.repeat(8) });
    await dfr.buildTransaction(REQUEST, { idempotencyKey: 'c'.repeat(128) });
    expect(seen).toHaveLength(2);
  });

  it('simulateTransaction：提供键时同样受契约约束', async () => {
    const seen: Captured[] = [];
    const dfr = client(
      capture(
        () => jsonResponse(200, { transactionId: OK_BUILD.transactionId, simulation: { success: true } }),
        seen,
      ),
    );
    const params = {
      transactionId: OK_BUILD.transactionId as TransactionId,
      unsignedTransaction: UNSIGNED,
    };
    await expect(
      dfr.simulateTransaction(params, { idempotencyKey: 'tiny' }),
    ).rejects.toBeInstanceOf(TypeError);
    await dfr.simulateTransaction(params);
    expect(seen).toHaveLength(1);
  });

  it('broadcastTransaction：缺失 / 过短 / 过长都被本地拒绝', async () => {
    const dfr = client(capture(() => jsonResponse(202, {}), []));
    const signed = {
      schemaVersion: '1',
      chain: CHAIN,
      unsigned: UNSIGNED,
      signedPayload: '0x02',
      expectedHash: '0xhash',
    } as never;
    const request = {
      transactionId: OK_BUILD.transactionId as TransactionId,
      signedTransaction: signed as never,
    };

    await expect(dfr.broadcastTransaction(request, {})).rejects.toBeInstanceOf(TypeError);
    await expect(
      dfr.broadcastTransaction(request, { idempotencyKey: 'a'.repeat(7) }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      dfr.broadcastTransaction(request, { idempotencyKey: 'a'.repeat(129) }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
