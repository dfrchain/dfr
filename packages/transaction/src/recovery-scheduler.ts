/**
 * Recovery sweep scheduler (DFR-M1-D03 runtime supplement).
 *
 * The gap: `RecoveryCoordinator` (D03) only runs one round at **startup** — expired idempotency cleanup,
 * orphaned nonce lease reclamation, unknown transaction resolution. So an instance that runs for a long time without restarting never reclaims them,
 * and the lease and idempotency tables grow monotonically with the number of crashes (the residual gap recorded in TODO-009).
 *
 * This class plugs the same `RecoveryCoordinator.run` into periodic scheduling. Safety is unchanged: recovery is idempotent,
 * bounded, and unknown resolution still goes through the tracker lease (no duplicate resolution across instances).
 *
 * Default interval 10 minutes: more relaxed than the reorg sweep — it is maintenance reclamation, not a safety-critical path.
 * Lifecycle semantics come from the shared `PeriodicSweep` primitive.
 */

import { PeriodicSweep } from './periodic-sweep.js';

export interface RecoverySchedulerDeps {
   /** Run one bounded recovery round, returning this round's recovery count (i.e. `RecoveryCoordinator.run`). */
  readonly recover: (input: { readonly limit: number }) => Promise<number>;
  readonly intervalMs?: number;
  readonly batchLimit?: number;
  readonly onError?: (error: unknown) => void;
  readonly onSweep?: (recovered: number) => void;
  readonly setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_BATCH_LIMIT = 100;

export class RecoveryScheduler {
  private readonly sweep: PeriodicSweep;

  constructor(deps: RecoverySchedulerDeps) {
    this.sweep = new PeriodicSweep({
      name: 'recovery scheduler',
      run: deps.recover,
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

  tick(): Promise<number> {
    return this.sweep.tick();
  }
}
