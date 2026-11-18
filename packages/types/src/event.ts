/**
 * Event model (see docs/architecture/transaction-lifecycle.md section 6,
 * ADR-006).
 *
 * Delivery semantics: at-least-once. Consumers must dedupe by eventId.
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
  /** Globally unique event ID, for consumer-side dedupe. */
  eventId: string;
  /**
   * Monotonically increasing cursor, for resumable replay.
   *
   * Scope (audit fix A-24): the cursor is monotonic **within the subscription scope**. When `EventFilter.chain` is omitted
   * (a cross-chain subscription), the cursor is allocated uniformly by Core on the merged cross-chain stream; when `chain` is specified, the cursor is
   * monotonic only within that chain's stream. Cursors from the two scopes are **not interchangeable**; consumers must replay with the filter used at subscribe time.
   * See also ADR-006: in M0/M1 the bus is in-process, so cursors do not survive a process restart.
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
  /** List of affected transaction hashes (may be empty). */
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
  /** Only subscribe to events from the specified contract/program. */
  addresses?: readonly string[];
  /** Start delivery after this cursor, for replay. */
  afterCursor?: Cursor;
}
