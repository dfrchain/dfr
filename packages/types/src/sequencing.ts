/**
 * Ordering precondition (SequencingToken, ADR-032).
 *
 * Why it is needed: the EVM nonce and the Solana recent blockhash are both "preconditions for a transaction to be accepted by the chain",
 * but their semantics are completely different:
 *
 * | Dimension | EVM nonce | Solana blockhash |
 * |---|---|---|
 * | Scope | per-account | **shared chain-wide** |
 * | Value | monotonically increasing integer, consumed when used | hash string, **shareable across many transactions** |
 * | Expiry | consumed by a higher nonce | expires **by block height** (not time) |
 *
 * Stuffing the latter into `NonceLease.nonce` (`DecimalUint`, whose semantics is "sequence number") would give the same field
 * incompatible meanings on the two chains. So a **discriminated union** distinguishes them explicitly; the Adapter decides the value shape,
 * and the Store only persists and handles concurrency (it does not interpret the content).
 */
import type { DecimalUint } from './primitives.js';

/** The EVM ordering precondition (unused in M3 for now, kept to express the full model). */
export interface NonceSequencingToken {
  readonly kind: 'nonce';
  readonly value: DecimalUint;
}

/**
 * The Solana ordering precondition.
 *
 * `lastValidBlockHeight` is a **block height**, not a timestamp: expiry must be decided by comparing chain height
 * (measured devnet window is about 166 blocks, ≈60–90 seconds).
 */
export interface BlockhashSequencingToken {
  readonly kind: 'blockhash';
  readonly value: string;
  readonly lastValidBlockHeight: DecimalUint;
}

export type SequencingToken = NonceSequencingToken | BlockhashSequencingToken;

/** Sequencing lease state. `expired` is written by expiry reclamation, kept distinct from `released` for audit. */
export type SequencingLeaseStatus = 'reserved' | 'consumed' | 'released' | 'expired';
