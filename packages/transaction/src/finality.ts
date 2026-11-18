/** Pure finality decision (DFR-M1-D01): no chain, Store, or clock access. */
import { commitmentOf, reachesFinalityLevel } from '@dfr/types';
import type { DecimalUint, FinalityLevel, FinalityPolicy, FinalityState, FinalityStatus } from '@dfr/types';

export interface EvaluateFinalityInput {
  readonly policy: FinalityPolicy;
  readonly finalityStatus: FinalityStatus;
  readonly required: FinalityLevel;
  /** The settlement state already observed by the Adapter / tracker. */
  readonly observed?: FinalityState;
  /** The on-chain confirmation count of the confirmations strategy, as a decimal string. */
  readonly confirmations?: DecimalUint;
}

export interface FinalityEvaluation {
  readonly observed: FinalityState;
  readonly reached: boolean;
  readonly reason?: 'unverified_policy' | 'insufficient_confirmations' | 'unsupported_commitment';
}

export function evaluateFinality(input: EvaluateFinalityInput): FinalityEvaluation {
  let observed = input.observed ?? 'submitted';
  if (observed === 'unknown' || observed === 'orphaned') return { observed, reached: false };

  if (input.policy.kind === 'confirmations') {
    const confirmations = input.confirmations === undefined ? 0n : BigInt(input.confirmations);
    if (confirmations >= BigInt(input.policy.confirmations)) observed = 'confirmed';
    else if (observed !== 'finalized') {
      return { observed, reached: false, reason: 'insufficient_confirmations' };
    }
  }

  if (input.policy.kind === 'commitment') {
    // ADR-031: `observed` is a FinalityState, while `levels` is a Commitment — two differently named domains.
    // Look up which commitment it represents first.
    const commitment = commitmentOf(observed);
    if (commitment === undefined) {
      if (observed === 'submitted') {
        // Not yet inside any commitment level — this is "not there yet", not "unsupported" (ADR-031 §2, unchanged).
        return { observed, reached: false };
      }
      // Observations that cannot be reverse-mapped or compared against the commitment total order (e.g. an unknown enum value appearing at runtime):
      // fail-closed, still reporting unsupported_commitment (kept after the ADR-031 2026-11-05 revision).
      return { observed, reached: false, reason: 'unsupported_commitment' };
    }
    // ADR-031 2026-11-05 revision (monotonic semantics): commitment is a total order
    // processed < confirmed < finalized; an observation at or above the required strength counts as met —
    // even if it is stronger than the highest level `levels` declares (e.g. devnet only declares [processed, confirmed],
    // while the Adapter faithfully observes finalized). `levels` declares "the levels actually distinguishable"
    // (ADR-031 §3) and is no longer used as an admission gate for observations; whether the bar is met is decided below by the shared
    // reachesFinalityLevel under the same total order (the mapping is order-preserving); weaker than required means not met.
  }

  // A strategy never validated against a real chain must not support settlement-grade finalized claims.
  if (input.required === 'finalized' && input.finalityStatus !== 'verified') {
    return { observed, reached: false, reason: 'unverified_policy' };
  }
  return { observed, reached: reachesFinalityLevel(observed, input.required) };
}
