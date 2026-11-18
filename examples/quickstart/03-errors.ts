/**
 * Quickstart 3/5 — handle DFR errors correctly.
 *
 * Rules every integration should follow:
 * - Branch on the stable `dfr_code`, never on HTTP status text or `detail`;
 * - Log `requestId` (it is the same value in Gateway logs) for support;
 * - Retry only when `retryable && safeToRetry` is true;
 * - Never retry a failed broadcast blindly — `safeToRetry` is false for non-idempotent writes.
 */
import { isDfrApiError, type DfrApiError } from '@dfr/sdk-typescript';
import { CHAIN, createClient, heading, show } from './lib.ts';

const dfr = createClient({ retry: { maxRetries: 2, baseDelayMs: 5 } });

function describe(error: unknown): Record<string, unknown> {
  if (!isDfrApiError(error)) return { unexpected: String(error) };
  const typed: DfrApiError = error;
  return {
    code: typed.code,
    status: typed.status,
    retryable: typed.retryable,
    safeToRetry: typed.safeToRetry,
    requestId: typed.requestId,
    attempts: typed.attempts,
    message: typed.message,
  };
}

heading('400: invalid block reference (a request bug — do not retry)');
try {
  await dfr.getBlock({ chain: CHAIN, blockRef: '123' });
  throw new Error('expected the request to fail');
} catch (error) {
  const info = describe(error);
  show('error', info);
  if (info['code'] !== 'DFR_VALIDATION_FAILED') {
    throw new Error(`expected DFR_VALIDATION_FAILED, got ${String(info['code'])}`, { cause: error });
  }
  // The retry policy saw safeToRetry=false, so exactly one attempt was made.
  if (info['attempts'] !== 1) throw new Error('a non-retryable error must not be retried', { cause: error });
}

heading('404: unknown chain (check /v1/chains, then your config)');
try {
  await dfr.getChain('no-such-chain');
  throw new Error('expected the request to fail');
} catch (error) {
  show('error', describe(error));
}

process.stdout.write('\nBoth failures were handled as data, not as crashes.\n');
