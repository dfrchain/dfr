/**
 * 广播结果分类与 `unknown` 解析（DFR-M1-C03b，ADR-019）。
 *
 * 本模块是**纯函数**：不接触 Store、链、Provider 或时钟，只回答两个问题：
 *
 *   1. 这次广播失败是"可证明不可自愈的拒绝"，还是"结果不确定"？
 *   2. 一次链上观测能把 `unknown` 解析成哪个状态（或仍无法解析）？
 *
 * 为什么必须是纯函数：TransactionEngine 在广播超时时用第 1 问落 `unknown`，
 * M1-D03 的启动恢复扫描在进程重启后用第 2 问继续解析。两处共用同一实现，
 * 否则会出现"同一笔交易在请求路径与恢复路径得到不同结论"的分裂。
 *
 * 边界：不构造对外错误（错误只在其归属层构造一次，ADR-009），只返回分类枚举。
 */
import { isDfrError } from '@dfr/errors';
import type { BlockRef } from '@dfr/types';
import type { TransactionEvent } from './state-machine.js';

/**
 * 广播失败的两种归属（ADR-019 第 3 节）。
 *
 * - `rejected`：节点**明确拒绝**且不可自愈 → `signed + broadcast.rejected → failed`（终态）。
 * - `indeterminate`：无法判定是否已进入链/mempool → `signed + broadcast.indeterminate → unknown`。
 */
export type BroadcastFailureClass = 'rejected' | 'indeterminate';

/**
 * TX-02: a peer's synchronous rejection is NOT globally authoritative once
 * a signed transaction has been persisted and handed to network code.
 *
 * - DFR_TRANSACTION_REJECTED may mean one peer rejected but another accepted.
 * - DFR_INSUFFICIENT_FUNDS can change with balance and another peer may have
 *   accepted it earlier.
 * - DFR_VALIDATION_FAILED is an error category, not a signed, verifiable
 *   network-wide non-propagation certificate.
 *
 * EVM or generic RPC errors therefore stay indeterminate and enter read-only
 * hash+nonce reconciliation, never terminal-fail or release a signed lease.
 *
 * The one justified exception is a Solana transaction whose embedded recent
 * blockhash is PROVEN expired by the adapter: that exact signed payload can no
 * longer be included. An unproven provider message must never be re-labelled
 * with this internal evidence code by an arbitrary remote peer.
 */
const REJECTED_CODES: ReadonlySet<string> = new Set([
  'DFR_BLOCKHASH_EXPIRED',
]);

/** 分类一次广播失败。非 `DfrError` 一律按不确定处理（不猜测）。 */
export function classifyBroadcastFailure(error: unknown): BroadcastFailureClass {
  if (!isDfrError(error)) return 'indeterminate';
  return REJECTED_CODES.has(error.code) ? 'rejected' : 'indeterminate';
}

/**
 * 链上观测（由 composition root 用 Adapter 的能力实现）。
 *
 * 刻意是"观测"而不是"结论"：Adapter 只报告它**看到**了什么，
 * 由本模块（纯函数）决定对应哪个状态事件，避免 Adapter 侵入状态语义。
 */
export type ChainBroadcastObservation =
  /** 按 expectedHash 查到交易且已有区块引用。 */
  | {
      readonly kind: 'included';
      readonly txHash: string;
      readonly blockRef?: BlockRef;
      readonly canonicalBlockHash?: string;
    }
  /** 按 expectedHash 查到交易但尚未上链（在我们查询的端点看来在 mempool）。 */
  | { readonly kind: 'pending'; readonly txHash: string }
  /** 该 nonce 已被另一笔交易消耗，且按 expectedHash 查不到本人交易。 */
  | { readonly kind: 'replaced'; readonly nonce: string; readonly byTxHash?: string }
  /**
   * 按 expectedHash 查不到，且该 nonce 仍未被占用。
   *
   * **不等于 `dropped`**：mempool 传播是异步的，其它端点可能仍持有这笔交易。
   * 因此本模块把它解析为 `null`（保持 `unknown`）；只有 M1-D03 在
   * `dropTimeoutMs` 窗口之后才允许据此判 `dropped`。
   */
  | { readonly kind: 'absent' };

/**
 * 把一次观测解析为 `unknown` 的状态出边事件。
 *
 * 返回 `null` 表示"仍无法解析"，调用方保持 `unknown`（不是失败，也不是丢弃）。
 */
export function resolveUnknownOutcome(
  observation: ChainBroadcastObservation,
): TransactionEvent | null {
  switch (observation.kind) {
    case 'included':
      return 'included';
    case 'pending':
      return 'mempool.entered';
    case 'replaced':
      return 'replaced';
    case 'absent':
      return null;
    default:
      return null;
  }
}
