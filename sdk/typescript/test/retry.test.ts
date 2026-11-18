/**
 * SDK retry policy contract (developer-product task 03, item 7).
 *
 * Design stance: retries are **opt-in** (`retry`), and a retry is only allowed when the server
 * says it is safe (`retryable && safe_to_retry`). The SDK never invents a retry for
 * `build`/`broadcast` (their server errors are explicitly `safe_to_retry: false`), and never
 * retries a caller cancellation.
 */
import { describe, expect, it } from 'vitest';
import { DFR, isDfrApiError } from '../src/index.js';
import type { ChainId, TransactionId } from '@dfr/types';

const BASE = 'https://gateway.example';
const KEY = 'dfr_RetryKey_secret0123456789abcdef';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function providerError(status = 503): Response {
  return json(status, {
    type: 'https://docs.dfr.example/errors/DFR_PROVIDER_UNAVAILABLE',
    title: 'Provider unavailable',
    status,
    detail: 'temporarily unavailable',
    dfr_code: 'DFR_PROVIDER_UNAVAILABLE',
    category: 'provider',
    retryable: true,
    safe_to_retry: true,
    request_id: 'req_server',
  });
}

const CHAINS = { items: [], requestId: 'req_ok' };

describe('SDK retry policy', () => {
  it('retries a retryable+safe failure and reuses the same request id', async () => {
    let calls = 0;
    const requestIds: (string | undefined)[] = [];
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 2, baseDelayMs: 1, jitter: false },
      fetchImpl: async (_input, init) => {
        calls += 1;
        requestIds.push((init?.headers as Record<string, string>)['x-request-id']);
        return calls < 3 ? providerError() : json(200, CHAINS);
      },
    });

    await expect(dfr.listChains()).resolves.toEqual([]);
    expect(calls).toBe(3);
    // One logical operation = one correlation id, across retries.
    expect(new Set(requestIds).size).toBe(1);
  });

  it('gives up after maxRetries and reports how many attempts were made', async () => {
    let calls = 0;
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 2, baseDelayMs: 1, jitter: false },
      fetchImpl: async () => {
        calls += 1;
        return providerError();
      },
    });

    await expect(dfr.listChains()).rejects.toSatisfy((error: unknown) => {
      if (!isDfrApiError(error)) return false;
      expect(error.code).toBe('DFR_PROVIDER_UNAVAILABLE');
      expect(error.attempts).toBe(3);
      return true;
    });
    expect(calls).toBe(3);
  });

  it('is off by default (no silent behavior change for existing callers)', async () => {
    let calls = 0;
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: async () => {
        calls += 1;
        return providerError();
      },
    });
    await expect(dfr.listChains()).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  it('never retries a non-retryable client error', async () => {
    let calls = 0;
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 3, baseDelayMs: 1, jitter: false },
      fetchImpl: async () => {
        calls += 1;
        return json(400, {
          type: 'https://docs.dfr.example/errors/DFR_VALIDATION_FAILED',
          title: 'Validation failed',
          status: 400,
          detail: 'bad',
          dfr_code: 'DFR_VALIDATION_FAILED',
          category: 'client',
          retryable: false,
          safe_to_retry: false,
          request_id: 'req_server',
        });
      },
    });
    await expect(dfr.listChains()).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  it('never retries an operation the server marked unsafe (broadcast)', async () => {
    let calls = 0;
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 3, baseDelayMs: 1, jitter: false },
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError('socket hang up');
      },
    });
    await expect(
      dfr.broadcastTransaction(
        {
          transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as TransactionId,
          signedTransaction: {
            schemaVersion: '1',
            chain: 'ethereum-sepolia' as ChainId,
            unsigned: {
              schemaVersion: '1',
              chain: 'ethereum-sepolia' as ChainId,
              payload: `0x${'cd'.repeat(32)}`,
              meta: {},
            },
            signedPayload: `0x${'ef'.repeat(32)}`,
            expectedHash: `0x${'ab'.repeat(32)}`,
          },
        },
        { idempotencyKey: 'retry-broadcast-key' },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isDfrApiError(error)) return false;
      // Transport failure is server-unknown for a non-idempotent write: retryable, but NOT safe.
      expect(error.code).toBe('DFR_PROVIDER_UNAVAILABLE');
      expect(error.retryable).toBe(true);
      expect(error.safeToRetry).toBe(false);
      expect(error.attempts).toBe(1);
      return true;
    });
    expect(calls).toBe(1);
  });

  it('honors Retry-After on a 429 instead of blind exponential backoff', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      retry: {
        maxRetries: 1,
        baseDelayMs: 1,
        jitter: false,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? json(
              429,
              {
                type: 'https://docs.dfr.example/errors/DFR_RATE_LIMITED',
                title: 'Rate limited',
                status: 429,
                detail: 'slow down',
                dfr_code: 'DFR_RATE_LIMITED',
                category: 'policy',
                retryable: true,
                safe_to_retry: true,
                request_id: 'req_server',
              },
              { 'retry-after': '2' },
            )
          : json(200, CHAINS);
      },
    });

    await expect(dfr.listChains()).resolves.toEqual([]);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('does not retry a caller cancellation', async () => {
    const controller = new AbortController();
    let calls = 0;
    const dfr = new DFR({
      apiKey: KEY,
      baseUrl: BASE,
      retry: { maxRetries: 3, baseDelayMs: 1, jitter: false },
      fetchImpl: async (_input, init) => {
        calls += 1;
        controller.abort(new Error('user-cancelled'));
        throw (init?.signal as AbortSignal | undefined)?.reason ?? new Error('aborted');
      },
    });

    await expect(
      dfr.createEventTicket({ filter: {} }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(controller.signal.aborted).toBe(true);
  });
});
