/**
 * Solana 地址校验（ADR-028：校验位置在 Adapter，Core 不做链特定假设）。
 *
 * 规则：base58 解码成功 + 恰好 32 字节 + 不强制 on-curve（PDA / 程序地址同样合法）。
 */
import { createDfrError } from '@dfr/errors';
import type { ChainId } from '@dfr/types';
import { base58Decode, isBase58 } from './base58.js';

/** Solana 公钥固定 32 字节。 */
export const SOLANA_PUBKEY_BYTES = 32;
/** base58 表示的 32 字节最长 44 字符。 */
export const SOLANA_ADDRESS_MAX_LENGTH = 44;

export function isSolanaAddress(value: string): boolean {
  if (value.length === 0 || value.length > SOLANA_ADDRESS_MAX_LENGTH) return false;
  if (!isBase58(value)) return false;
  const decoded = base58Decode(value);
  return decoded !== null && decoded.length === SOLANA_PUBKEY_BYTES;
}

/** 交易签名（txHash）与地址同形：base58 编码的 64 字节签名。 */
const SIGNATURE_BYTES = 64;

export function isSolanaSignature(value: string): boolean {
  if (value.length === 0) return false;
  if (!isBase58(value)) return false;
  const decoded = base58Decode(value);
  return decoded !== null && decoded.length === SIGNATURE_BYTES;
}

/** 非法地址 → DFR_INVALID_ACCOUNT（422，不可重试）。 */
export function assertSolanaAddress(
  value: string,
  chain: ChainId,
  requestId: string,
): asserts value is string {
  if (!isSolanaAddress(value)) {
    throw createDfrError('DFR_INVALID_ACCOUNT', {
      requestId: requestId as never,
      message: '不是合法的 Solana 地址（期望 base58 编码的 32 字节公钥）',
      chain,
    });
  }
}

/** 非法签名 → DFR_INVALID_REQUEST（签名是路径参数，不是账户）。 */
export function assertSolanaSignature(
  value: string,
  chain: ChainId,
  requestId: string,
): asserts value is string {
  if (!isSolanaSignature(value)) {
    throw createDfrError('DFR_INVALID_REQUEST', {
      requestId: requestId as never,
      message: '不是合法的 Solana 签名（期望 base58 编码的 64 字节）',
      chain,
    });
  }
}
