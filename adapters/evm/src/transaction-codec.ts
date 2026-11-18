/**
 * EVM transaction codec pure functions (DFR-M1-B01).
 *
 * Authoritative sources: ADR-016, docs/architecture/m1-api-contract.md.
 *
 * Design constraints (one per ADR-016 rule):
 *   1. **Only use Viem pure utilities**: `serializeTransaction` (encoding), `fromRlp` (lossless decoding),
 *      `keccak256` (hashing). No `PublicClient` / `WalletClient` / transport /
 *      account / signing capability, and no home-grown RLP or secp256k1.
 *   2. **All values are bigint / decimal strings**. Viem's `parseTransaction` downgrades
 *      `nonce` and `chainId` to JS `number`, so this module does **not** use it for decoding;
 *      it uses `fromRlp` to restore fields one by one instead, avoiding any precision or type regression.
 *   3. Input validation fails closed: invalid decimals, JS numbers, invalid addresses / data / accessLists,
 *      and fee fields mismatched with the transaction type must all throw `EvmCodecError`, never silently corrected.
 *   4. This module is pure functions: no network requests, no private-key reads, no endpoints or credentials held.
 *
 * Boundary: this module only encodes/decodes and compares structure; it does **not** select Providers, write to databases, or decide transaction state.
 */

import { fromRlp, keccak256, serializeTransaction } from 'viem';
import type { DecimalUint } from '@dfr/types';
import { isEvmAddress } from './address.js';

/** EVM transaction types supported by M1 (ADR-016 §5). */
export type EvmTransactionType = 'legacy' | 'eip2930' | 'eip1559';

/** Stable failure reason codes; the Adapter normalizes them into public DFR errors. */
export type EvmCodecErrorReason =
  | 'number_not_allowed'
  | 'invalid_decimal'
  | 'invalid_address'
  | 'invalid_hex_data'
  | 'invalid_access_list'
  | 'missing_fee_field'
  | 'unexpected_fee_field'
  | 'invalid_fee_bounds'
  | 'unsupported_transaction_type'
  | 'invalid_payload'
  | 'intent_mismatch'
  // DFR-M1-C01: signed-payload parsing and binding (signed-transaction.ts)
  | 'not_signed'
  | 'chain_id_unknown'
  | 'invalid_signature'
  | 'chain_id_mismatch'
  | 'sender_mismatch'
  | 'unsigned_payload_mismatch'
  | 'expected_hash_mismatch'
  | 'invalid_expectation';

export class EvmCodecError extends Error {
  override readonly name = 'EvmCodecError';
  readonly reason: EvmCodecErrorReason;
  readonly field?: string;

  constructor(reason: EvmCodecErrorReason, message: string, field?: string) {
    super(message);
    this.reason = reason;
    if (field !== undefined) this.field = field;
  }
}

export interface EvmAccessListEntry {
  readonly address: string;
  readonly storageKeys: readonly string[];
}

/** Unsigned transaction intent. All numeric fields are canonical decimal strings; JS number is forbidden. */
export interface EvmUnsignedIntent {
  readonly chainId: string;
  readonly nonce: string;
  readonly to: string;
  readonly value: string;
  readonly gas: string;
  /** Call data; omitting it is equivalent to `0x` (native transfer). */
  readonly data?: string;
  readonly type?: EvmTransactionType;
  /** Required for legacy / eip2930. */
  readonly gasPrice?: string;
  /** Required for eip1559. */
  readonly maxFeePerGas?: string;
  /** Required for eip1559. */
  readonly maxPriorityFeePerGas?: string;
  readonly accessList?: readonly EvmAccessListEntry[];
}

export interface EvmUnsignedPayload {
  /** Unsigned serialized payload: the signing hash is keccak256 of it, computed by the external wallet. */
  readonly payload: string;
  readonly encoding: 'hex';
  readonly type: EvmTransactionType;
  readonly chainId: DecimalUint;
  readonly nonce: DecimalUint;
  /** `keccak256(payload)`: the pre-signing hash when unsigned. */
  readonly signingHash: string;
}

export interface EvmDecodedTransaction {
  readonly type: EvmTransactionType;
  /** null when it cannot be derived from the payload (pre-EIP-155 legacy). */
  readonly chainId: DecimalUint | null;
  readonly nonce: DecimalUint;
  /** null means contract creation. */
  readonly to: string | null;
  readonly value: DecimalUint;
  readonly data: string;
  readonly gas: DecimalUint;
  readonly gasPrice?: DecimalUint;
  readonly maxFeePerGas?: DecimalUint;
  readonly maxPriorityFeePerGas?: DecimalUint;
  readonly accessList: readonly EvmAccessListEntry[];
  /** Whether the payload already carries a signature. */
  readonly signed: boolean;
  /** `keccak256(payload)`: the pre-signing hash when unsigned, the transaction hash when signed. */
  readonly hash: string;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                            */
/* ------------------------------------------------------------------ */

/** Canonical decimal: no leading zeros (except `0` itself), no sign, no fraction. */
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const STORAGE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function toBigIntField(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    throw new EvmCodecError(
      'number_not_allowed',
      `${field} must not use JS number (all values are decimal strings)`,
      field,
    );
  }
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new EvmCodecError(
      'invalid_decimal',
      `${field} must be a canonical decimal string (no leading zeros, no sign, no fraction)`,
      field,
    );
  }
  return BigInt(value);
}

function toDecimal(value: bigint): DecimalUint {
  return value.toString(10) as DecimalUint;
}

/** EVM transaction values must use the shortest big-endian RLP form; zero is only allowed as an empty byte string. */
function rlpToBigInt(value: string): bigint {
  if (value === '0x') return 0n;
  if (!/^0x(?:[0-9a-f]{2})+$/.test(value) || value.startsWith('0x00')) {
    throw new EvmCodecError('invalid_payload', 'RLP integer fields must not contain leading zeros or non-canonical bytes');
  }
  return BigInt(value);
}

function normalizeData(value: string | undefined, field: string): string {
  if (value === undefined) return '0x';
  if (!HEX_DATA_RE.test(value)) {
    throw new EvmCodecError(
      'invalid_hex_data',
      `${field} must be 0x-prefixed hex with an even number of bytes`,
      field,
    );
  }
  return value.toLowerCase();
}

function normalizeAddress(value: string, field: string): string {
  if (!isEvmAddress(value)) {
    throw new EvmCodecError('invalid_address', `${field} is not a valid EVM address`, field);
  }
  return value.toLowerCase();
}

function normalizeAccessList(
  list: readonly EvmAccessListEntry[] | undefined,
): readonly EvmAccessListEntry[] {
  if (list === undefined) return [];
  return list.map((entry) => {
    // accessList-internal problems are all classified as invalid_access_list, so callers can distinguish
    // "invalid target address" from "invalid access list" as two different fixes.
    let address: string;
    try {
      address = normalizeAddress(entry.address, 'accessList.address');
    } catch {
      throw new EvmCodecError(
        'invalid_access_list',
        'accessList.address is not a valid EVM address',
        'accessList.address',
      );
    }
    const storageKeys = entry.storageKeys.map((key) => {
      if (!STORAGE_KEY_RE.test(key)) {
        throw new EvmCodecError(
          'invalid_access_list',
          'accessList.storageKeys must be 0x + 32-byte hex',
          'accessList.storageKeys',
        );
      }
      return key.toLowerCase();
    });
    return { address, storageKeys };
  });
}

/** Minimal structure fed to Viem when encoding (all bigint / hex, never number). */
interface CanonicalIntent {
  readonly type: EvmTransactionType;
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly gas: bigint;
  readonly data: string;
  readonly accessList: readonly EvmAccessListEntry[];
  readonly gasPrice?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
}

function requireFee(value: string | undefined, field: string): bigint {
  if (value === undefined) {
    throw new EvmCodecError('missing_fee_field', `${field} is required for this transaction type`, field);
  }
  return toBigIntField(value, field);
}

function rejectFee(value: string | undefined, field: string, type: EvmTransactionType): void {
  if (value !== undefined) {
    throw new EvmCodecError(
      'unexpected_fee_field',
      `${field} does not apply to ${type} transactions`,
      field,
    );
  }
}

function canonicalizeIntent(intent: EvmUnsignedIntent): CanonicalIntent {
  const type = intent.type ?? 'eip1559';
  if (type !== 'legacy' && type !== 'eip2930' && type !== 'eip1559') {
    throw new EvmCodecError(
      'unsupported_transaction_type',
      `M1 only supports legacy / eip2930 / eip1559, got ${String(intent.type)}`,
      'type',
    );
  }

  const chainId = toBigIntField(intent.chainId, 'chainId');
  const nonce = toBigIntField(intent.nonce, 'nonce');
  const value = toBigIntField(intent.value, 'value');
  const gas = toBigIntField(intent.gas, 'gas');
  const to = normalizeAddress(intent.to, 'to');
  const data = normalizeData(intent.data, 'data');
  const accessList = normalizeAccessList(intent.accessList);

  if (type === 'eip1559') {
    rejectFee(intent.gasPrice, 'gasPrice', type);
    const maxFeePerGas = requireFee(intent.maxFeePerGas, 'maxFeePerGas');
    const maxPriorityFeePerGas = requireFee(intent.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
    if (maxPriorityFeePerGas > maxFeePerGas) {
      throw new EvmCodecError(
        'invalid_fee_bounds',
        'maxPriorityFeePerGas must not exceed maxFeePerGas',
        'maxPriorityFeePerGas',
      );
    }
    return {
      type, chainId, nonce, to, value, gas, data, accessList, maxFeePerGas, maxPriorityFeePerGas,
    };
  }

  rejectFee(intent.maxFeePerGas, 'maxFeePerGas', type);
  rejectFee(intent.maxPriorityFeePerGas, 'maxPriorityFeePerGas', type);
  if (type === 'legacy' && accessList.length > 0) {
    throw new EvmCodecError('unexpected_fee_field', 'legacy transactions do not support accessList', 'accessList');
  }
  const gasPrice = requireFee(intent.gasPrice, 'gasPrice');
  return { type, chainId, nonce, to, value, gas, data, accessList, gasPrice };
}

/* ------------------------------------------------------------------ */
/* Encoding                                                                */
/* ------------------------------------------------------------------ */

/**
 * Serialize a native transfer / unsigned transaction with data.
 *
 * The returned `payload` goes straight to the external wallet for signing; `signingHash` lets the caller check what the wallet
 * shows as the signing object, but does **not** replace the wallet's own hash computation.
 */
export function encodeUnsignedTransaction(intent: EvmUnsignedIntent): EvmUnsignedPayload {
  const canonical = canonicalizeIntent(intent);

  // Viem's TypeScript declares chainId as number, but accepts bigint at runtime.
  // DFR policy forbids downgrading on-chain values to number, so an explicit assertion is made here at the viem boundary,
  // with golden-vector tests proving the runtime behavior matches expectations.
  const tx = {
    type: canonical.type,
    chainId: canonical.chainId,
    nonce: canonical.nonce,
    to: canonical.to,
    value: canonical.value,
    gas: canonical.gas,
    data: canonical.data,
    ...(canonical.accessList.length > 0 ? { accessList: canonical.accessList } : {}),
    ...(canonical.gasPrice !== undefined ? { gasPrice: canonical.gasPrice } : {}),
    ...(canonical.maxFeePerGas !== undefined ? { maxFeePerGas: canonical.maxFeePerGas } : {}),
    ...(canonical.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas: canonical.maxPriorityFeePerGas }
      : {}),
  };

  let payload: string;
  try {
    payload = serializeTransaction(
      tx as unknown as Parameters<typeof serializeTransaction>[0],
    ).toLowerCase();
  } catch (cause) {
    throw new EvmCodecError(
      'invalid_payload',
      `Failed to serialize transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return {
    payload,
    encoding: 'hex',
    type: canonical.type,
    chainId: toDecimal(canonical.chainId),
    nonce: toDecimal(canonical.nonce),
    signingHash: keccak256(payload as `0x${string}`),
  };
}

/* ------------------------------------------------------------------ */
/* Decoding                                                                */
/* ------------------------------------------------------------------ */

type RlpField = string | readonly RlpField[];

function asArray(fields: RlpField, type: EvmTransactionType): readonly RlpField[] {
  if (typeof fields === 'string') {
    throw new EvmCodecError('invalid_payload', `${type} payload must be an RLP list`);
  }
  return fields;
}

function asBytes(value: RlpField | undefined, label: string): string {
  if (typeof value !== 'string') {
    throw new EvmCodecError('invalid_payload', `${label} must be a byte string`);
  }
  return value.toLowerCase();
}

function asBigInt(value: RlpField | undefined, label: string): bigint {
  const hex = asBytes(value, label);
  try {
    return rlpToBigInt(hex);
  } catch {
    throw new EvmCodecError('invalid_payload', `${label} is not a valid integer encoding`);
  }
}

function decodeAccessList(value: RlpField | undefined): readonly EvmAccessListEntry[] {
  if (value === undefined || typeof value === 'string') {
    // An empty list is RLP-encoded as 0xc0, which fromRlp decodes to [], so a string here can only be invalid input.
    if (value === '0xc0') return [];
    throw new EvmCodecError('invalid_payload', 'accessList must be a list');
  }
  return value.map((entry) => {
    if (typeof entry === 'string' || entry.length !== 2) {
      throw new EvmCodecError('invalid_payload', 'accessList entries must be [address, storageKeys] two-element lists');
    }
    const address = asBytes(entry[0], 'accessList.address');
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw new EvmCodecError('invalid_payload', 'accessList.address must be a 20-byte address');
    }
    const keys = entry[1];
    if (keys === undefined || typeof keys === 'string') {
      throw new EvmCodecError('invalid_payload', 'accessList.storageKeys must be a list');
    }
    const storageKeys = keys.map((key) => asBytes(key, 'accessList.storageKeys'));
    if (storageKeys.some((key) => !/^0x[0-9a-f]{64}$/.test(key))) {
      throw new EvmCodecError('invalid_payload', 'accessList.storageKeys must be 32 bytes');
    }
    return { address, storageKeys };
  });
}

function emptyToNull(value: string): string | null {
  if (value === '0x') return null;
  if (!/^0x[0-9a-f]{40}$/.test(value)) {
    throw new EvmCodecError('invalid_payload', 'recipient address must be empty (contract creation) or exactly 20 bytes');
  }
  return value;
}

/**
 * Restore DFR domain fields from a serialized payload.
 *
 * Both signed and unsigned payloads can be parsed: `signed` is derived from the presence of signature fields, and `hash` is always
 * `keccak256(payload)` (the pre-signing hash when unsigned, the transaction hash when signed).
 */
export function decodeTransactionPayload(payload: string): EvmDecodedTransaction {
  if (typeof payload !== 'string' || !HEX_DATA_RE.test(payload) || payload === '0x') {
    throw new EvmCodecError('invalid_payload', 'payload must be 0x-prefixed hex with an even number of bytes');
  }

  const firstByte = Number.parseInt(payload.slice(2, 4), 16);

  let type: EvmTransactionType;
  let body = payload;
  if (firstByte === 0x01) {
    type = 'eip2930';
    body = `0x${payload.slice(4)}`;
  } else if (firstByte === 0x02) {
    type = 'eip1559';
    body = `0x${payload.slice(4)}`;
  } else if (firstByte <= 0x7f) {
    // 0x00 / 0x03…0x7f are not transaction types M1 supports (EIP-4844 / 7702 and others).
    throw new EvmCodecError(
      'unsupported_transaction_type',
      `Unsupported EVM transaction type prefix 0x${firstByte.toString(16).padStart(2, '0')}`,
    );
  } else {
    type = 'legacy';
  }

  let rlp: RlpField;
  try {
    rlp = fromRlp(body as `0x${string}`) as RlpField;
  } catch {
    throw new EvmCodecError('invalid_payload', 'payload is not valid RLP transaction encoding');
  }

  const fields = asArray(rlp, type);
  const hash = keccak256(payload as `0x${string}`);

  /* legacy: [nonce, gasPrice, gas, to, value, data, (chainId|v), (0|r), (0|s)] */
  if (type === 'legacy') {
    if (fields.length !== 6 && fields.length !== 9) {
      throw new EvmCodecError('invalid_payload', `invalid legacy payload field count: ${fields.length}`);
    }
    let chainId: DecimalUint | null = null;
    let signed = false;
    if (fields.length === 9) {
      const v = asBigInt(fields[6], 'v');
      const r = asBigInt(fields[7], 'r');
      const s = asBigInt(fields[8], 's');
      // Both signature scalars must be present; a half-zero payload is not a signed transaction.
      signed = r !== 0n && s !== 0n;
      // EIP-155: v = chainId * 2 + 35/36; pre-EIP-155 27/28 cannot derive a chainId.
      chainId = signed ? (v >= 35n ? toDecimal((v - 35n) / 2n) : null)
        : (v === 27n || v === 28n ? null : toDecimal(v));
    }
    return {
      type,
      chainId,
      nonce: toDecimal(asBigInt(fields[0], 'nonce')),
      to: emptyToNull(asBytes(fields[3], 'to')),
      value: toDecimal(asBigInt(fields[4], 'value')),
      data: asBytes(fields[5], 'data'),
      gas: toDecimal(asBigInt(fields[2], 'gas')),
      gasPrice: toDecimal(asBigInt(fields[1], 'gasPrice')),
      accessList: [],
      signed,
      hash,
    };
  }

  /* eip2930: [chainId, nonce, gasPrice, gas, to, value, data, accessList(, yParity, r, s)] */
  if (type === 'eip2930') {
    if (fields.length !== 8 && fields.length !== 11) {
      throw new EvmCodecError('invalid_payload', `invalid eip2930 payload field count: ${fields.length}`);
    }
    return {
      type,
      chainId: toDecimal(asBigInt(fields[0], 'chainId')),
      nonce: toDecimal(asBigInt(fields[1], 'nonce')),
      gasPrice: toDecimal(asBigInt(fields[2], 'gasPrice')),
      gas: toDecimal(asBigInt(fields[3], 'gas')),
      to: emptyToNull(asBytes(fields[4], 'to')),
      value: toDecimal(asBigInt(fields[5], 'value')),
      data: asBytes(fields[6], 'data'),
      accessList: decodeAccessList(fields[7]),
      signed: fields.length === 11 && asBigInt(fields[9], 'r') !== 0n && asBigInt(fields[10], 's') !== 0n,
      hash,
    };
  }

  /* eip1559: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList(, ...)] */
  if (fields.length !== 9 && fields.length !== 12) {
    throw new EvmCodecError('invalid_payload', `invalid eip1559 payload field count: ${fields.length}`);
  }
  return {
    type,
    chainId: toDecimal(asBigInt(fields[0], 'chainId')),
    nonce: toDecimal(asBigInt(fields[1], 'nonce')),
    maxPriorityFeePerGas: toDecimal(asBigInt(fields[2], 'maxPriorityFeePerGas')),
    maxFeePerGas: toDecimal(asBigInt(fields[3], 'maxFeePerGas')),
    gas: toDecimal(asBigInt(fields[4], 'gas')),
    to: emptyToNull(asBytes(fields[5], 'to')),
    value: toDecimal(asBigInt(fields[6], 'value')),
    data: asBytes(fields[7], 'data'),
    accessList: decodeAccessList(fields[8]),
    signed: fields.length === 12 && asBigInt(fields[10], 'r') !== 0n && asBigInt(fields[11], 's') !== 0n,
    hash,
  };
}

/* ------------------------------------------------------------------ */
/* Structural comparison                                                            */
/* ------------------------------------------------------------------ */

/** Normalized view for comparison: all lowercase hex + decimal strings. */
function canonicalView(tx: EvmDecodedTransaction): string {
  const accessList = tx.accessList.map((entry) => [entry.address, entry.storageKeys]);
  return JSON.stringify({
    type: tx.type,
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    value: tx.value,
    gas: tx.gas,
    data: tx.data,
    gasPrice: tx.gasPrice ?? null,
    maxFeePerGas: tx.maxFeePerGas ?? null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
    accessList,
  });
}

/**
 * Verify the payload matches the original unsigned intent field by field.
 *
 * ADR-016 §7 requires comparing the re-parsed payload against the original intent before broadcast; this function is the pure-function core of that check,
 * rejecting on any field mismatch (chainId / nonce / to / value / gas / data / fee / accessList).
 * Signatures are not compared: `signed` and `hash` are properties of the payload itself, not of the intent.
 */
export function assertDecodedMatchesIntent(
  decoded: EvmDecodedTransaction,
  intent: EvmUnsignedIntent,
): void {
  const expected = encodeUnsignedTransaction(intent);
  const expectedDecoded = decodeTransactionPayload(expected.payload);
  if (canonicalView(decoded) !== canonicalView(expectedDecoded)) {
    throw new EvmCodecError(
      'intent_mismatch',
      'payload fields do not match the original unsigned transaction intent',
    );
  }
}
