/**
 * Recovery sweep scheduler contract test (DFR-M1-D03 runtime supplement).
 *
 * Lifecycle semantics (idempotent start, single-flight, failure isolation, stop) are already covered
 * by `reorg-scheduler.test.ts` through the shared `PeriodicSweep` primitive;
 * this file only asserts the behaviors specific to the "recovery" task, avoiding testing the same implementation twice.
 */
import { describe, expect, it, vi } from 'vitest';
import { RecoveryScheduler } from '../src/recovery-scheduler.js';
import { PeriodicSweep } from '../src/periodic-sweep.js';

function fakeTimer() {
  let handler: (() => void) | undefined;
  const handle = { unref: () => undefined };
  return {
    setInterval: (fn: () => void) => {
      handler = fn;
      return handle as never;
    },
    clearInterval: () => {
      handler = undefined;
    },
    fire: () => handler?.(),
  };
}

describe('RecoveryScheduler (DFR-M1-D03 runtime supplement)', () => {
  it('the default interval is 10 minutes (more relaxed than the 5 minutes of the reorg sweep)', () => {
    const intervals: number[] = [];
    const timer = fakeTimer();
    const scheduler = new RecoveryScheduler({
      recover: async () => 0,
      setInterval: ((fn: () => void, ms: number) => {
        intervals.push(ms);
        return timer.setInterval(fn);
      }) as never,
      clearInterval: timer.clearInterval as never,
    });
    scheduler.start();
    expect(intervals).toEqual([10 * 60_000]);
    scheduler.stop();
  });

  it('passes the configured batch cap to RecoveryCoordinator.run', async () => {
    const timer = fakeTimer();
    const calls: number[] = [];
    const scheduler = new RecoveryScheduler({
      recover: async ({ limit }) => {
        calls.push(limit);
        return 3;
      },
      intervalMs: 1_000,
      batchLimit: 250,
      setInterval: timer.setInterval as never,
      clearInterval: timer.clearInterval as never,
    });
    scheduler.start();
    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([250]);
    scheduler.stop();
  });

  it('a single round failure is isolated and reported (same primitive semantics as the reorg sweep)', async () => {
    const timer = fakeTimer();
    const errors: unknown[] = [];
    const recover = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('prune failed'))
      .mockResolvedValue(0);
    const scheduler = new RecoveryScheduler({
      recover,
      intervalMs: 1_000,
      onError: (error) => errors.push(error),
      setInterval: timer.setInterval as never,
      clearInterval: timer.clearInterval as never,
    });
    scheduler.start();
    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);

    timer.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recover).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('shares the same primitive as ReorgScheduler: parameter error messages carry the name of each task', async () => {
    const base = {
      recover: async () => 0,
      setInterval: fakeTimer().setInterval as never,
      clearInterval: fakeTimer().clearInterval as never,
    };
    expect(() => new RecoveryScheduler({ ...base, intervalMs: 0 })).toThrow(/recovery scheduler/u);
    // Same when constructing the primitive directly; this is the observable evidence of "only one implementation".
    expect(
      () =>
        new PeriodicSweep({
          name: 'probe',
          run: async () => 0,
          intervalMs: 0,
          batchLimit: 1,
          onError: () => undefined,
          onSweep: () => undefined,
        }),
    ).toThrow(/probe/u);
  });
});
