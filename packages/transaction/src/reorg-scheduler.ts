/**
 * Reorg sweep scheduler (DFR-M1-D04 runtime supplement).
 *
 * Why it is needed: `ReorgReconciler` (D04, ADR-021) can safely roll an included transaction that was reorged away
 * back to pending, but before this there was **no standing scheduler** — production would never auto-discover a reorg,
 * and that gap was repeatedly recorded as a release blocker in the D04/D05/D07 delivery reports. This class only handles "trigger one
 * bounded sweep periodically"; all safety (tracker lease, CAS, included-only, publish-after-commit events)
 * is still guaranteed by ReorgReconciler.
 *
 * Lifecycle semantics (idempotent start, single-flight, failure isolation, `stop()` idempotent, `unref`, fail-closed parameters)
 * are implemented and tested by the shared `PeriodicSweep` primitive; this class only plugs the "reorg" task into the primitive,
 * avoiding a second copy of concurrency-critical code.
 */

import { PeriodicSweep } from './periodic-sweep.js';

export interface ReorgSchedulerDeps {
   /** Run one bounded sweep round, returning this round's reverted transaction count (i.e. `ReorgReconciler.run`). */
  readonly reconcile: (input: { readonly limit: number }) => Promise<number>;
   /** Sweep interval (milliseconds). Defaults to 5 minutes: reorgs are low-frequency events and do not need high-frequency polling. */
  readonly intervalMs?: number;
   /** Per-round scan cap. Defaults to 100, same order as the startup recovery scan; the cap is re-validated by ReorgReconciler (1..500). */
  readonly batchLimit?: number;
   /** Observation outlet for a failed round; silent by default (callers may inject structured logging). */
  readonly onError?: (error: unknown) => void;
   /** Observation outlet for a successful round (only meaningful when the reverted count > 0). */
  readonly onSweep?: (rolledBack: number) => void;
   /** Injection point (for tests); defaults to the global setInterval / clearInterval. */
  readonly setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_BATCH_LIMIT = 100;

export class ReorgScheduler {
  private readonly sweep: PeriodicSweep;

  constructor(deps: ReorgSchedulerDeps) {
    this.sweep = new PeriodicSweep({
      name: 'reorg scheduler',
      run: deps.reconcile,
      intervalMs: deps.intervalMs ?? DEFAULT_INTERVAL_MS,
      batchLimit: deps.batchLimit ?? DEFAULT_BATCH_LIMIT,
      onError: deps.onError ?? (() => undefined),
      onSweep: deps.onSweep ?? (() => undefined),
      ...(deps.setInterval !== undefined ? { setInterval: deps.setInterval } : {}),
      ...(deps.clearInterval !== undefined ? { clearInterval: deps.clearInterval } : {}),
    });
  }

  get running(): boolean {
    return this.sweep.running;
  }

  start(): void {
    this.sweep.start();
  }

  stop(): void {
    this.sweep.stop();
  }

   /** Run one round immediately; single-flight semantics, see `PeriodicSweep.tick`. */
  tick(): Promise<number> {
    return this.sweep.tick();
  }
}
