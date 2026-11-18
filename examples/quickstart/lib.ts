/**
 * Shared helpers for the DFR quickstart examples.
 *
 * These examples import the **workspace SDK source** (`@dfr/sdk-typescript`), which is what a
 * developer gets from `pnpm pack` / npm as `dist`. They only need three environment variables:
 *
 *   DFR_API_KEY   the key issued by `pnpm api-key:issue`
 *   DFR_BASE_URL  the Gateway base URL (default http://127.0.0.1:8787)
 *   DFR_EXAMPLE_CHAIN  optional chain id (default ethereum-sepolia)
 */
import { DFR, type RetryPolicy } from '@dfr/sdk-typescript';

export const BASE_URL = (process.env['DFR_BASE_URL'] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
export const CHAIN = process.env['DFR_EXAMPLE_CHAIN'] ?? 'ethereum-sepolia';
/** A well-known test address; override with DFR_EXAMPLE_ACCOUNT for your own. */
export const ACCOUNT = process.env['DFR_EXAMPLE_ACCOUNT'] ?? '0x1111111111111111111111111111111111111111';

export function createClient(options: { retry?: RetryPolicy } = {}): DFR {
  const apiKey = process.env['DFR_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      'DFR_API_KEY is required. Issue one with: DFR_M0_API_KEY_PEPPER=<pepper> pnpm api-key:issue',
    );
  }
  return new DFR({
    apiKey,
    baseUrl: BASE_URL,
    timeoutMs: 15_000,
    ...(options.retry !== undefined ? { retry: options.retry } : {}),
  });
}

export function heading(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

export function show(label: string, value: unknown): void {
  process.stdout.write(`${label}:\n${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Resolve the first SSE event, or `undefined` after `ms`.
 *
 * On timeout this calls `close()` **before** draining the pending `next()`: an SSE read blocks
 * on the socket, so a generator `return()` would wait forever behind it.
 */
export async function firstEvent<T>(
  events: AsyncIterable<T>,
  ms: number,
  close: () => void,
): Promise<T | undefined> {
  const iterator = events[Symbol.asyncIterator]();
  const pending = iterator.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const winner = await Promise.race([
    pending.then((next) => ({ kind: 'event' as const, next })),
    timeout.then(() => ({ kind: 'timeout' as const })),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (winner.kind === 'event') {
    return winner.next.done ? undefined : winner.next.value;
  }
  close();
  await pending.catch(() => undefined);
  return undefined;
}
