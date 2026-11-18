/**
 * EVM address validation (an Adapter responsibility; Core makes no format assumptions — domain-model Section 4.2).
 */
import { createDfrError } from '@dfr/errors';
import type { ChainId } from '@dfr/types';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isEvmAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

export function isEvmTxHash(value: string): boolean {
  return TX_HASH_RE.test(value);
}

/** Invalid address → DFR_INVALID_ACCOUNT (422, not retryable). */
export function assertEvmAddress(
  value: string,
  chain: ChainId,
  requestId: string,
): asserts value is string {
  if (!isEvmAddress(value)) {
    throw createDfrError('DFR_INVALID_ACCOUNT', {
      requestId: requestId as never,
      message: `not a valid EVM address (expected 0x + 40 hex digits)`,
      chain,
    });
  }
}

/** Invalid transaction hash → DFR_INVALID_REQUEST (the hash is a path parameter, not an account). */
export function assertEvmTxHash(
  value: string,
  chain: ChainId,
  requestId: string,
): asserts value is string {
  if (!isEvmTxHash(value)) {
    throw createDfrError('DFR_INVALID_REQUEST', {
      requestId: requestId as never,
      message: 'not a valid EVM transaction hash (expected 0x + 64 hex digits)',
      chain,
    });
  }
}
