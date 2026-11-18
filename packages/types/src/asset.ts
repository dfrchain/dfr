/**
 * Asset and balance model (see docs/architecture/domain-model.md section 4.3).
 *
 * EVM:     assetId = ERC-20 contract address, standard = "erc20"
 * Solana:  assetId = SPL mint address,   standard = "spl-token"
 * Bitcoin: no token concept; returns DFR_UNSUPPORTED_CAPABILITY
 */
import type { ChainId, DecimalUint } from './primitives.js';
import type { BlockRef } from './block.js';

export type AssetRef =
  | { kind: 'native'; chain: ChainId }
  | { kind: 'token'; chain: ChainId; assetId: string; standard?: string };

export interface Asset {
  ref: AssetRef;
  symbol?: string;
  /** 0..36; decimals is a quantity, not an amount, so number is allowed. */
  decimals: number;
  name?: string;
  /** Whether it is treated as a stablecoin/pricing asset, for display and policy only. */
  isQuote?: boolean;
}

export interface Balance {
  account: string;
  asset: AssetRef;
  /** Amount in the smallest unit, decimal string. */
  amount: DecimalUint;
  decimals: number;
  /** The block this balance corresponds to, for consistency checks. */
  blockRef?: BlockRef;
  /** On-chain raw value (decoded), containing no sensitive information. */
  raw?: unknown;
}
