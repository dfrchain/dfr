/**
 * Solana transaction codec tests (DFR-M3-A02).
 *
 * Authoritative sources: ADR-028 (zero new dependencies), ADR-032, adapter-spec §8.2.
 *
 * Verification methods, isomorphic with the EVM codec:
 *   1. Rebuild key bytes with an **independent** minimal reference implementation (without calling the function under test), avoiding "proving itself";
 *   2. Codec round-trips (fields match after encode → decode);
 *   3. Public spec vectors (Solana's message format is defined by the official SDK; hand-computed vectors pin it here);
 *   4. Fail-closed negative controls (invalid base64/base58/lengths/account indexes/versions).
 */
import { describe, expect, it } from 'vitest';
import {
  SolanaCodecError,
  SolanaBindingError,
  bindSignedTransaction,
  base58Decode,
  base58Encode,
  compileMessage,
  decodeMessage,
  decodeTransactionPayload,
  encodeUnsignedTransaction,
  hexToBytes,
  splitSignatures,
} from '@dfr/adapter-solana';

/* ------------------------------------------------------------------ */
/* Independent reference: hand-written base58 encoding and compact-u16, unrelated to the implementation under test      */
/* ------------------------------------------------------------------ */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function refBase58(bytes: readonly number[]): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)]! + out;
    num /= 58n;
  }
  let zeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    zeros += 1;
  }
  return '1'.repeat(zeros) + out;
}

function refCompactU16(value: number): number[] {
  if (value < 0x80) return [value];
  if (value < 0x4000) return [(value & 0x7f) | 0x80, value >> 7];
  return [(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, value >> 14];
}

/** Deterministically filled 32-byte public key (valid base58; not any real account). */
function pubkey(seed: number): string {
  const bytes = Array.from({ length: 32 }, (_, index) => (seed * 7 + index * 13 + 1) & 0xff);
  return refBase58(bytes);
}

const FEE_PAYER = pubkey(1);
const ALICE = pubkey(2);
const PROGRAM = pubkey(9);
const BLOCKHASH = refBase58(Array.from({ length: 32 }, (_, index) => (index * 3 + 5) & 0xff));

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** A minimal transfer: fee payer signature + one writable recipient account + system program. */
const transferIntent = {
  feePayer: FEE_PAYER,
  blockhash: BLOCKHASH,
  instructions: [
    {
      programId: SYSTEM_PROGRAM,
      accounts: [{ pubkey: FEE_PAYER, isSigner: true, isWritable: true }, { pubkey: ALICE, isSigner: false, isWritable: true }],
      data: Buffer.from([2, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0]).toString('base64'),
    },
  ],
} as const;

describe('base58 codec (ADR-028 zero dependencies)', () => {
  it('encoding matches the independent reference and inverts decoding', () => {
    // The empty-string case is explicitly returned as null by base58Decode (following the existing M2 convention), so only non-empty strings are tested here.
    for (const bytes of [[0], [0, 0, 0, 0], [104, 101, 108, 108, 111], [255, 254, 253], [1, 2, 3, 4, 5, 6, 7, 8]]) {
      const encoded = base58Encode(Uint8Array.from(bytes));
      expect(encoded).toBe(refBase58(bytes));
      expect([...base58Decode(encoded)!]).toEqual(bytes);
    }
  });

  it('all-zero bytes are handled as leading "1"s (32 zero bytes = 32 "1"s)', () => {
    const zeros = new Uint8Array(32);
    expect(base58Encode(zeros)).toBe('1'.repeat(32));
    expect([...base58Decode('1'.repeat(32))!]).toEqual([...zeros]);
    // The system program address is exactly 32 zero bytes.
    expect(SYSTEM_PROGRAM).toBe('1'.repeat(32));
  });
});

describe('legacy message compilation (public format, independent reconstruction)', () => {
  it('header / account table / blockhash / instruction section match the hand-built reconstruction byte for byte', () => {
    const compiled = compileMessage(transferIntent);

    // Independently rebuild the expected bytes.
    const accountKeys = [FEE_PAYER, ALICE, SYSTEM_PROGRAM];
    const expected = Uint8Array.from([
      1, // numRequiredSignatures
      0, // numReadonlySignedAccounts
      1, // numReadonlyUnsignedAccounts (system program is read-only non-signer)
      ...refCompactU16(accountKeys.length),
      ...accountKeys.flatMap((key) => [...base58Decode(key)!]),
      ...base58Decode(BLOCKHASH)!,
      ...refCompactU16(1), // one instruction
      2, // programIdIndex = system program is 2nd in the table
      ...refCompactU16(2), // two accounts
      0,
      1,
      ...refCompactU16(12), // data length
      2, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0,
    ]);

    expect([...compiled.messageBytes]).toEqual([...expected]);
    expect(compiled.version).toBe('legacy');
    expect(compiled.accountKeys).toEqual(accountKeys);
    expect(compiled.recentBlockhash).toBe(BLOCKHASH);
    expect(compiled.numRequiredSignatures).toBe(1);
  });

  it('fee payer is always first in the account table and marked as a signer', () => {
    const compiled = compileMessage({
      ...transferIntent,
      instructions: [
        { programId: PROGRAM, accounts: [{ pubkey: ALICE, isSigner: false, isWritable: false }] },
      ],
    });
    expect(compiled.accountKeys[0]).toBe(FEE_PAYER);
    expect(compiled.header.numRequiredSignatures).toBe(1);
  });

  it('the same pubkey merges across instructions, permissions take the union (writable wins)', () => {
    const compiled = compileMessage({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [
        { programId: PROGRAM, accounts: [{ pubkey: ALICE, isSigner: false, isWritable: false }] },
        { programId: PROGRAM, accounts: [{ pubkey: ALICE, isSigner: false, isWritable: true }] },
      ],
    });
    // ALICE appears only once, in the writable non-signer group.
    expect(compiled.accountKeys.filter((key) => key === ALICE)).toHaveLength(1);
    const aliceIndex = compiled.accountKeys.indexOf(ALICE);
    expect(aliceIndex).toBe(compiled.header.numRequiredSignatures);
  });
});

describe('v0 message (with version prefix and empty ALT section)', () => {
  it('v0 first byte carries the version prefix, the end has an empty lookup count', () => {
    const compiled = compileMessage({ ...transferIntent, version: 'v0' });
    expect(compiled.messageBytes[0]).toBe(0x80); // VERSION_PREFIX | 0
    expect(compiled.version).toBe('v0');
    // The header starts at byte 1.
    expect(compiled.messageBytes[1]).toBe(1);
    // The end is compact-u16(0).
    expect(compiled.messageBytes[compiled.messageBytes.length - 1]).toBe(0);

    const decoded = decodeMessage(compiled.messageBytes);
    expect(decoded.version).toBe('v0');
    expect(decoded.addressTableLookups).toBe(0);
    expect(decoded.accountKeys).toEqual(compiled.accountKeys);
  });
});

describe('Codec round-trips', () => {
  it('legacy: accounts/blockhash/instructions match after encode → decode, and it is judged unsigned', () => {
    const { payload, encoding } = encodeUnsignedTransaction(transferIntent);
    expect(encoding).toBe('base64');

    const decoded = decodeTransactionPayload(payload);
    expect(decoded.version).toBe('legacy');
    expect(decoded.signed).toBe(false);
    expect(decoded.accountKeys).toEqual(compileMessage(transferIntent).accountKeys);
    expect(decoded.recentBlockhash).toBe(BLOCKHASH);
    expect(decoded.instructions).toHaveLength(1);
    const instruction = decoded.instructions[0]!;
    expect(instruction.programId).toBe(SYSTEM_PROGRAM);
    expect(instruction.accountIndices).toEqual([0, 1]);
    expect(Buffer.from(instruction.data, 'base64')).toEqual(
      Buffer.from([2, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0]),
    );
  });

  it('v0: round-trip is consistent', () => {
    const { payload } = encodeUnsignedTransaction({ ...transferIntent, version: 'v0' });
    const decoded = decodeTransactionPayload(payload);
    expect(decoded.version).toBe('v0');
    expect(decoded.signed).toBe(false);
  });

  it('multiple signers: signature slot count equals the header requirement, and order is stable', () => {
    const { payload, message } = encodeUnsignedTransaction({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [
        {
          programId: PROGRAM,
          accounts: [
            { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
            { pubkey: ALICE, isSigner: true, isWritable: false },
          ],
        },
      ],
    });
    expect(message.numRequiredSignatures).toBe(2);
    const { signatures, messageBytes } = splitSignatures(Buffer.from(payload, 'base64'));
    expect(signatures).toHaveLength(2);
    expect([...messageBytes]).toEqual([...message.messageBytes]);
  });

  it('SOL-01: fee payer unsigned while the second signature slot is non-zero; the whole transaction must be judged unsigned', () => {
    const { payload } = encodeUnsignedTransaction({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [{
        programId: PROGRAM,
        accounts: [
          { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
          { pubkey: ALICE, isSigner: true, isWritable: false },
        ],
      }],
    });
    const bytes = Buffer.from(payload, 'base64');
    expect(bytes[0]).toBe(2);
    bytes[1 + 64] = 0x42; // The second signature slot is non-zero; slot 0's 64 bytes are still all zero.
    const partiallySigned = bytes.toString('base64');
    expect(decodeTransactionPayload(partiallySigned).signed).toBe(false);
    expect(() => bindSignedTransaction(partiallySigned, {
      from: FEE_PAYER,
      unsignedPayload: payload,
      expectedHash: base58Encode(new Uint8Array(64)),
    })).toThrowError(SolanaBindingError);
  });

  it('SOL-01: fee payer signed but another required signature slot is missing; still must not broadcast', () => {
    const { payload } = encodeUnsignedTransaction({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [{
        programId: PROGRAM,
        accounts: [
          { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
          { pubkey: ALICE, isSigner: true, isWritable: false },
        ],
      }],
    });
    const bytes = Buffer.from(payload, 'base64');
    bytes[1] = 0x42; // The fee payer slot is non-zero; the second signature slot is still all zero.
    expect(decodeTransactionPayload(bytes.toString('base64')).signed).toBe(false);
  });

  it('SOL-01: when all required slots have non-zero bytes, that only proves the slots are filled, not that signature verification is correct', () => {
    const { payload } = encodeUnsignedTransaction({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [{
        programId: PROGRAM,
        accounts: [
          { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
          { pubkey: ALICE, isSigner: true, isWritable: false },
        ],
      }],
    });
    const bytes = Buffer.from(payload, 'base64');
    bytes[1] = 0x11;
    bytes[1 + 64] = 0x22;
    // This is a signature-presence test: these arbitrary bytes are NOT real Ed25519 signatures.
    expect(decodeTransactionPayload(bytes.toString('base64')).signed).toBe(true);
  });

  it('a signed payload (non-zero signature) is recognized as signed=true', () => {
    const { payload } = encodeUnsignedTransaction(transferIntent);
    const bytes = Buffer.from(payload, 'base64');
    // Change the first signature's first byte to non-zero, simulating an external wallet having signed.
    bytes[1] = 0x7f;
    const decoded = decodeTransactionPayload(bytes.toString('base64'));
    expect(decoded.signed).toBe(true);
  });
});

describe('fail-closed negative controls', () => {
  it('rejects non-base64 payloads', () => {
    expect(() => decodeTransactionPayload('not base64!!!')).toThrow(SolanaCodecError);
  });

  it('rejects non-base58 / wrong-length addresses and blockhashes', () => {
    expect(() =>
      compileMessage({ ...transferIntent, feePayer: '0invalid' }),
    ).toThrow(/base58|32/u);
    expect(() =>
      compileMessage({ ...transferIntent, blockhash: base58Encode(Uint8Array.from([1, 2, 3])) }),
    ).toThrow(SolanaCodecError);
  });

  it('rejects unsupported message version numbers (version prefixes above v0)', () => {
    const bogus = Uint8Array.from([0x80 | 1, 1, 0, 0]);
    expect(() => decodeMessage(bogus)).toThrow(/version/i);
  });

  it('rejects out-of-bounds programId and account indexes', () => {
    // Hand-built: 1 account in the table, but programIdIndex = 5.
    const message = Uint8Array.from([
      1, 0, 0,
      ...refCompactU16(1),
      ...base58Decode(FEE_PAYER)!,
      ...base58Decode(BLOCKHASH)!,
      ...refCompactU16(1), // one instruction
      5, // programIdIndex out of bounds
      ...refCompactU16(0),
      ...refCompactU16(0),
    ]);
    expect(() => decodeMessage(message)).toThrow(/out of bounds/);
  });

  it('rejects insufficient length (truncated)', () => {
    expect(() => decodeMessage(Uint8Array.from([1, 0]))).toThrow(SolanaCodecError);
  });

  it('rejects trailing extra bytes (silent ignoring not allowed)', () => {
    const compiled = compileMessage(transferIntent);
    const withTrailer = Uint8Array.from([...compiled.messageBytes, 99]);
    expect(() => decodeMessage(withTrailer)).toThrow(/extra/);
  });

  it('v0 with an ALT lookup section → explicit rejection (needs on-chain account-table resolution)', () => {
    const compiled = compileMessage({ ...transferIntent, version: 'v0' });
    // Change the trailing compact-u16(0) to compact-u16(1), simulating one lookup.
    const bytes = Uint8Array.from(compiled.messageBytes);
    bytes[bytes.length - 1] = 1;
    expect(() => decodeMessage(bytes)).toThrow(/address table lookup/u);
  });

  it('hexToBytes validates invalid/odd lengths', () => {
    expect([...hexToBytes('0xdeadbeef', 'data')]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(() => hexToBytes('0xabc', 'data')).toThrow(/odd/);
    expect(() => hexToBytes('0xzz', 'data')).toThrow(/hex/u);
  });
});
