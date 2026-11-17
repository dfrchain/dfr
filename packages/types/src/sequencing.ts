/**
 * 排序前提（SequencingToken，ADR-032）。
 *
 * 为什么需要它：EVM 的 nonce 与 Solana 的 recent blockhash 都是"让交易可被链接受的前提"，
 * 但语义完全不同：
 *
 * | 维度 | EVM nonce | Solana blockhash |
 * |---|---|---|
 * | 作用域 | 账户级 | **全链共用** |
 * | 取值 | 单调递增整数，用掉即消耗 | 哈希串，**多笔交易可共用** |
 * | 失效 | 被更高 nonce 消耗 | **按区块高度**过期（非时间） |
 *
 * 把后者塞进 `NonceLease.nonce`（`DecimalUint`，语义是"序号"）会让同一字段在两条链上
 * 有互不相容的含义。因此这里用**判别联合**显式区分，由 Adapter 决定取值形状，
 * Store 只做持久化与并发（不解释内容）。
 */
import type { DecimalUint } from './primitives.js';

/** EVM 的排序前提（M3 暂未使用，保留以表达完整模型）。 */
export interface NonceSequencingToken {
  readonly kind: 'nonce';
  readonly value: DecimalUint;
}

/**
 * Solana 的排序前提。
 *
 * `lastValidBlockHeight` 是**区块高度**而不是时间戳：过期判定必须比对链高
 * （实测 devnet 有效窗口约 166 个 block，≈60–90 秒）。
 */
export interface BlockhashSequencingToken {
  readonly kind: 'blockhash';
  readonly value: string;
  readonly lastValidBlockHeight: DecimalUint;
}

export type SequencingToken = NonceSequencingToken | BlockhashSequencingToken;

/** 排序租约的状态。`expired` 由过期回收写入，与 `released` 区分开以便审计。 */
export type SequencingLeaseStatus = 'reserved' | 'consumed' | 'released' | 'expired';
