/**
 * Solana address validation (ADR-028: validation lives in the Adapter; Core makes no chain-specific assumptions).
 *
 * Rules: base58 decodes successfully + exactly 32 bytes + no on-curve requirement (PDA / program addresses are equally valid).
 */
import { createDfrError } from '@dfr/errors';
import type { ChainId } from '@dfr/types';
import { base58Decode, isBase58 } from './base58.js';

/** Solana public keys are always 32 bytes. */
export const SOLANA_PUBKEY_BYTES = 32;
/** 32 bytes in base58 is at most 44 characters. */
export const SOLANA_ADDRESS_MAX_LENGTH = 44;

export function isSolanaAddress(value: string): boolean {
  if (value.length === 0 || value.length > SOLANA_ADDRESS_MAX_LENGTH) return false;
  if (!isBase58(value)) return false;
  const decoded = base58Decode(value);
  return decoded !== null && decoded.length === SOLANA_PUBKEY_BYTES;
}

/** Transaction signatures (txHash) have the same shape as addresses: a base58-encoded 64-byte signature. */
const SIGNATURE_BYTES = 64;

export function isSolanaSignature(value: string): boolean {
  if (value.length === 0) return false;
  if (!isBase58(value)) return false;
  const decoded = base58Decode(value);
  return decoded !== null && decoded.length === SIGNATURE_BYTES;
}

/** Invalid address → DFR_INVALID_ACCOUNT (422, not retryable). */
export function assertSolanaAddress(
  value: string,
  chain: ChainId,
  requestId: string,
): asserts value is string {
  if (!isSolanaAddress(value)) {
    throw createDfrError('DFR_INVALID_ACCOUNT', {
      requestId: requestId as never,
      message: 'not a valid Solana address (expected a base58-encoded 32-byte public key)',
      chain,
    });
  }
}

/** Invalid signature → DFR_INVALID_REQUEST (the signature is a path parameter, not an account). */
export function assertSolanaSignature(
  value: string,
  chain: ChainId,
  requestId: string,
): asserts value is string {
  if (!isSolanaSignature(value)) {
    throw createDfrError('DFR_INVALID_REQUEST', {
      requestId: requestId as never,
      message: 'not a valid Solana signature (expected base58-encoded 64 bytes)',
      chain,
    });
  }
}
