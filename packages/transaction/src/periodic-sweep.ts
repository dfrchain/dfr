/**
 * Bounded periodic-sweep primitive (DFR-M1-D04/D03 runtime supplement).
 *
 * Why extract it: M1 has two background maintenance jobs needing **exactly the same** lifecycle semantics —
 *   1. the reorg sweep (`ReorgReconciler`, D04/ADR-021);
 *   2. the recovery sweep (`RecoveryCoordinator`, D03: expired idempotency cleanup, orphaned nonce lease reclamation, unknown resolution).
 * These semantics (idempotent start, single-flight, failure isolation, `unref`, fail-closed parameters) are concurrency-critical code;
 * duplicating them means two copies to test separately, and fixes easily landing in only one. So they converge into one primitive,
 * thinly wrapped by `ReorgScheduler` and `RecoveryScheduler` respectively.
 *
 * Four runtime invariants (locked by packages/transaction/test/periodic-sweep.test.ts):
 * 1. `start()` is idempotent: repeated calls do not hang a second timer; the timer is `unref()`ed and does not keep the process alive;
 * 2. Single-flight: no next round starts while the previous one is still running — a self-stacking sweep amplifies RPC/database pressure during outages;
 * 3. A single round's failure is isolated: exceptions go to `onError` and never escape as a process-level unhandled rejection;
 * 4. `stop()` is idempotent, and nothing fires after it.
 *
 * This class only knows the "one bounded sweep" function; it does not import Adapter / Core / Storage / Provider.
 */

export interface PeriodicSweepDeps {
   /** A human-readable task name, used only in error messages (not in logic). */
  readonly name: string;
   /** Run one bounded sweep; the return-value semantics are defined by the caller (reverts / recoveries). */
  readonly run: (input: { readonly limit: number }) => Promise<number>;
  readonly intervalMs: number;
  readonly batchLimit: number;
  readonly onError: (error: unknown) => void;
  readonly onSweep: (result: number) => void;
   /** Injection point (for tests); defaults to the global setInterval / clearInterval. */
  readonly setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

/** Lower bound on the sweep interval: below 1s is unfriendly to both RPC and the database. */
export const MIN_SWEEP_INTERVAL_MS = 1_000;
/** Upper bound on the sweep interval: above 24h is the same as no sweep at all. */
export const MAX_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
/** Per-round cap: consistent with the 1..500 contract of `Store.listRecoverable` / `ReorgReconciler.run`. */
export const MAX_SWEEP_BATCH = 500;

/**
 * Validate the period and batch (fail-closed).
 *
 * Deliberately **not** silently falling back to defaults: if a mistyped sweep interval were silently swallowed, ops would believe the sweep is running
 * while it is actually using a different value. The caller (composition root) should pass the defaults explicitly.
 */
export function assertSweepOptions(input: {
  readonly name: string;
  readonly intervalMs: number;
  readonly batchLimit: number;
}): void {
  if (
    !Number.isInteger(input.intervalMs) ||
    input.intervalMs < MIN_SWEEP_INTERVAL_MS ||
    input.intervalMs > MAX_SWEEP_INTERVAL_MS
  ) {
    throw new RangeError(
      `${input.name} intervalMs must be an integer in ${MIN_SWEEP_INTERVAL_MS}..${MAX_SWEEP_INTERVAL_MS}`,
    );
  }
  if (!Number.isInteger(input.batchLimit) || input.batchLimit < 1 || input.batchLimit > MAX_SWEEP_BATCH) {
    throw new RangeError(`${input.name} batchLimit must be an integer in 1..${MAX_SWEEP_BATCH}`);
  }
}

export class PeriodicSweep {
  private readonly deps: PeriodicSweepDeps;
  private readonly setIntervalImpl: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalImpl: (handle: ReturnType<typeof setInterval>) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
   /** Single-flight flag: true means one sweep round is currently in flight. */
  private inFlight = false;

  constructor(deps: PeriodicSweepDeps) {
    assertSweepOptions(deps);
    this.deps = deps;
    this.setIntervalImpl = deps.setInterval ?? setInterval;
    this.clearIntervalImpl = deps.clearInterval ?? clearInterval;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

   /** Idempotent start. Repeated calls do not hang a second timer. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalImpl(() => {
      void this.tick();
    }, this.deps.intervalMs);
     // Sweeps are background maintenance work and must not keep the process alive (same convention as the Provider health sweep).
    this.timer.unref?.();
  }

   /** Idempotent stop; nothing fires after it. */
  stop(): void {
    if (this.timer === undefined) return;
    this.clearIntervalImpl(this.timer);
    this.timer = undefined;
  }

  /**
    * Run one round immediately (used by the timer; also callable directly by ops/tests).
   *
    * Single-flight: a call while one is in flight returns 0 directly, without queueing — queueing would let sweeps pile up without bound during outages.
   */
  async tick(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const result = await this.deps.run({ limit: this.deps.batchLimit });
      this.deps.onSweep(result);
      return result;
    } catch (error) {
       // Isolation: a single round's failure is only reported; it does not affect later rounds and never bubbles up as an unhandled rejection.
      this.deps.onError(error);
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}
