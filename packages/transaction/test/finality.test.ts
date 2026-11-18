import { describe, expect, it } from 'vitest';
import type { DecimalUint, FinalityPolicy, FinalityState } from '@dfr/types';
import { evaluateFinality } from '../src/finality.js';

describe('evaluateFinality', () => {
  it('confirmations compares with decimal strings; confirmed once the threshold is reached', () => {
    const policy: FinalityPolicy = { kind: 'confirmations', confirmations: 12 };
    expect(evaluateFinality({ policy, finalityStatus: 'verified', confirmations: '11' as DecimalUint, required: 'confirmed' }).reached).toBe(false);
    expect(evaluateFinality({ policy, finalityStatus: 'verified', confirmations: '12' as DecimalUint, required: 'confirmed' })).toMatchObject({ observed: 'confirmed', reached: true });
  });

  it('a checkpoint only satisfies finalized with a finalized tag', () => {
    const policy: FinalityPolicy = { kind: 'checkpoint', finalizedTag: true };
    expect(evaluateFinality({ policy, finalityStatus: 'verified', observed: 'confirmed', required: 'finalized' }).reached).toBe(false);
    expect(evaluateFinality({ policy, finalityStatus: 'verified', observed: 'finalized', required: 'finalized' }).reached).toBe(true);
  });

  it('an unverified strategy cannot serve as a settlement-grade finalized basis', () => {
    expect(evaluateFinality({ policy: { kind: 'checkpoint', finalizedTag: true }, finalityStatus: 'unverified', observed: 'finalized', required: 'finalized' })).toMatchObject({ reached: false, reason: 'unverified_policy' });
  });

  it('unknown/orphaned never qualifies', () => {
    expect(evaluateFinality({ policy: { kind: 'none' }, finalityStatus: 'verified', observed: 'unknown', required: 'submitted' }).reached).toBe(false);
    expect(evaluateFinality({ policy: { kind: 'none' }, finalityStatus: 'verified', observed: 'orphaned', required: 'submitted' }).reached).toBe(false);
  });
});

describe('commitment strategy (ADR-031, the premise of the M2 Solana path)', () => {
  const policy: FinalityPolicy = {
    kind: 'commitment',
    levels: ['processed', 'confirmed', 'finalized'],
  };

  it('included is equivalent to processed and belongs to a declared level (before the fix it was misjudged unsupported_commitment)', () => {
    // The real defect: policy.levels is a Commitment (processed|confirmed|finalized),
    // while observed is a FinalityState (submitted|included|...). Only two values intersect,
    // and `processed` has no counterpart in FinalityState — the closest value, `included`, was judged "unsupported".
    const result = evaluateFinality({
      policy, finalityStatus: 'verified', observed: 'included', required: 'confirmed',
    });
    expect(result.observed).toBe('included');
    expect(result.reason).not.toBe('unsupported_commitment');
    expect(result.reached).toBe(false); // processed < confirmed: not yet met, but the path is usable
  });

  it('processed itself can satisfy required=included', () => {
    const result = evaluateFinality({
      policy, finalityStatus: 'verified', observed: 'included', required: 'included',
    });
    expect(result).toMatchObject({ observed: 'included', reached: true });
  });

  it('submitted has not entered any commitment level → not met, but not "unsupported"', () => {
    const result = evaluateFinality({
      policy, finalityStatus: 'verified', observed: 'submitted', required: 'included',
    });
    expect(result.reached).toBe(false);
    expect(result.reason, 'not yet in any level must not report unsupported_commitment').not.toBe('unsupported_commitment');
  });

  it('confirmed / finalized qualify (same-name mapping)', () => {
    expect(evaluateFinality({ policy, finalityStatus: 'verified', observed: 'confirmed', required: 'confirmed' }).reached).toBe(true);
    expect(evaluateFinality({ policy, finalityStatus: 'verified', observed: 'finalized', required: 'finalized' }).reached).toBe(true);
  });

  it('an observation that cannot be reverse-mapped to a commitment still reports unsupported_commitment (negative control, kept after the ADR-031 revision)', () => {
    // The pre-revision negative control asserted unsupported with a "narrowed levels + observed finalized" shape —
    // that is exactly the F-1 paradox: an observation stronger than the highest declared level should qualify under monotonic semantics
    // (see the regression case below). After the revision, what must still fail closed is an observation that fundamentally cannot be reverse-mapped
    // or compared against the commitment total order: for example a FinalityState outside the enum at runtime
    // (a future extension or an unknown value from a heterogeneous Adapter).
    const result = evaluateFinality({
      policy, finalityStatus: 'verified',
      observed: 'snapshot' as FinalityState, required: 'confirmed',
    });
    expect(result.reason).toBe('unsupported_commitment');
    expect(result.reached).toBe(false);
  });

  it('an observation stronger than the highest declared level still qualifies under monotonic semantics (ADR-031 revision: F-1 regression)', () => {
    // The real shape of solana-devnet: levels only declares [processed, confirmed]
    // (finalityStatus unverified), yet the Adapter faithfully observes finalized.
    // Before the revision, evaluateFinality reported unsupported_commitment with reached=false here,
    // and engine.confirm could never converge a finalized transaction (Finding F-1).
    const devnet: FinalityPolicy = { kind: 'commitment', levels: ['processed', 'confirmed'] };
    expect(evaluateFinality({
      policy: devnet, finalityStatus: 'unverified', observed: 'finalized', required: 'confirmed',
    })).toMatchObject({ observed: 'finalized', reached: true });
    // The processed grade of required is written as included in the FinalityLevel domain.
    expect(evaluateFinality({
      policy: devnet, finalityStatus: 'unverified', observed: 'finalized', required: 'included',
    }).reached).toBe(true);
  });

  it('narrowing levels to [confirmed] still qualifies a finalized observation (the post-revision semantics of the old negative-control shape)', () => {
    const narrowed: FinalityPolicy = { kind: 'commitment', levels: ['confirmed'] };
    const result = evaluateFinality({
      policy: narrowed, finalityStatus: 'verified', observed: 'finalized', required: 'confirmed',
    });
    expect(result).toMatchObject({ observed: 'finalized', reached: true });
  });

  it('an observation weaker than the requirement is still not met (monotonic semantics does not change the not-met verdict)', () => {
    const devnet: FinalityPolicy = { kind: 'commitment', levels: ['processed', 'confirmed'] };
    const result = evaluateFinality({
      policy: devnet, finalityStatus: 'unverified', observed: 'included', required: 'confirmed',
    });
    expect(result.reached).toBe(false);
    expect(result.reason).not.toBe('unsupported_commitment');
  });

  it('an unverified devnet must still not be used to claim finalized (the finalityStatus umbrella)', () => {
    const result = evaluateFinality({
      policy, finalityStatus: 'unverified', observed: 'finalized', required: 'finalized',
    });
    expect(result).toMatchObject({ reached: false, reason: 'unverified_policy' });
  });
});
