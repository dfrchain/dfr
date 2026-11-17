/**
 * 资产与余额模型（见 docs/architecture/domain-model.md 第 4.3 节）。
 *
 * EVM:     assetId = ERC-20 合约地址, standard = "erc20"
 * Solana:  assetId = SPL mint 地址,   standard = "spl-token"
 * Bitcoin: 无 token 概念，返回 DFR_UNSUPPORTED_CAPABILITY
 */
import type { ChainId, DecimalUint } from './primitives.js';
import type { BlockRef } from './block.js';

export type AssetRef =
  | { kind: 'native'; chain: ChainId }
  | { kind: 'token'; chain: ChainId; assetId: string; standard?: string };

export interface Asset {
  ref: AssetRef;
  symbol?: string;
  /** 0..36；decimals 是数量而非金额，允许使用 number。 */
  decimals: number;
  name?: string;
  /** 是否被视为稳定币/计价资产，仅用于展示与策略。 */
  isQuote?: boolean;
}

export interface Balance {
  account: string;
  asset: AssetRef;
  /** 最小单位金额，十进制字符串。 */
  amount: DecimalUint;
  decimals: number;
  /** 该余额对应的区块，用于一致性判断。 */
  blockRef?: BlockRef;
  /** 链上原始值（已解码），不含敏感信息。 */
  raw?: unknown;
}
