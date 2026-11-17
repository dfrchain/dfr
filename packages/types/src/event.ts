/**
 * 事件模型（见 docs/architecture/transaction-lifecycle.md 第 6 节、
 * ADR-006）。
 *
 * 投递语义：at-least-once。消费端必须按 eventId 去重。
 */
import type { ChainId, Cursor, Iso8601, DecimalUint } from './primitives.js';
import type { BlockRef } from './block.js';
import type { TransactionRef, TransactionStatus } from './transaction.js';
import type { DfrError } from './errors.js';

export type EventType =
  | 'block.new'
  | 'tx.built'
  | 'tx.simulated'
  | 'tx.signed'
  | 'tx.broadcast'
  | 'tx.pending'
  | 'tx.included'
  | 'tx.confirmed'
  | 'tx.finalized'
  | 'tx.failed'
  | 'tx.reverted'
  | 'tx.dropped'
  | 'tx.replaced'
  | 'contract.event'
  | 'provider.down'
  | 'provider.recovered'
  | 'chain.reorg';

export interface ChainEvent<T = unknown> {
  /** 全局唯一事件 ID，用于消费端去重。 */
  eventId: string;
  /**
   * 单调递增游标，用于断点重放。
   *
   * 作用域（审计修正 A-24）：游标在**订阅作用域**内单调。当 `EventFilter.chain` 被省略
   * （跨链订阅）时，游标由 Core 在跨链合并流上统一分配；当指定了 `chain` 时，游标只在该链
   * 流内单调。两种作用域的游标**不可互换**，消费方必须按订阅时使用的过滤条件重放。
   * 另见 ADR-006：M0/M1 为进程内总线，游标不跨进程重启。
   */
  cursor: Cursor;
  type: EventType;
  chain: ChainId;
  blockRef?: BlockRef;
  txRef?: TransactionRef;
  payload: T;
  schemaVersion: '1';
  occurredAt: Iso8601;
}

export interface TransactionEventPayload {
  status: TransactionStatus;
  confirmations?: DecimalUint;
  error?: DfrError;
}

export interface ReorgEventPayload {
  oldBlockRef: BlockRef;
  newBlockRef: BlockRef;
  /** 受影响的交易哈希列表（可能为空）。 */
  affectedTransactions: readonly string[];
  depth?: DecimalUint;
}

export interface ProviderEventPayload {
  providerId: string;
  reason?: string;
  consecutiveFailures?: number;
}

export interface EventFilter {
  chain?: ChainId;
  types?: readonly EventType[];
  /** 仅订阅指定合约/程序的事件。 */
  addresses?: readonly string[];
  /** 从该游标之后开始投递，用于重放。 */
  afterCursor?: Cursor;
}
