/**
 * Minimal base58 codec (Bitcoin/Solana alphabet), zero dependencies (ADR-028).
 *
 * BigInt accumulate/modulo: straightforward implementation with clear boundaries; addresses/signatures/block hashes are all short, so performance does not matter.
 * Encode/decode existing as a pair is an M3-A02 requirement: codec round-trips are the main verification method.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX: ReadonlyMap<string, number> = new Map(
  ALPHABET.split('').map((char, index) => [char, index]),
);
const BASE = 58n;

/** Decode base58 to bytes; invalid characters return null (no throw; the caller decides the error semantics). */
export function base58Decode(value: string): Uint8Array | null {
  if (value === '') return null;
  let num = 0n;
  for (const char of value) {
    const digit = INDEX.get(char);
    if (digit === undefined) return null;
    num = num * BASE + BigInt(digit);
  }
  // Strip BigInt leading zero bytes, then restore one per leading '1' in the original string.
  const body: number[] = [];
  while (num > 0n) {
    body.push(Number(num & 0xffn));
    num >>= 8n;
  }
  body.reverse();
  let leadingZeros = 0;
  for (const char of value) {
    if (char !== '1') break;
    leadingZeros += 1;
  }
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...body]);
}

export function isBase58(value: string): boolean {
  return value !== '' && [...value].every((char) => INDEX.has(char));
}

/** Base58 encoding; an empty byte array returns an empty string. */
export function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % BASE)]! + out;
    num /= BASE;
  }
  // Each leading zero byte encodes as '1' (the inverse of the decode-side zero-padding logic).
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros += 1;
  }
  return '1'.repeat(leadingZeros) + out;
}
