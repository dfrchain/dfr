/**
 * SDK write-path contract tests (DFR-M1-B09).
 *
 * Authoritative sources: docs/architecture/m1-api-contract.md Sections 1/2/5,
 * docs/architecture/error-spec-v0.1.md Section 7 (client-handling advice).
 *
 * This file only verifies the SDK's responsibilities: generating default idempotency keys, passing request bodies through unchanged, and normalizing HTTP/transport failures
 * into `DfrApiError`; and **cancellation (caller abort) and timeout are two different outcomes**.
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

describe('SDK confirmTransaction (DFR-M1-D05)', () => {
  it('POST confirm path/body, keeping the requestId envelope and reached=false', async () => {
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

  it('local HTTP timeout never fires before the server-side timeoutMs wait window', async () => {
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

describe('SDK buildTransaction (DFR-M1-B09)', () => {
  it('POST /v1/transactions/build, generating a default idempotency key and returning the contract envelope', async () => {
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

  it('each call generates a different idempotency key (retries must explicitly reuse the same key)', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, OK_BUILD), seen));

    await dfr.buildTransaction(REQUEST);
    await dfr.buildTransaction(REQUEST);

    expect(seen[0]?.headers['idempotency-key']).not.toBe(seen[1]?.headers['idempotency-key']);
  });

  it('a caller-provided idempotency key wins over the generated one', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, OK_BUILD), seen));

    await dfr.buildTransaction(REQUEST, { idempotencyKey: 'my-own-key-0001' });

    expect(seen[0]?.headers['idempotency-key']).toBe('my-own-key-0001');
  });
});

describe('SDK simulateTransaction (DFR-M1-B09)', () => {
  it('POST /v1/transactions/simulate, body is transactionId + unsignedTransaction', async () => {
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
    // simulate is located by transactionId; no idempotency key is generated.
    expect(seen[0]?.headers['idempotency-key']).toBeUndefined();
    expect(result.simulation).toEqual({ success: true });
  });
});

describe('SDK error and cancellation semantics (DFR-M1-B09)', () => {
  it('HTTP error → DfrApiError (code/status/requestId from the error envelope), no retry', async () => {
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

  it('a usable DfrApiError is still given when the response body is not an error envelope (no Key leaked)', async () => {
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

  it('timeout → DfrApiError DFR_PROVIDER_TIMEOUT(504), retryable and carrying the caller\'s requestId', async () => {
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
    // The SDK sends X-Request-Id (the Gateway writes back the same value), so timeouts can also be correlated with server logs.
    // Assert the format with the real @dfr/errors validator, so the two ID implementations do not drift.
    expect(isValidRequestId(apiError.requestId)).toBe(true);
  });

  it('caller cancellation → the caller\'s abort reason is rethrown as-is, not disguised as a DfrApiError', async () => {
    const dfr = client(neverResponds, 10_000);
    const controller = new AbortController();
    const reason = new Error('caller-cancelled');
    const promise = dfr.buildTransaction(REQUEST, { signal: controller.signal });
    controller.abort(reason);

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(isDfrApiError(err)).toBe(false);
  });

  it('transport failure (fetch reject) → DfrApiError DFR_PROVIDER_UNAVAILABLE, with no Key/URL details', async () => {
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

  it('describe() and error messages contain no API Key', async () => {
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

/** Never resolves, but turns abort into a fetch rejection (simulating real fetch behavior). */
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

describe('SDK Idempotency-Key length contract (TODO-007)', () => {
  // Matches OpenAPI `IdempotencyKey` / `IdempotencyKeyOptional` and the Gateway-enforced values.
  // The value of local fail-fast: the caller immediately gets a clear error without wasting a network round trip on a request that will certainly be rejected.
  it('constants match OpenAPI (8..128)', () => {
    expect(IDEMPOTENCY_KEY_MIN_LENGTH).toBe(8);
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  });

  it('buildTransaction: too short / too long / boundary values', async () => {
    const seen: Captured[] = [];
    const dfr = client(capture(() => jsonResponse(200, OK_BUILD), seen));

    await expect(
      dfr.buildTransaction(REQUEST, { idempotencyKey: 'a'.repeat(7) }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      dfr.buildTransaction(REQUEST, { idempotencyKey: 'a'.repeat(129) }),
    ).rejects.toBeInstanceOf(TypeError);
    // Boundary values are valid and must not be rejected before a request is sent.
    await dfr.buildTransaction(REQUEST, { idempotencyKey: 'b'.repeat(8) });
    await dfr.buildTransaction(REQUEST, { idempotencyKey: 'c'.repeat(128) });
    expect(seen).toHaveLength(2);
  });

  it('simulateTransaction: providing a key is bound by the same contract', async () => {
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

  it('broadcastTransaction: missing / too short / too long are all rejected locally', async () => {
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
