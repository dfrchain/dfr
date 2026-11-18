/**
 * `tx.*` event end-to-end wiring (remaining M2 items).
 *
 * Verified at two layers:
 *  - the mapping itself (this file): coverage of state → `tx.*` event types;
 *  - the engine emitting events (`packages/transaction/test/transition-events.test.ts`):
 *    every successful transition emits, a throwing sink does not affect business logic, and no error when un-injected.
 *
 * Why no "build → SSE" end-to-end: it needs a complete chain stub to make build succeed,
 * and in this repo its value and stability are worse than the two layers above (the real chain path is already covered by
 * `m1-write.e2e.test.ts` and `m1-broadcast.e2e.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { statusToEventType } from '../src/main.js';


describe('statusToEventType mapping', () => {
  it('covers all 12 tx.* states in the spec event table', () => {
    const mapping = {
      built: 'tx.built', simulated: 'tx.simulated', signed: 'tx.signed', broadcast: 'tx.broadcast',
      pending: 'tx.pending', included: 'tx.included', confirmed: 'tx.confirmed', finalized: 'tx.finalized',
      failed: 'tx.failed', reverted: 'tx.reverted', dropped: 'tx.dropped', replaced: 'tx.replaced',
    } as const;
    for (const [status, type] of Object.entries(mapping)) {
      expect(statusToEventType(status), status).toBe(type);
    }
    // `unknown` has no corresponding event (the spec event table has no tx.unknown).
    expect(statusToEventType('unknown')).toBeUndefined();
  });
});
