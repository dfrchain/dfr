/**
 * EVM 地址校验（Adapter 职责，Core 不做格式假设 —— domain-model 第 4.2 节）。
 */
import { createDfrError } from '@dfr/errors';
import type { ChainId } from '@dfr/types';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isEvmAddress(value: string): boolean {
  return ADDRESS_RE.test(value);
}

export function isEvmTxHash(value: string): boolean {
  return TX_HASH_RE.test(value);
}

/** 非法地址 → DFR_INVALID_ACCOUNT（422，不可重试）。 */
export function assertEvmAddress(
  value: string,
  chain: ChainId,
  requestId: string,
): asserts value is string {
  if (!isEvmAddress(value)) {
    throw createDfrError('DFR_INVALID_ACCOUNT', {
      requestId: requestId as never,
      message: `不是合法的 EVM 地址（期望 0x + 40 位十六进制）`,
      chain,
    });
  }
}

/** 非法交易哈希 → DFR_INVALID_REQUEST（哈希是路径参数，不是账户）。 */
export function assertEvmTxHash(
  value: string,
  chain: ChainId,
  requestId: string,
): asserts value is string {
  if (!isEvmTxHash(value)) {
    throw createDfrError('DFR_INVALID_REQUEST', {
      requestId: requestId as never,
      message: '不是合法的 EVM 交易哈希（期望 0x + 64 位十六进制）',
      chain,
    });
  }
}
