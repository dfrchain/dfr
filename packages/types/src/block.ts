/**
 * Block model and block references (see docs/architecture/domain-model.md section 4.4).
 */
import type { ChainId, DecimalUint, Iso8601, Commitment } from './primitives.js';

export type BlockRef =
  | { kind: 'number'; number: DecimalUint }
  | { kind: 'hash'; hash: string }
  | { kind: 'slot'; slot: DecimalUint }
  | { kind: 'tag'; tag: 'latest' | 'safe' | 'finalized'; commitment?: Commitment };

export interface Block {
  chain: ChainId;
  /** EVM height. */
  number?: DecimalUint;
  /** Solana slot. */
  slot?: DecimalUint;
  hash: string;
  parentHash?: string;
  /** Unix seconds, decimal string. */
  timestamp?: DecimalUint;
  /** Transaction count (count only; the transaction list comes from the paged endpoint). */
  transactionCount?: number;
  /** The base fee used by this EVM block. */
  baseFeePerGas?: DecimalUint;
  /** Whether this block has been confirmed by later blocks (decided by FinalityPolicy). */
  finality?: FinalityState;
  observedAt: Iso8601;
}

/**
 * The **observed** finality state of a transaction/block. Declared separately to avoid a circular dependency with transaction.ts.
 *
 * Note (audit fix A-09): this type includes values like `orphaned` / `unknown` that are **not ordered targets**,
 * so it must **not** be used as a "minimum requirement" parameter. Use `FinalityLevel` when target semantics are needed.
 */
export type FinalityState =
  | 'submitted'
  | 'included'
  | 'confirmed'
  | 'finalized'
  | 'orphaned'
  | 'unknown';

/**
 * Strictly ordered finality **target levels** (audit fix A-10).
 *
 * For `ConfirmRequest.minFinality`, `TransactionOptions.waitForFinality`, and other "at least" semantics.
 * Order (weak to strong): submitted < included < confirmed < finalized.
 *
 * Deliberately excludes `orphaned` / `unknown`: they describe abnormal observations, not pursuable targets;
 * the old version used the full `FinalityState`, letting callers pass `orphaned` as a "minimum finality".
 */
export type FinalityLevel = 'submitted' | 'included' | 'confirmed' | 'finalized';

/**
 * Mapping from `Commitment` (Solana domain) to `FinalityState` (DFR observation domain) (ADR-031).
 *
 * The two enums share only `confirmed` / `finalized`; `processed` has no counterpart in `FinalityState`,
 * and the closest semantics is `included` (in a block, unconfirmed).
 * The mapping must exist **explicitly**, otherwise comparing by `Commitment` against `FinalityState` would
 * misjudge `included` as an "unsupported commitment".
 */
export const COMMITMENT_TO_FINALITY_STATE: Readonly<Record<Commitment, FinalityState>> = {
  processed: 'included',
  confirmed: 'confirmed',
  finalized: 'finalized',
};

/** Reverse lookup from `FinalityState` to `Commitment` (returns undefined when it belongs to no commitment). */
export function commitmentOf(observed: FinalityState): Commitment | undefined {
  if (observed === 'included') return 'processed';
  if (observed === 'confirmed') return 'confirmed';
  if (observed === 'finalized') return 'finalized';
  return undefined;
}

/** Strength index of a FinalityLevel, for Core to compare "whether the requirement is met". */
export const FINALITY_ORDER: Readonly<Record<FinalityLevel, number>> = {
  submitted: 0,
  included: 1,
  confirmed: 2,
  finalized: 3,
};

/** Decide whether an observed state has reached a target level. `orphaned` / `unknown` always count as not reached. */
export function reachesFinalityLevel(
  observed: FinalityState,
  required: FinalityLevel,
): boolean {
  if (observed === 'orphaned' || observed === 'unknown') return false;
  return FINALITY_ORDER[observed] >= FINALITY_ORDER[required];
}
