/**
 * Solana transaction codec pure functions (DFR-M3-A02).
 *
 * Authoritative sources: ADR-028 (supply chain), ADR-032 (blockhash is the sequencing prerequisite),
 * `docs/architecture/adapter-spec-v0.1.md` §8.2, and the EVM version `adapters/evm/src/transaction-codec.ts`.
 *
 * Design constraints (isomorphic with the EVM codec):
 *   1. **Zero new dependencies** (ADR-028): no `@solana/web3.js`. This only encodes/decodes legacy / v0
 *      message binaries, using the repo's existing base58 utilities; no ed25519, no RPC.
 *   2. **All values are decimal strings / bytes**: no JS `number` as an amount or height;
 *      compact-u16 is only used for "counts", which are necessarily small, with no numeric semantics.
 *   3. **Input validation fails closed**: invalid base64 / base58, wrong lengths, out-of-bounds account indexes,
 *      and unsupported versions all throw `SolanaCodecError`, never silently corrected.
 *   4. Pure functions: no network requests, no private-key reads, no endpoints or credentials held.
 *
 * Boundary: this module only encodes/decodes and compares structure; it does **not** select Providers, write to databases, or decide transaction state.
 * Address table lookup needs chain access (to resolve ALT accounts); this card rejects it fail-closed, leaving it for later.
 */

import { base58Decode, base58Encode } from './base58.js';

/** Supported message versions (ADR-032 / Solana transaction format). */
export type SolanaTransactionVersion = 'legacy' | 'v0';

/** Stable failure reason codes; the Adapter normalizes them into public DFR errors. */
export type SolanaCodecErrorReason =
  | 'invalid_base64'
  | 'invalid_base58'
  | 'invalid_address'
  | 'invalid_blockhash'
  | 'invalid_hex_data'
  | 'unsupported_version'
  | 'invalid_payload'
  | 'truncated'
  | 'invalid_compact_u16'
  | 'invalid_header'
  | 'account_index_out_of_range'
  | 'too_many_accounts'
  | 'address_table_lookup_unsupported'
  | 'intent_mismatch';

export class SolanaCodecError extends Error {
  override readonly name = 'SolanaCodecError';
  readonly reason: SolanaCodecErrorReason;
  readonly field?: string;

  constructor(reason: SolanaCodecErrorReason, message: string, field?: string) {
    super(message);
    this.reason = reason;
    if (field !== undefined) this.field = field;
  }
}

/** Byte length of a 32-byte public key / blockhash. */
const PUBKEY_BYTES = 32;
/** 64-byte ed25519 signature. */
const SIGNATURE_BYTES = 64;
/** Legacy message header length. */
const HEADER_BYTES = 3;
/** Account key indexes are u8, so at most 256. */
const MAX_ACCOUNTS = 256;
/** v0 version prefix: the first byte's high bit is set, the low 7 bits are the version number. */
const VERSION_PREFIX = 0x80;
const V0 = 0;

/**
 * An account's role within one instruction (decides the header and account ordering).
 *
 * Aligned with Solana `AccountMeta`; this is the minimum information for building a valid message — without it, there is no way to derive
 * the header's three counts or determine the account order.
 */
export interface SolanaAccountMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface SolanaInstructionIntent {
  readonly programId: string;
  readonly accounts?: readonly SolanaAccountMeta[];
  /** Instruction data; base64 (omitting it is equivalent to empty data). */
  readonly data?: string;
}

/** Unsigned transaction intent. `feePayer` is always the first signer (Solana rule). */
export interface SolanaUnsignedIntent {
  readonly feePayer: string;
  readonly blockhash: string;
  readonly instructions: readonly SolanaInstructionIntent[];
  /** Defaults to `legacy`; `v0` writes the version prefix and appends an empty ALT lookup section. */
  readonly version?: SolanaTransactionVersion;
}

/** Compiled message (bytes an external wallet can sign). */
export interface SolanaCompiledMessage {
  readonly version: SolanaTransactionVersion;
  /** Message bytes (= the part to be signed). */
  readonly messageBytes: Uint8Array;
  readonly accountKeys: readonly string[];
  readonly header: SolanaMessageHeader;
  readonly recentBlockhash: string;
  readonly numRequiredSignatures: number;
}

export interface SolanaMessageHeader {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
}

/** Decoded transaction (from an unsigned or signed payload). */
export interface SolanaDecodedTransaction {
  readonly version: SolanaTransactionVersion;
  readonly signed: boolean;
  /** Base58 form of the signature (64 bytes); the base58 of 64 zero bytes when unsigned. Transaction hash = signature 0. */
  readonly signatures: readonly string[];
  /** Account table (including program ids); order matches the message. */
  readonly accountKeys: readonly string[];
  readonly header: SolanaMessageHeader;
  readonly recentBlockhash: string;
  readonly instructions: readonly SolanaDecodedInstruction[];
  /** Non-empty means an ALT lookup is present (fail-closed in this card, so it never appears). */
  readonly addressTableLookups: number;
}

export interface SolanaDecodedInstruction {
  readonly programIdIndex: number;
  readonly programId: string;
  readonly accountIndices: readonly number[];
  /** Base64-encoded instruction data. */
  readonly data: string;
}

/* ------------------------------------------------------------------ */
/* base64 (Node Buffer)                                               */
/* ------------------------------------------------------------------ */

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(value: string, field: string): Uint8Array {
  // Buffer is lenient with invalid base64 (it drops invalid characters), so a round-trip re-encode check is required;
  // otherwise garbage input would be silently accepted. Equivalent trailing-padding spellings are allowed.
  const canonical = (text: string): string => text.replace(/=+$/u, '');
  const buf = Buffer.from(value, 'base64');
  if (canonical(buf.toString('base64')) !== canonical(value)) {
    throw new SolanaCodecError('invalid_base64', `not valid base64: ${field}`, field);
  }
  return Uint8Array.from(buf);
}

/* ------------------------------------------------------------------ */
/* compact-u16 (Solana variable-length count)                                      */
/* ------------------------------------------------------------------ */

function encodeCompactU16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new SolanaCodecError('invalid_compact_u16', `compact-u16 out of bounds: ${value}`);
  }
  if (value < 0x80) return Uint8Array.from([value]);
  if (value < 0x4000) {
    return Uint8Array.from([(value & 0x7f) | 0x80, (value >> 7) & 0xff]);
  }
  return Uint8Array.from([(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, (value >> 14) & 0xff]);
}

function decodeCompactU16(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let index = 0; index < 3; index += 1) {
    if (cursor >= bytes.length) {
      throw new SolanaCodecError('truncated', 'compact-u16 read out of bounds');
    }
    const byte = bytes[cursor]!;
    value |= (byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  throw new SolanaCodecError('invalid_compact_u16', 'compact-u16 exceeds 3 bytes');
}

/* ------------------------------------------------------------------ */
/* base58 <-> fixed-length bytes                                                 */
/* ------------------------------------------------------------------ */

function decodeFixed(value: string, size: number, reason: 'invalid_address' | 'invalid_blockhash', field: string): Uint8Array {
  if (value.length === 0) {
    throw new SolanaCodecError(reason, `${field} must not be empty`, field);
  }
  const bytes = base58Decode(value);
  if (bytes === null || bytes.length !== size) {
    throw new SolanaCodecError(reason, `${field} is not valid base58 / ${size} bytes`, field);
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Message compilation                                                        */
/* ------------------------------------------------------------------ */

interface AccountEntry {
  readonly pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
  /** Whether it is a program id (non-signing, read-only, must sort into the read-only non-signer group). */
  isProgramId: boolean;
}

/**
 * Collect and normalize the account table.
 *
 * Solana rule: signers first (fee payer must be first), then writable non-signers,
 * finally read-only non-signers (program ids belong here). The same pubkey is merged, with permissions taken as the "union"
 * (if any instruction requires writable/signer, the account is writable/a signer overall).
 */
function collectAccounts(intent: SolanaUnsignedIntent): AccountEntry[] {
  const map = new Map<string, AccountEntry>();
  const ensure = (pubkey: string): AccountEntry => {
    const existing = map.get(pubkey);
    if (existing !== undefined) return existing;
    const created: AccountEntry = { pubkey, isSigner: false, isWritable: false, isProgramId: false };
    map.set(pubkey, created);
    return created;
  };

  // fee payer: must be a signer and writable (it pays the fees).
  const payer = ensure(intent.feePayer);
  payer.isSigner = true;
  payer.isWritable = true;

  for (const instruction of intent.instructions) {
    for (const meta of instruction.accounts ?? []) {
      const entry = ensure(meta.pubkey);
      if (meta.isSigner) entry.isSigner = true;
      if (meta.isWritable) entry.isWritable = true;
    }
    ensure(instruction.programId).isProgramId = true;
  }

  return [...map.values()];
}

function orderAccounts(entries: readonly AccountEntry[], feePayer: string): AccountEntry[] {
  const signers = entries.filter((e) => e.isSigner);
  // fee payer must sort first (Solana rule); other signers: writable before read-only.
  signers.sort((a, b) => {
    if (a.pubkey === feePayer) return -1;
    if (b.pubkey === feePayer) return 1;
    return Number(b.isWritable) - Number(a.isWritable);
  });
  const writableNonSigners = entries.filter((e) => !e.isSigner && e.isWritable);
  const readonlyNonSigners = entries.filter((e) => !e.isSigner && !e.isWritable);
  return [...signers, ...writableNonSigners, ...readonlyNonSigners];
}

export function compileMessage(intent: SolanaUnsignedIntent): SolanaCompiledMessage {
  const version = intent.version ?? 'legacy';
  if (version !== 'legacy' && version !== 'v0') {
    throw new SolanaCodecError('unsupported_version', `Unsupported message version: ${String(version)}`);
  }
  if (intent.instructions.length > 0xffff) {
    throw new SolanaCodecError('invalid_payload', 'instruction count exceeds the compact-u16 limit');
  }

  const ordered = orderAccounts(collectAccounts(intent), intent.feePayer);
  if (ordered.length > MAX_ACCOUNTS) {
    throw new SolanaCodecError('too_many_accounts', `account count ${ordered.length} exceeds ${MAX_ACCOUNTS}`);
  }
  const indexOf = new Map(ordered.map((entry, index) => [entry.pubkey, index]));

  const numRequiredSignatures = ordered.filter((e) => e.isSigner).length;
  const readonlySigned = ordered.slice(0, numRequiredSignatures).filter((e) => !e.isWritable).length;
  const readonlyUnsigned = ordered.slice(numRequiredSignatures).filter((e) => !e.isWritable).length;
  const header: SolanaMessageHeader = {
    numRequiredSignatures,
    numReadonlySignedAccounts: readonlySigned,
    numReadonlyUnsignedAccounts: readonlyUnsigned,
  };

  const chunks: Uint8Array[] = [];
  if (version === 'v0') chunks.push(Uint8Array.from([VERSION_PREFIX | V0]));
  chunks.push(Uint8Array.from([numRequiredSignatures, readonlySigned, readonlyUnsigned]));
  chunks.push(encodeCompactU16(ordered.length));
  for (const entry of ordered) {
    chunks.push(decodeFixed(entry.pubkey, PUBKEY_BYTES, 'invalid_address', 'accountKeys'));
  }
  chunks.push(decodeFixed(intent.blockhash, PUBKEY_BYTES, 'invalid_blockhash', 'recentBlockhash'));
  chunks.push(encodeCompactU16(intent.instructions.length));
  for (const instruction of intent.instructions) {
    const programIndex = indexOf.get(instruction.programId);
    if (programIndex === undefined) {
      throw new SolanaCodecError('invalid_payload', 'instruction programId is not in the account table');
    }
    const accounts = instruction.accounts ?? [];
    chunks.push(Uint8Array.from([programIndex]));
    chunks.push(encodeCompactU16(accounts.length));
    for (const meta of accounts) {
      const index = indexOf.get(meta.pubkey);
      if (index === undefined) {
        throw new SolanaCodecError('invalid_payload', 'instruction account is not in the account table');
      }
      chunks.push(Uint8Array.from([index]));
    }
    const data = instruction.data === undefined ? new Uint8Array() : fromBase64(instruction.data, 'instruction.data');
    chunks.push(encodeCompactU16(data.length));
    chunks.push(data);
  }
  // v0 must carry an address table lookup section; this card only produces an **empty** lookup.
  if (version === 'v0') chunks.push(encodeCompactU16(0));

  return {
    version,
    messageBytes: concat(chunks),
    accountKeys: ordered.map((e) => e.pubkey),
    header,
    recentBlockhash: intent.blockhash,
    numRequiredSignatures,
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Produce an unsigned transaction payload: a complete transaction **with signature slots** (signatures are 64 zero bytes).
 *
 * Why not a bare message: an external wallet may accept a complete transaction (Web3.js
 * `serialize({ requireAllSignatures: false })` form) and also needs the exact message bytes;
 * a complete transaction with zero slots covers both (strip the signature prefix to get the message).
 */
export function encodeUnsignedTransaction(intent: SolanaUnsignedIntent): {
  readonly payload: string;
  readonly encoding: 'base64';
  readonly message: SolanaCompiledMessage;
} {
  const message = compileMessage(intent);
  const prefix = concat([
    encodeCompactU16(message.numRequiredSignatures),
    ...Array.from({ length: message.numRequiredSignatures }, () => new Uint8Array(SIGNATURE_BYTES)),
  ]);
  const payload = concat([prefix, message.messageBytes]);
  return { payload: toBase64(payload), encoding: 'base64', message };
}

/** Strip the signature section from a complete transaction payload, returning the message bytes and whether it is signed. */
export function splitSignatures(payload: Uint8Array): {
  readonly signatures: readonly Uint8Array[];
  readonly messageBytes: Uint8Array;
} {
  const count = decodeCompactU16(payload, 0);
  let offset = count.next;
  const signatures: Uint8Array[] = [];
  for (let index = 0; index < count.value; index += 1) {
    if (offset + SIGNATURE_BYTES > payload.length) {
      throw new SolanaCodecError('truncated', 'signature section out of bounds');
    }
    signatures.push(payload.slice(offset, offset + SIGNATURE_BYTES));
    offset += SIGNATURE_BYTES;
  }
  return { signatures, messageBytes: payload.slice(offset) };
}

/** Decode a complete transaction payload (unsigned or signed). */
export function decodeTransactionPayload(payload: string): SolanaDecodedTransaction {
  const bytes = fromBase64(payload, 'payload');
  if (bytes.length === 0) {
    throw new SolanaCodecError('invalid_payload', 'payload is empty');
  }
  const { signatures, messageBytes } = splitSignatures(bytes);
  const message = decodeMessage(messageBytes);
  if (signatures.length !== message.header.numRequiredSignatures) {
    throw new SolanaCodecError(
      'invalid_header',
      `signature count ${signatures.length} does not match the ${message.header.numRequiredSignatures} required by the header`,
    );
  }
  // SOL-01: every required signature slot must be populated. A nonzero
  // co-signer slot must never mask a missing fee-payer signature (slot 0).
  // This checks presence only; Ed25519 validity remains a chain-side check.
  const signed = signatures.length > 0 && signatures.every((sig) => sig.some((byte) => byte !== 0));
  return {
    version: message.version,
    signed,
    signatures: signatures.map((sig) => base58Encode(sig)),
    accountKeys: message.accountKeys,
    header: message.header,
    recentBlockhash: message.recentBlockhash,
    instructions: message.instructions,
    addressTableLookups: message.addressTableLookups,
  };
}

/** Decode message bytes (without the signature section). */
export function decodeMessage(bytes: Uint8Array): {
  readonly version: SolanaTransactionVersion;
  readonly accountKeys: readonly string[];
  readonly header: SolanaMessageHeader;
  readonly recentBlockhash: string;
  readonly instructions: readonly SolanaDecodedInstruction[];
  readonly addressTableLookups: number;
} {
  let offset = 0;
  let version: SolanaTransactionVersion = 'legacy';
  const first = bytes[0];
  if (first === undefined) throw new SolanaCodecError('truncated', 'message is empty');
  if ((first & VERSION_PREFIX) !== 0) {
    const versionNumber = first & 0x7f;
    if (versionNumber !== V0) {
      throw new SolanaCodecError('unsupported_version', `Unsupported message version number: ${versionNumber}`);
    }
    version = 'v0';
    offset = 1;
  }
  if (offset + HEADER_BYTES > bytes.length) {
    throw new SolanaCodecError('truncated', 'header out of bounds');
  }
  const numRequiredSignatures = bytes[offset]!;
  const numReadonlySignedAccounts = bytes[offset + 1]!;
  const numReadonlyUnsignedAccounts = bytes[offset + 2]!;
  offset += HEADER_BYTES;
  if (numReadonlySignedAccounts > numRequiredSignatures) {
    throw new SolanaCodecError('invalid_header', 'read-only signer count must not exceed signer count');
  }

  const accountCount = decodeCompactU16(bytes, offset);
  offset = accountCount.next;
  if (accountCount.value === 0 || accountCount.value > MAX_ACCOUNTS) {
    throw new SolanaCodecError('too_many_accounts', `invalid account count: ${accountCount.value}`);
  }
  const accountKeys: string[] = [];
  for (let index = 0; index < accountCount.value; index += 1) {
    if (offset + PUBKEY_BYTES > bytes.length) {
      throw new SolanaCodecError('truncated', 'account keys out of bounds');
    }
    accountKeys.push(base58Encode(bytes.slice(offset, offset + PUBKEY_BYTES)));
    offset += PUBKEY_BYTES;
  }

  if (offset + PUBKEY_BYTES > bytes.length) {
    throw new SolanaCodecError('truncated', 'recent blockhash out of bounds');
  }
  const recentBlockhash = base58Encode(bytes.slice(offset, offset + PUBKEY_BYTES));
  offset += PUBKEY_BYTES;

  const instructionCount = decodeCompactU16(bytes, offset);
  offset = instructionCount.next;
  // First **parse the structure** (skip instructions, collect indexes), deferring index bounds checks:
  // a v0 account index may reference accounts loaded by an address table lookup, and the lookup section comes
  // after the instruction section. The lookup count must be read first to tell whether an "out-of-bounds index" is an error or ALT semantics.
  const rawInstructions: Array<{
    programIdIndex: number;
    accountIndices: number[];
    data: string;
  }> = [];
  for (let index = 0; index < instructionCount.value; index += 1) {
    if (offset >= bytes.length) {
      throw new SolanaCodecError('truncated', 'instruction out of bounds');
    }
    const programIdIndex = bytes[offset]!;
    offset += 1;
    const accountIndexCount = decodeCompactU16(bytes, offset);
    offset = accountIndexCount.next;
    const accountIndices: number[] = [];
    for (let accountIndex = 0; accountIndex < accountIndexCount.value; accountIndex += 1) {
      if (offset >= bytes.length) {
        throw new SolanaCodecError('truncated', 'instruction account index out of bounds');
      }
      accountIndices.push(bytes[offset]!);
      offset += 1;
    }
    const dataLength = decodeCompactU16(bytes, offset);
    offset = dataLength.next;
    if (offset + dataLength.value > bytes.length) {
      throw new SolanaCodecError('truncated', 'instruction data out of bounds');
    }
    const data = toBase64(bytes.slice(offset, offset + dataLength.value));
    offset += dataLength.value;
    rawInstructions.push({ programIdIndex, accountIndices, data });
  }

  let addressTableLookups = 0;
  if (version === 'v0') {
    const lookups = decodeCompactU16(bytes, offset);
    offset = lookups.next;
    addressTableLookups = lookups.value;
    if (addressTableLookups > 0) {
      // Resolving ALT needs extra account-table data (chain access); this card does not do it, rejecting explicitly instead of pretending to succeed.
      throw new SolanaCodecError(
        'address_table_lookup_unsupported',
        'v0 transactions with an address table lookup need on-chain account-table resolution; M3-A02 does not support it',
      );
    }
  }
  if (offset !== bytes.length) {
    throw new SolanaCodecError('invalid_payload', `message has ${bytes.length - offset} trailing extra bytes`);
  }

  // By this point there is known to be no ALT: every index must fall inside the static account table.
  const instructions: SolanaDecodedInstruction[] = rawInstructions.map((raw) => {
    if (raw.programIdIndex >= accountKeys.length) {
      throw new SolanaCodecError(
        'account_index_out_of_range',
        `programIdIndex out of bounds: ${raw.programIdIndex}`,
      );
    }
    for (const accountIndex of raw.accountIndices) {
      if (accountIndex >= accountKeys.length) {
        throw new SolanaCodecError(
          'account_index_out_of_range',
          `instruction account index out of bounds: ${accountIndex}`,
        );
      }
    }
    return {
      programIdIndex: raw.programIdIndex,
      programId: accountKeys[raw.programIdIndex]!,
      accountIndices: raw.accountIndices,
      data: raw.data,
    };
  });

  return {
    version,
    accountKeys,
    header: { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts },
    recentBlockhash,
    instructions,
    addressTableLookups,
  };
}

/** hex → bytes (EVM-style callers occasionally pass hex; Solana instruction data uses base64). */
export function hexToBytes(value: string, field: string): Uint8Array {
  if (!/^(?:0x)?[0-9a-fA-F]*$/u.test(value)) {
    throw new SolanaCodecError('invalid_hex_data', `not valid hex: ${field}`, field);
  }
  const body = value.startsWith('0x') ? value.slice(2) : value;
  if (body.length % 2 !== 0) {
    throw new SolanaCodecError('invalid_hex_data', `hex length is odd: ${field}`, field);
  }
  const out = new Uint8Array(body.length / 2);
  for (let index = 0; index < body.length; index += 2) {
    out[index / 2] = Number.parseInt(body.slice(index, index + 2), 16);
  }
  return out;
}
