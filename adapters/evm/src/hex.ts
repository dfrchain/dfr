/**
 * EVM 十六进制 ↔ 十进制字符串转换。
 *
 * 领域模型约定（domain-model 第 4.1 节）：金额、余额、nonce、高度、gas 一律
 * 使用十进制字符串，禁止 number。因此所有链上数值都必须在这里转换一次，
 * 不允许把 0x… 直接塞进领域对象，也不允许经过 Number 丢精度。
 */
import type { DecimalUint } from '@dfr/types';

/** `0x1a` → `"26"`。空值或非法输入抛错，由调用方归一化。 */
export function hexToDecimalUint(hex: string): DecimalUint {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError(`not a hex quantity: ${hex.slice(0, 12)}`);
  }
  return BigInt(hex).toString(10) as DecimalUint;
}

/** `"26"` → `0x1a`。 */
export function decimalUintToHex(value: DecimalUint | string): string {
  return `0x${BigInt(value).toString(16)}`;
}

/** `0x1a` → number，仅用于交易计数这类有界字段（不用于金额/高度）。 */
export function hexToSafeNumber(hex: string): number {
  const parsed = Number(BigInt(hex));
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError('hex value exceeds safe integer range');
  }
  return parsed;
}
