/**
 * Transaction state machine contract test (DFR-M1-A05).
 *
 * Authoritative edge set: docs/architecture/transaction-lifecycle.md, section 3.1 state-transition table.
 *
 * The purpose of this test is not "adding tests to the implementation", but turning each row of the spec table into a regression assertion:
 *   - every allowed edge has an assertion;
 *   - terminal-state protection, illegal edges, and duplicate order creation all have negative controls;
 *   - the state set and `@dfr/types`' `TransactionStatus` are bound both at compile time and at runtime,
 *     so a drift like "a type added a state but the state machine did not follow" fails immediately.
 */
import { describe, expect, it } from 'vitest';
import type { TransactionStatus } from '@dfr/types';
import {
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
  TRANSACTION_EVENTS,
  transition,
  type TransactionEvent,
  type TransitionResult,
} from '../src/state-machine.js';

const ALL_STATUSES = [
  'built',
  'simulated',
  'signed',
  'broadcast',
  'pending',
  'included',
  'confirmed',
  'finalized',
  'failed',
  'reverted',
  'dropped',
  'replaced',
  'unknown',
  // ADR-037: an explicitly voided unbroadcast transaction (terminal state).
  'abandoned',
] as const satisfies readonly TransactionStatus[];

/**
 * Compile-time exhaustiveness guard.
 *
 * `Record<TransactionStatus, ...>` requires covering every state: if `TransactionStatus`
 * gains a new value and this is not updated, `pnpm typecheck` fails directly, instead of letting the state machine silently miss the new state.
 */
const COVERAGE_REASON: Record<TransactionStatus, string> = {
  built: 'allowed: simulate.succeeded / simulate.failed / sign / abandon (ADR-037)',
  simulated: 'allowed: sign / abandon (ADR-037)',
  signed: 'allowed: broadcast.accepted / broadcast.rejected',
  broadcast: 'allowed: mempool.entered / rebroadcast.indeterminate (TX-04)',
  pending: 'allowed: included / dropped / replaced',
  included: 'allowed: confirmed / reorg',
  confirmed: 'allowed: finalized',
  finalized: 'terminal: rejects all events',
  failed: 'terminal: rejects all events',
  reverted: 'terminal: rejects all events',
  replaced: 'terminal: rejects all events',
  dropped: 'allowed: rebroadcast (requires explicit rebroadcast=true)',
  unknown: 'allowed: mempool.entered / included / dropped / replaced (ADR-019)',
  abandoned: 'terminal: rejects all events (ADR-037, only reachable from built/simulated)',
};

function ok(result: TransitionResult): result is Extract<TransitionResult, { ok: true }> {
  return result.ok;
}

describe('State set and type contract', () => {
  it('the state set covered by ALLOWED_TRANSITIONS matches TransactionStatus exactly', () => {
    const referenced = new Set<string>(TERMINAL_STATUSES);
    for (const spec of ALLOWED_TRANSITIONS) {
      if (spec.from !== null) referenced.add(spec.from);
      referenced.add(spec.to);
    }
    expect([...referenced].sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('the compile-time exhaustiveness guard covers every state (a missing one is caught by typecheck)', () => {
    expect(Object.keys(COVERAGE_REASON).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('every state has a clear classification: terminal or with outbound edges (no leftover gaps)', () => {
    for (const status of ALL_STATUSES) {
      const hasOutgoing = ALLOWED_TRANSITIONS.some((s) => s.from === status);
      const isTerminal = TERMINAL_STATUSES.includes(status);
      expect(
        hasOutgoing || isTerminal,
        `${status}: ${COVERAGE_REASON[status]}`,
      ).toBe(true);
    }
  });

  it('the unknown inbound and resolution outbound edges are defined by ADR-019 (DFR-M1-C03b closes TODO-006)', () => {
    const intoUnknown = ALLOWED_TRANSITIONS.filter((s) => s.to === 'unknown');
    // One event into unknown for the first send and one for an explicit rebroadcast; no other state may bypass them.
    expect(intoUnknown).toEqual([
      { from: 'signed', event: 'broadcast.indeterminate', to: 'unknown' },
      { from: 'broadcast', event: 'rebroadcast.indeterminate', to: 'unknown' },
    ]);

    const fromUnknown = ALLOWED_TRANSITIONS.filter((s) => s.from === 'unknown');
    expect(fromUnknown.map((s) => s.event).sort()).toEqual(
      ['execution.failed', 'included', 'mempool.entered', 'replaced', 'dropped'].sort(),
    );
  });

  it('unknown is not terminal: it must be claimable by the recovery scan (m1-storage-model section 6)', () => {
    expect([...TERMINAL_STATUSES]).not.toContain('unknown');
  });

  it('there is no unknown → broadcast edge: a rebroadcast can only go via dropped → rebroadcast (guarding against an automatic second broadcast)', () => {
    const direct = ALLOWED_TRANSITIONS.filter(
      (s) => s.from === 'unknown' && s.to === 'broadcast',
    );
    expect(direct, 'unknown must not return directly to broadcast').toEqual([]);
    // The only rebroadcast entry: dropped --rebroadcast--> broadcast, with the explicit flag required.
    const rebroadcast = ALLOWED_TRANSITIONS.filter((s) => s.event === 'rebroadcast');
    expect(rebroadcast).toEqual([
      { from: 'dropped', event: 'rebroadcast', to: 'broadcast', requiresRebroadcast: true },
    ]);
  });

  it('no orphaned transaction state exists in the state machine (DFR-M1-A05 decision)', () => {
    expect([...ALL_STATUSES]).not.toContain('orphaned');
    const targets = ALLOWED_TRANSITIONS.map((s) => s.to);
    expect(targets).not.toContain('orphaned');
  });
});

describe('Allowed edges (one row per transaction-lifecycle.md section 3.1)', () => {
  for (const spec of ALLOWED_TRANSITIONS) {
    const label = `${spec.from ?? '(none)'} --${spec.event}--> ${spec.to}`;
    it(`allowed: ${label}`, () => {
      const result = transition({
        from: spec.from,
        event: spec.event,
        // For edges needing the rebroadcast flag, the test supplies it explicitly; a missing flag is covered by a dedicated negative control.
        ...(spec.requiresRebroadcast ? { rebroadcast: true } : {}),
      });
      expect(ok(result), `${label} should be allowed, but was rejected: ${JSON.stringify(result)}`).toBe(true);
      if (ok(result)) expect(result.status).toBe(spec.to);
    });
  }

  it('the edge set matches the spec table: 16 rows = 15 named edges + the `*` row expanding to 9 non-terminal states', () => {
    // The spec table originally had 16 rows (15 named + `*`); ADR-019 added 5 named edges
    // (`signed → unknown` and 4 unknown resolution outbound edges), so there are 20 named edges in total.
    // `*` literally applies to all 9 non-terminal states, expanding to 9 edges.
    // Total 20 + 9 = 29 edges. Terminal states are not in the table (intercepted by terminal-state protection).
    // ADR-023 added 3 dropped convergence edges (→ pending / included / replaced).
    // ADR-037 added 2 abandon edges (built/simulated → abandoned), 34 in total.
    expect(ALLOWED_TRANSITIONS).toHaveLength(35);

    const nonTerminal = ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));
    expect(nonTerminal).toHaveLength(9);
    const starRow = ALLOWED_TRANSITIONS.filter((s) => s.event === 'execution.failed');
    expect(starRow.map((s) => s.from).sort()).toEqual([...nonTerminal].sort());
  });
});

describe('Terminal-state protection', () => {
  it('the terminal set matches spec section 3.2 (dropped is not terminal)', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      // ADR-037 added the terminal state abandoned.
      ['abandoned', 'failed', 'finalized', 'replaced', 'reverted'].sort(),
    );
    expect(TERMINAL_STATUSES).not.toContain('dropped');
  });

  for (const status of ['finalized', 'failed', 'reverted', 'replaced', 'abandoned'] as const) {
    it(`terminal state ${status} rejects all ${TRANSACTION_EVENTS.length} events`, () => {
      for (const event of TRANSACTION_EVENTS) {
        const result = transition({ from: status, event, rebroadcast: true });
      expect(ok(result), `${status} + ${event} should not be allowed`).toBe(false);
        if (!ok(result)) expect(result.reason).toBe('TERMINAL_STATE');
      }
    });
  }

  it('a terminal state is not overwritten by the ordinary reorg path', () => {
    for (const status of ['finalized', 'reverted'] as const) {
      const result = transition({ from: status, event: 'reorg' });
      expect(ok(result)).toBe(false);
      if (!ok(result)) expect(result.reason).toBe('TERMINAL_STATE');
    }
  });
});

describe('Order-creation boundaries', () => {
  it('no state + build is the only available entry', () => {
    const result = transition({ from: null, event: 'build' });
    expect(ok(result)).toBe(true);
    if (ok(result)) expect(result.status).toBe('built');
  });

  it('all except build are rejected with no state (INVALID_TRANSITION)', () => {
    for (const event of TRANSACTION_EVENTS) {
      if (event === 'build') continue;
      const result = transition({ from: null, event });
      expect(ok(result), `null + ${event} should not be allowed`).toBe(false);
      if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
    }
  });

  it('with an existing state, build cannot run again (no duplicate order creation)', () => {
    for (const status of ALL_STATUSES) {
      const result = transition({ from: status, event: 'build' });
      expect(ok(result), `${status} + build should not be allowed`).toBe(false);
      expect(ok(result) ? undefined : result.reason).toBe(
        TERMINAL_STATUSES.includes(status) ? 'TERMINAL_STATE' : 'INVALID_TRANSITION',
      );
    }
  });
});

describe('Forbidden edges (illegal events on non-terminal states)', () => {
  it('signed cannot jump straight to included (must go through broadcast → pending)', () => {
    const result = transition({ from: 'signed', event: 'included' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('pending cannot jump to finalized (no skipping levels, avoiding false finality claims)', () => {
    const result = transition({ from: 'pending', event: 'finalized' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('confirmed cannot be overwritten by an ordinary dropped (only finalized is allowed)', () => {
    const result = transition({ from: 'confirmed', event: 'dropped' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('built cannot take broadcast.accepted directly (must sign first)', () => {
    const result = transition({ from: 'built', event: 'broadcast.accepted' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('reverted cannot be overwritten by a successful simulate (a simulation failure is the end)', () => {
    const result = transition({ from: 'reverted', event: 'simulate.succeeded' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('TERMINAL_STATE');
  });
});

describe('dropped → broadcast rebroadcast edge', () => {
  it('rejected without the rebroadcast flag (guarding against an implicit second broadcast)', () => {
    const result = transition({ from: 'dropped', event: 'rebroadcast' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('REBROADCAST_FLAG_REQUIRED');
  });

  it('an explicit rebroadcast=false is equally rejected', () => {
    const result = transition({ from: 'dropped', event: 'rebroadcast', rebroadcast: false });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('REBROADCAST_FLAG_REQUIRED');
  });

  it('an explicit rebroadcast=true passes and returns to broadcast', () => {
    const result = transition({ from: 'dropped', event: 'rebroadcast', rebroadcast: true });
    expect(ok(result)).toBe(true);
    if (ok(result)) expect(result.status).toBe('broadcast');
  });

  it('dropped does not accept an ordinary broadcast.accepted (avoid disguising a rebroadcast as a first broadcast)', () => {
    const result = transition({ from: 'dropped', event: 'broadcast.accepted' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });
});

describe('Reorg rollback', () => {
  it('included + reorg rolls back to pending', () => {
    const result = transition({ from: 'included', event: 'reorg' });
    expect(ok(result)).toBe(true);
    if (ok(result)) expect(result.status).toBe('pending');
  });

  it('after rollback, it can still advance along existing edges (pending → included)', () => {
    const afterReorg = transition({ from: 'included', event: 'reorg' });
    expect(ok(afterReorg)).toBe(true);
    if (!ok(afterReorg)) return;
    const reIncluded = transition({ from: afterReorg.status, event: 'included' });
    expect(ok(reIncluded)).toBe(true);
    if (ok(reIncluded)) expect(reIncluded.status).toBe('included');
  });

  it('after rollback, it can still converge to dropped once the time limit passes', () => {
    const afterReorg = transition({ from: 'included', event: 'reorg' });
    expect(ok(afterReorg)).toBe(true);
    if (!ok(afterReorg)) return;
    const dropped = transition({ from: afterReorg.status, event: 'dropped' });
    expect(ok(dropped)).toBe(true);
    if (ok(dropped)) expect(dropped.status).toBe('dropped');
  });

  it('an unseen (state, event) combination is always INVALID_TRANSITION, without echoing a domain error code', () => {
    const result = transition({ from: 'pending', event: 'reorg' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) {
      expect(result.reason).toBe('INVALID_TRANSITION');
      // Reason codes are the state machine's stable vocabulary, not HTTP/DFR error codes.
      expect(result.reason.startsWith('DFR_')).toBe(false);
    }
  });
});

describe('The execution.failed `*` edge', () => {
  it('applies to every non-terminal state (spec section 3.1, `*` row)', () => {
    for (const status of ALL_STATUSES) {
      if (TERMINAL_STATUSES.includes(status)) continue;
      const result = transition({ from: status, event: 'execution.failed' });
      expect(ok(result), `${status} + execution.failed should be allowed`).toBe(true);
      if (ok(result)) expect(result.status).toBe('reverted');
    }
  });

  it('does not apply to terminal states', () => {
    for (const status of TERMINAL_STATUSES) {
      const result = transition({ from: status, event: 'execution.failed' });
      expect(ok(result)).toBe(false);
      if (!ok(result)) expect(result.reason).toBe('TERMINAL_STATE');
    }
  });
});

describe('Pure-function properties', () => {
  it('the same input produces the same result (no hidden state)', () => {
    const a = transition({ from: 'pending', event: 'included' });
    const b = transition({ from: 'pending', event: 'included' });
    expect(a).toEqual(b);
  });

  it('does not mutate the input object', () => {
    const input = { from: 'dropped' as TransactionStatus, event: 'rebroadcast' as TransactionEvent };
    const snapshot = { ...input };
    transition(input);
    expect(input).toEqual(snapshot);
  });

  it('a rejected result carries the original from/event for audit', () => {
    const result = transition({ from: 'pending', event: 'finalized' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) {
      expect(result.from).toBe('pending');
      expect(result.event).toBe('finalized');
    }
  });
});

describe('TX-04: failed explicit retry records indeterminate without enabling automatic broadcasts', () => {
  it('broadcast can enter unknown only on the dedicated rebroadcast.indeterminate event', () => {
    expect(transition({ from: 'broadcast', event: 'rebroadcast.indeterminate' }))
      .toEqual({ ok: true, status: 'unknown' });
    expect(transition({ from: 'broadcast', event: 'broadcast.indeterminate' }).ok).toBe(false);
    expect(transition({ from: 'broadcast', event: 'broadcast.rejected' }).ok).toBe(false);
  });

  it('no other nonterminal status gets an implicit retry-indeterminate edge', () => {
    for (const from of ALL_STATUSES) {
      if (from === 'broadcast') continue;
      expect(transition({ from, event: 'rebroadcast.indeterminate' }).ok).toBe(false);
    }
  });
});

describe('dropped convergence edges (ADR-023)', () => {
  // Why these three edges must exist: `dropped` is a **judgment**, not a fact. If the transaction actually lands on-chain after a misjudgment,
  // missing convergence edges would leave the record stuck in dropped forever — reporting "dropped" for a confirmed transaction.
  it.each([
    ['mempool.entered', 'pending'],
    ['included', 'included'],
    ['replaced', 'replaced'],
  ] as const)('dropped + %s → %s', (event, to) => {
    const result = transition({ from: 'dropped', event });
    expect(ok(result), `dropped + ${event} should be allowed: ${JSON.stringify(result)}`).toBe(true);
    if (ok(result)) expect(result.status).toBe(to);
  });

  it('dropped → broadcast still requires an explicit rebroadcast: true (must not be relaxed by the new edges)', () => {
    const without = transition({ from: 'dropped', event: 'rebroadcast' });
    expect(ok(without)).toBe(false);
    if (!ok(without)) expect(without.reason).toBe('REBROADCAST_FLAG_REQUIRED');

    const withFlag = transition({ from: 'dropped', event: 'rebroadcast', rebroadcast: true });
    expect(ok(withFlag)).toBe(true);
    if (ok(withFlag)) expect(withFlag.status).toBe('broadcast');
  });

  it('dropped is still not terminal, and no new edges like dropped → signed/failed may appear', () => {
    expect(TERMINAL_STATUSES).not.toContain('dropped');
    expect(ok(transition({ from: 'dropped', event: 'broadcast.accepted' }))).toBe(false);
    expect(ok(transition({ from: 'dropped', event: 'broadcast.rejected' }))).toBe(false);
    expect(ok(transition({ from: 'dropped', event: 'sign' }))).toBe(false);
  });
});
