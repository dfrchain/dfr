/**
 * Transaction state machine (DFR-M1-A05).
 *
 * Authoritative edge set: docs/architecture/transaction-lifecycle.md, section 3.1 state-transition table.
 * This module is a **pure function**: it touches no database, Provider, chain, or clock; it only answers
 * "from this state, receiving this event, where may it move".
 *
 * Design points:
 *
 * 1. **Table-driven**: the allowed edges live in `ALLOWED_TRANSITIONS`; the implementation has no scattered if/switch.
 *    When the spec table changes, only the table changes — no logic to chase.
 * 2. **Terminal states first**: terminal-state protection is judged **before** the table lookup, so a terminal state always gets `TERMINAL_STATE`
 *    and is never masked by an `INVALID_TRANSITION` for "this edge just happens to be missing".
 * 3. **Stable reason codes**: `TransitionRejectionReason` is the state machine's own vocabulary,
 *    not `DFR_*` error codes. The HTTP layer maps it to outward-facing errors.
 * 4. **`orphaned` is not a transaction state**: a reorg rolls `included` back to `pending`,
 *    and the reorg fact is expressed by the `chain.reorg` event and block-observation state (`FinalityState`).
 *
 * Out of scope for this module (owned by the caller / later tasks):
 *   - the parts of a transition's preconditions other than the `rebroadcast` flag
 *     (whether simulation may be skipped with authorization, whether the `FinalityPolicy` is satisfied, whether `dropTimeoutMs` has passed);
 *   - persistence, concurrency control, and event publication.
 */

import type { TransactionStatus } from '@dfr/types';

/**
 * An event that triggers a state transition.
 *
 * The names deliberately distinguish "simulation failure" from "on-chain execution failure": both target `reverted`,
 * but their source states are completely different (the former only from `built`, the latter for all non-terminal states).
 */
export type TransactionEvent =
  | 'build'
  | 'simulate.succeeded'
  | 'simulate.failed'
  | 'sign'
  | 'broadcast.accepted'
  | 'broadcast.rejected'
  /**
    * Indeterminate broadcast result (ADR-019): the request was sent, but neither acceptance nor rejection was confirmed.
   *
    * TX-02: a rejection from the current RPC does not prove other nodes did not propagate the signed hash,
    * so this kind of rejection also goes through `broadcast.indeterminate → unknown`, resolved by read-only on-chain observation.
    * `broadcast.rejected → failed` is kept only for locally verifiable conditions that can never land on-chain
    * (currently an expired Solana blockhash); never treat an ordinary RPC rejection as network-wide fact.
   */
  | 'broadcast.indeterminate'
  /** TX-04: only an explicit dropped→broadcast retry may record this uncertain outcome. */
  | 'rebroadcast.indeterminate'
  | 'mempool.entered'
  | 'included'
  | 'confirmed'
  | 'finalized'
  | 'dropped'
  | 'replaced'
  | 'rebroadcast'
  | 'reorg'
  /**
    * Explicitly void an **unbroadcast** transaction (ADR-037). Only `built` / `simulated` accept this event;
    * `signed` and above have no edge for it, so arriving there yields `TERMINAL_STATE` or "no such edge".
   */
  | 'abandon'
  | 'execution.failed';

/** Stable reason codes for a rejected transition. */
export type TransitionRejectionReason =
   /** The start state is terminal; no event can move it further. */
  | 'TERMINAL_STATE'
   /** Section 3.1 of the spec defines no such edge. */
  | 'INVALID_TRANSITION'
   /** `dropped → broadcast` must explicitly carry `rebroadcast: true`, preventing an implicit second broadcast. */
  | 'REBROADCAST_FLAG_REQUIRED';

/**
 * Terminal states (transaction-lifecycle.md, section 3.2).
 *
 * `dropped` is **not** terminal: it can still be rebroadcast within the time limit with the same nonce.
 */
export const TERMINAL_STATUSES: readonly TransactionStatus[] = [
  'finalized',
  'reverted',
  'failed',
  'replaced',
   // ADR-037: explicitly voided; terminal, with no outbound edges.
  'abandoned',
];

/** One allowed edge. `from === null` means the transaction has not been created yet. */
export interface TransitionSpec {
  readonly from: TransactionStatus | null;
  readonly event: TransactionEvent;
  readonly to: TransactionStatus;
   /** When true, the caller must explicitly pass `rebroadcast: true`. */
  readonly requiresRebroadcast?: boolean;
}

/**
 * The complete allowed edge set from spec section 3.1.
 *
 * The spec table's `*` rows (on-chain execution failure) expand literally into all 9 non-terminal states;
 * plus ADR-019's 5 `unknown` edges (1 inbound + 4 resolution outbound edges)
 * and ADR-023's 3 `dropped` convergence edges.
 * TX-04 also adds one dedicated `broadcast + rebroadcast.indeterminate → unknown` edge.
 * The edge count is defined by the length of ALLOWED_TRANSITIONS; tests lock the current set.
 * Terminal states are not in the table: any request whose `from` is terminal is intercepted by `TERMINAL_STATE` before the lookup.
 */
export const ALLOWED_TRANSITIONS: readonly TransitionSpec[] = [
   // (none) → built
  { from: null, event: 'build', to: 'built' },

  // built
  { from: 'built', event: 'simulate.succeeded', to: 'simulated' },
   // ADR-037: explicit void (DELETE /v1/transactions/{id}). Only reachable from built/simulated —
   // signed and above are always fail-closed; a "signed/broadcast" transaction must never reach here.
  { from: 'built', event: 'abandon', to: 'abandoned' },
  { from: 'built', event: 'simulate.failed', to: 'reverted' },
  { from: 'built', event: 'sign', to: 'signed' },

  // simulated
  { from: 'simulated', event: 'sign', to: 'signed' },
  { from: 'simulated', event: 'abandon', to: 'abandoned' },

  // signed
  { from: 'signed', event: 'broadcast.accepted', to: 'broadcast' },
  { from: 'signed', event: 'broadcast.rejected', to: 'failed' },
   // Indeterminate broadcast result: only into unknown, never straight to failed (ADR-019).
  { from: 'signed', event: 'broadcast.indeterminate', to: 'unknown' },

  // broadcast
  // TX-04: an explicit retry starts at dropped→broadcast. If its RPC call
  // errors, the outcome is unknowable: preserve the original hash/nonce,
  // enter unknown and observe. Never turn this into failed/rejected or re-send.
  { from: 'broadcast', event: 'rebroadcast.indeterminate', to: 'unknown' },
  { from: 'broadcast', event: 'mempool.entered', to: 'pending' },

  // pending
  { from: 'pending', event: 'included', to: 'included' },
  { from: 'pending', event: 'dropped', to: 'dropped' },
  { from: 'pending', event: 'replaced', to: 'replaced' },

  // included
  { from: 'included', event: 'confirmed', to: 'confirmed' },
  { from: 'included', event: 'reorg', to: 'pending' },

  // confirmed
  { from: 'confirmed', event: 'finalized', to: 'finalized' },

   // dropped: it can be rebroadcast within the time limit (explicit rebroadcast required), and it can also be corrected by later observations (ADR-023).
   // Why the three convergence edges below are needed: `dropped` is a **judgment** ("not on-chain right now"), not an irreversible fact.
   // Without them, one misjudgment would leave the record stuck in dropped forever — reporting "dropped" for a transaction that actually confirmed.
  { from: 'dropped', event: 'rebroadcast', to: 'broadcast', requiresRebroadcast: true },
  { from: 'dropped', event: 'mempool.entered', to: 'pending' },
  { from: 'dropped', event: 'included', to: 'included' },
  { from: 'dropped', event: 'replaced', to: 'replaced' },

   // unknown (ADR-019): resolve by on-chain observation; there is no unknown → broadcast,
   // so a rebroadcast must go via dropped → rebroadcast, avoiding "a second broadcast automatically after a timeout".
  { from: 'unknown', event: 'mempool.entered', to: 'pending' },
  { from: 'unknown', event: 'included', to: 'included' },
  { from: 'unknown', event: 'dropped', to: 'dropped' },
  { from: 'unknown', event: 'replaced', to: 'replaced' },

   // `*` rows: on-chain execution failure (receipt status = 0), applying to all non-terminal states.
  { from: 'built', event: 'execution.failed', to: 'reverted' },
  { from: 'simulated', event: 'execution.failed', to: 'reverted' },
  { from: 'signed', event: 'execution.failed', to: 'reverted' },
  { from: 'broadcast', event: 'execution.failed', to: 'reverted' },
  { from: 'pending', event: 'execution.failed', to: 'reverted' },
  { from: 'included', event: 'execution.failed', to: 'reverted' },
  { from: 'confirmed', event: 'execution.failed', to: 'reverted' },
  { from: 'dropped', event: 'execution.failed', to: 'reverted' },
  { from: 'unknown', event: 'execution.failed', to: 'reverted' },
];

/**
 * All declared events, derived from the edge set.
 *
 * Derived, not hand-written: guaranteeing that "an event with no edge" or "an edge with no event" can never exist.
 */
export const TRANSACTION_EVENTS: readonly TransactionEvent[] = [
  ...new Set(ALLOWED_TRANSITIONS.map((spec) => spec.event)),
];

export interface TransitionInput {
   /** The current state; `null` means the transaction has not been created yet. */
  readonly from: TransactionStatus | null;
  readonly event: TransactionEvent;
   /** Only `dropped → broadcast` needs this; it must explicitly be `true`. */
  readonly rebroadcast?: boolean;
}

export interface TransitionAllowed {
  readonly ok: true;
  readonly status: TransactionStatus;
}

export interface TransitionRejected {
  readonly ok: false;
  readonly reason: TransitionRejectionReason;
   /** Echo the input, for audit and troubleshooting. */
  readonly from: TransactionStatus | null;
  readonly event: TransactionEvent;
}

export type TransitionResult = TransitionAllowed | TransitionRejected;

function isTerminal(status: TransactionStatus | null): boolean {
  return status !== null && TERMINAL_STATUSES.includes(status);
}

/**
 * Compute one state transition.
 *
 * Decision order (the order itself is part of the contract):
 *   1. Terminal-state protection → `TERMINAL_STATE`
 *   2. Whether a spec-defined edge is hit → otherwise `INVALID_TRANSITION`
 *   3. Whether the edge requires `rebroadcast: true` → otherwise `REBROADCAST_FLAG_REQUIRED`
 */
export function transition(input: TransitionInput): TransitionResult {
  const { from, event } = input;

  if (isTerminal(from)) {
    return { ok: false, reason: 'TERMINAL_STATE', from, event };
  }

  const spec = ALLOWED_TRANSITIONS.find((s) => s.from === from && s.event === event);
  if (!spec) {
    return { ok: false, reason: 'INVALID_TRANSITION', from, event };
  }

  if (spec.requiresRebroadcast && input.rebroadcast !== true) {
    return { ok: false, reason: 'REBROADCAST_FLAG_REQUIRED', from, event };
  }

  return { ok: true, status: spec.to };
}

/** Read-only helper: whether the edge is allowed, without returning a reason. */
export function canTransition(input: TransitionInput): boolean {
  return transition(input).ok;
}
