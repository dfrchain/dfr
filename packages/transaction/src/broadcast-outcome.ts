/**
 * Broadcast result classification and `unknown` resolution (DFR-M1-C03b, ADR-019).
 *
 * This module is a **pure function**: it touches no Store, chain, Provider, or clock; it only answers two questions:
 *
 *   1. Is this broadcast failure a "provably non-self-healing rejection", or "outcome indeterminate"?
 *   2. Which state (or still unresolvable) can one on-chain observation resolve `unknown` into?
 *
 * Why it must be a pure function: the TransactionEngine uses question 1 to land on `unknown` on broadcast timeout,
 * and the M1-D03 startup recovery scan uses question 2 to keep resolving after a process restart. Both share one implementation,
 * otherwise the same transaction could reach different conclusions on the request path vs. the recovery path.
 *
 * Boundary: it constructs no outward-facing errors (each error is constructed exactly once, in the layer it belongs to, ADR-009); it only returns a classification enum.
 */
import { isDfrError } from '@dfr/errors';
import type { BlockRef } from '@dfr/types';
import type { TransactionEvent } from './state-machine.js';

/**
 * The two attributions of a broadcast failure (ADR-019, section 3).
 *
 * - `rejected`: the node **explicitly rejected** it and it cannot self-heal -> `signed + broadcast.rejected -> failed` (terminal state).
 * - `indeterminate`: cannot tell whether it reached the chain/mempool -> `signed + broadcast.indeterminate -> unknown`.
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

/** Classify one broadcast failure. Anything that is not a `DfrError` is treated as indeterminate (never guess). */
export function classifyBroadcastFailure(error: unknown): BroadcastFailureClass {
  if (!isDfrError(error)) return 'indeterminate';
  return REJECTED_CODES.has(error.code) ? 'rejected' : 'indeterminate';
}

/**
 * An on-chain observation (implemented by the composition root using an Adapter capability).
 *
 * Deliberately an "observation", not a "conclusion": the Adapter only reports what it **saw**,
 * and this module (a pure function) decides which state event that maps to, so the Adapter never intrudes into state semantics.
 */
export type ChainBroadcastObservation =
   /** Found the transaction by expectedHash and it already has a block reference. */
  | {
      readonly kind: 'included';
      readonly txHash: string;
      readonly blockRef?: BlockRef;
      readonly canonicalBlockHash?: string;
    }
   /** Found the transaction by expectedHash but it is not on-chain yet (in the mempool, as far as the endpoint we queried can see). */
  | { readonly kind: 'pending'; readonly txHash: string }
   /** This nonce has already been consumed by another transaction, and our own transaction cannot be found by expectedHash. */
  | { readonly kind: 'replaced'; readonly nonce: string; readonly byTxHash?: string }
  /**
    * Not found by expectedHash, and the nonce is still unoccupied.
   *
    * **Not the same as `dropped`**: mempool propagation is asynchronous; other endpoints may still hold this transaction.
    * This module therefore resolves it to `null` (stays `unknown`); only M1-D03, after the
    * `dropTimeoutMs` window, may use this to judge it `dropped`.
   */
  | { readonly kind: 'absent' };

/**
 * Resolve one observation into an outbound event from the `unknown` state.
 *
 * Returning `null` means "still unresolvable"; the caller stays `unknown` (neither a failure nor a drop).
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
