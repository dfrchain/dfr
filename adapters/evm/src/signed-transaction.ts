/**
 * EVM signed-payload parsing and binding (DFR-M1-C01).
 *
 * Authoritative sources: ADR-016 §7, docs/architecture/m1-api-contract.md Section 3.
 *
 * Before broadcast, derive everything from `signedPayload` **again** instead of trusting the caller:
 *   - chainId / nonce / to / value / data / fee fields / accessList: restored field by field from RLP;
 *   - txHash: `keccak256(signedPayload)`;
 *   - from: secp256k1 public-key recovery over the signature (`recoverTransactionAddress`).
 * The caller-provided `expectedHash` is **only for comparison**, not a source of truth (m1-api-contract §3).
 *
 * Design constraints (consistent with transaction-codec.ts):
 *   1. Only use Viem pure utilities (`recoverTransactionAddress`). No client / transport /
 *      account / wallet; hold neither private keys nor endpoints.
 *   2. Do not use `parseTransaction`: it downgrades nonce / chainId to JS `number`,
 *      which conflicts with this repo's red line "all values are decimal strings" (ADR-016 §2).
 *   3. All failures are `EvmCodecError` + a stable `reason`; error messages contain **neither the raw signature nor any payload
 *      fragment**, only field names and reasons.
 *   4. The return value is a redacted projection: no signedPayload / signature / r / s / v,
 *      and key names contain neither "payload" nor "signed", so callers do not casually write the raw signature into logs or databases.
 *
 * Boundary: this module is pure functions (signature recovery needs no network). No Provider selection, no broadcast, no database writes, no state decisions.
 */

import { recoverTransactionAddress } from 'viem';
import type { AccountRef, ChainId, DecimalUint } from '@dfr/types';
import { isEvmAddress } from './address.js';
import { decodeTransactionPayload, EvmCodecError } from './transaction-codec.js';
import type {
  EvmAccessListEntry,
  EvmDecodedTransaction,
  EvmTransactionType,
} from './transaction-codec.js';

/** Redacted projection of a signed payload. **Deliberately excludes** signedPayload / signature scalars (r/s/v/yParity). */
export interface EvmSignedTransactionBinding {
  readonly type: EvmTransactionType;
  readonly chainId: DecimalUint;
  readonly from: AccountRef;
  readonly nonce: DecimalUint;
  /** null means contract creation (`to` is empty). */
  readonly to: AccountRef | null;
  readonly value: DecimalUint;
  /** Call data (`0x` means a native transfer). */
  readonly data: string;
  readonly gas: DecimalUint;
  readonly accessList: readonly EvmAccessListEntry[];
  /** Transaction hash recomputed from the payload. */
  readonly txHash: string;
}

/** Ground truth for the binding comparison: all from the transaction record, never from the signature request. */
export interface EvmSignedBindingExpectation {
  readonly chain: ChainId;
  /** The chain's externalChainId in the Registry (decimal string). */
  readonly expectedChainId: DecimalUint;
  /** The sender from the record (an unsigned payload has no from; the record is the only source). */
  readonly from: AccountRef;
  /** The **unsigned** payload saved in the record: ground truth for field-level comparison. */
  readonly unsignedPayload: string;
  /** Caller-declared hash; only for comparison. */
  readonly expectedHash?: string;
}

/** Order of scalar fields compared item by item (`field` reports the first mismatching field). */
const COMPARED_FIELDS = [
  'type',
  'chainId',
  'nonce',
  'to',
  'value',
  'gas',
  'data',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

function scalarOf(tx: EvmDecodedTransaction, field: ComparedField): string | null {
  const value = tx[field];
  return value === undefined ? null : String(value);
}

/** Viem's union type for serialized payloads; this module only narrows strings to that type. */
type SerializedTransaction = Parameters<
  typeof recoverTransactionAddress
>[0]['serializedTransaction'];

/** Decode + signature verification + sender recovery; parse and bind share one implementation so the two decisions cannot drift. */
async function decodeSigned(
  signedPayload: string,
): Promise<{ readonly decoded: EvmDecodedTransaction; readonly from: string }> {
  // decodeTransactionPayload has already strictly validated hex / RLP / field count / transaction type,
  // and restored values to decimal strings (never via JS number).
  const decoded = decodeTransactionPayload(signedPayload);

  if (!decoded.signed) {
    throw new EvmCodecError('not_signed', 'payload has no signature and cannot be used as broadcast input');
  }
  if (decoded.chainId === null) {
    throw new EvmCodecError(
      'chain_id_unknown',
      'cannot derive chainId from the payload (pre-EIP-155 signature); refusing to broadcast',
      'chainId',
    );
  }

  let recovered: string;
  try {
    recovered = await recoverTransactionAddress({
      // The payload shape has been strictly validated by decodeTransactionPayload (prefix + RLP field count).
      serializedTransaction: signedPayload as SerializedTransaction,
    });
  } catch {
    // Do not forward the underlying exception: its message may contain the raw signature.
    throw new EvmCodecError('invalid_signature', 'cannot recover sender address from signature', 'from');
  }

  return { decoded, from: recovered.toLowerCase() };
}

function toBinding(
  chain: ChainId,
  decoded: EvmDecodedTransaction,
  from: string,
  chainId: DecimalUint,
): EvmSignedTransactionBinding {
  return {
    type: decoded.type,
    chainId,
    from: { chain, address: from },
    nonce: decoded.nonce,
    to: decoded.to === null ? null : { chain, address: decoded.to },
    value: decoded.value,
    data: decoded.data,
    gas: decoded.gas,
    accessList: decoded.accessList,
    txHash: decoded.hash,
  };
}

/**
 * Parse a signed payload, re-deriving every fact that must be checked before broadcast.
 *
 * Unsigned payloads, underivable chainId (pre-EIP-155), and unrecoverable signatures all fail closed.
 */
export async function parseSignedTransaction(
  chain: ChainId,
  signedPayload: string,
): Promise<EvmSignedTransactionBinding> {
  const { decoded, from } = await decodeSigned(signedPayload);
  return toBinding(chain, decoded, from, decoded.chainId as DecimalUint);
}

/**
 * Verify the signed payload matches the saved unsigned transaction item by item, and return a redacted projection.
 *
 * The comparison ground truth is the **unsigned payload in the record**, not fields the caller declares in the request:
 * A client that "changes parameters but reuses the same transactionId" cannot pass (m1-api-contract §3).
 */
export async function bindSignedTransaction(
  signedPayload: string,
  expectation: EvmSignedBindingExpectation,
): Promise<EvmSignedTransactionBinding> {
  // The sender in the record comes from our own store; an invalid one means the record was tampered with, so fail closed as an invalid expectation.
  // Deliberately no DFR_* error is thrown here: this module is pure functions, and error construction belongs to the Adapter layer (ADR-009).
  if (!isEvmAddress(expectation.from.address)) {
    throw new EvmCodecError(
      'invalid_expectation',
      'sender in the record is not a valid EVM address',
      'from',
    );
  }
  if (expectation.from.chain !== expectation.chain) {
    throw new EvmCodecError(
      'invalid_expectation',
      'sender chain in the record does not match the requested chain',
      'from',
    );
  }

  const { decoded, from } = await decodeSigned(signedPayload);
  const chainId = decoded.chainId as DecimalUint;

  if (chainId !== expectation.expectedChainId) {
    throw new EvmCodecError(
      'chain_id_mismatch',
      'signed payload chainId does not match the target chain',
      'chainId',
    );
  }
  if (from !== expectation.from.address.toLowerCase()) {
    throw new EvmCodecError(
      'sender_mismatch',
      'sender recovered from the signed payload does not match the transaction record',
      'from',
    );
  }

  const unsigned = decodeTransactionPayload(expectation.unsignedPayload);
  if (unsigned.signed) {
    throw new EvmCodecError(
      'invalid_expectation',
      'the recorded unsigned payload is actually signed; refusing it as comparison ground truth',
      'unsignedPayload',
    );
  }

  for (const field of COMPARED_FIELDS) {
    if (scalarOf(unsigned, field) !== scalarOf(decoded, field)) {
      throw new EvmCodecError(
        'unsigned_payload_mismatch',
        'signed payload does not match the saved unsigned transaction',
        field,
      );
    }
  }
  if (JSON.stringify(unsigned.accessList) !== JSON.stringify(decoded.accessList)) {
    throw new EvmCodecError(
      'unsigned_payload_mismatch',
      'signed payload accessList does not match the saved unsigned transaction',
      'accessList',
    );
  }

  if (
    expectation.expectedHash !== undefined &&
    expectation.expectedHash.toLowerCase() !== decoded.hash.toLowerCase()
  ) {
    throw new EvmCodecError(
      'expected_hash_mismatch',
      'caller-declared expectedHash does not match the transaction hash recomputed from the payload',
      'expectedHash',
    );
  }

  return toBinding(expectation.chain, decoded, from, chainId);
}
