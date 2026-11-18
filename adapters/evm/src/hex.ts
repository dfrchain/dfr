/**
 * EVM hex ↔ decimal-string conversion.
 *
 * Domain-model convention (domain-model Section 4.1): amounts, balances, nonces, heights, and gas are always
 * decimal strings; number is forbidden. Every on-chain value must therefore be converted here once,
 * never put raw 0x… into domain objects, and never lose precision via Number.
 */
import type { DecimalUint } from '@dfr/types';

/** `0x1a` → `"26"`. Empty or invalid input throws; the caller normalizes. */
export function hexToDecimalUint(hex: string): DecimalUint {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError(`not a hex quantity: ${hex.slice(0, 12)}`);
  }
  return BigInt(hex).toString(10) as DecimalUint;
}

/** `"26"` → `0x1a`. */
export function decimalUintToHex(value: DecimalUint | string): string {
  return `0x${BigInt(value).toString(16)}`;
}

/** `0x1a` → number, only for bounded fields such as transaction counts (never for amounts/heights). */
export function hexToSafeNumber(hex: string): number {
  const parsed = Number(BigInt(hex));
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError('hex value exceeds safe integer range');
  }
  return parsed;
}
