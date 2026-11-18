/**
 * Parsing and binding verification of signed Solana transactions (DFR-M3-C01).
 *
 * Authoritative sources: m1-api-contract Section 3 (txHash is recomputed from the payload), and the EVM version
 * `adapters/evm/src/signed-transaction.ts` (isomorphic, but only what Solana can prove).
 *
 * Key difference from EVM: Solana has **no account nonce**. Binding verification therefore compares:
 *   1. the payload is signed (signature is not all zeros);
 *   2. fee payer == the from in the record;
 *   3. the recomputed transaction hash == the recorded expectedHash;
 *   4. the **message of the recorded unsigned payload (ground truth) with the signature section removed** matches the signed payload's message byte for byte.
 *
 * Rule 4 replaces EVM's "field-by-field comparison of nonce/to/value/data": a Solana message is self-describing,
 * so byte-for-byte equality is stronger than field-by-field reconstruction (it covers account order and instruction data too).
 *
 * The signature itself is not verified (that needs ed25519 + full account parsing); that is not this layer's job, and it is **not** claimed to be done.
 * The chain is the real final authority: after broadcast, `simulateTransaction` / the confirmation path decides.
 */
import { fromBase64, splitSignatures, decodeTransactionPayload } from './transaction-codec.js';
import type { SolanaDecodedTransaction } from './transaction-codec.js';

export type SolanaBindingErrorReason =
  | 'not_signed'
  | 'invalid_payload'
  | 'sender_mismatch'
  | 'expected_hash_mismatch'
  | 'unsigned_payload_mismatch'
  | 'invalid_expectation';

export class SolanaBindingError extends Error {
  override readonly name = 'SolanaBindingError';
  readonly reason: SolanaBindingErrorReason;

  constructor(reason: SolanaBindingErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface SolanaSignedBindingInput {
  /** The sender from the record (fee payer). */
  readonly from: string;
  /** The unsigned payload in the record (ground truth). */
  readonly unsignedPayload: string;
  /** The recorded expectedHash (recomputed from the payload). */
  readonly expectedHash: string;
}

export interface SolanaSignedBindingResult {
  /** Transaction hash recomputed from the signed payload (signature 0, base58). */
  readonly txHash: string;
  readonly decoded: SolanaDecodedTransaction;
}

/** Return the message bytes with the signature section removed (base64 input). */
function messageBytesOf(payloadBase64: string): Uint8Array {
  const bytes = fromBase64(payloadBase64, 'payload');
  const { messageBytes } = splitSignatures(bytes);
  return messageBytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Parse and bind an externally signed Solana transaction.
 *
 * All failures throw `SolanaBindingError` (normalized by the Adapter to 422 `DFR_TRANSACTION_REJECTED`).
 */
export function bindSignedTransaction(
  signedPayload: string,
  input: SolanaSignedBindingInput,
): SolanaSignedBindingResult {
  let decoded: SolanaDecodedTransaction;
  try {
    decoded = decodeTransactionPayload(signedPayload);
  } catch (error) {
    throw new SolanaBindingError('invalid_payload', error instanceof Error ? error.message : 'payload parsing failed');
  }
  if (!decoded.signed) {
    throw new SolanaBindingError('not_signed', 'payload has no valid signature (signature is all zeros)');
  }

  const feePayer = decoded.accountKeys[0];
  if (feePayer === undefined || feePayer !== input.from) {
    throw new SolanaBindingError('sender_mismatch', 'signed payload fee payer does not match the record');
  }

  const txHash = decoded.signatures[0];
  if (txHash === undefined) {
    throw new SolanaBindingError('invalid_payload', 'signed payload has no signature section');
  }
  if (txHash !== input.expectedHash) {
    throw new SolanaBindingError('expected_hash_mismatch', 'recomputed transaction hash does not match the record');
  }

  // Messages must be byte-for-byte equal: the recorded unsigned payload and the signed payload must be the **same transaction**.
  let expectedMessage: Uint8Array;
  try {
    expectedMessage = messageBytesOf(input.unsignedPayload);
  } catch (error) {
    throw new SolanaBindingError(
      'invalid_expectation',
      error instanceof Error ? error.message : 'recorded unsigned payload cannot be parsed',
    );
  }
  const actualMessage = messageBytesOf(signedPayload);
  if (!bytesEqual(expectedMessage, actualMessage)) {
    throw new SolanaBindingError('unsigned_payload_mismatch', 'signed payload is not the same transaction as the recorded unsigned payload');
  }

  return { txHash, decoded };
}
