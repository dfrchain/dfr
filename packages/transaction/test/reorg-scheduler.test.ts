/**
 * Reorg sweep scheduler contract test (a leftover runtime gap from DFR-M1-D07).
 *
 * Background: `ReorgReconciler` (D04/ADR-021) was implemented long ago and passed component-level tests, but there was **no standing scheduler**,
 * i.e. "production would never auto-discover a reorg". This test locks the scheduler's four runtime invariants:
 *   1. `start()` is idempotent; repeated calls do not hang a second timer;
 *   2. single-flight: the next round never starts concurrently while the previous one is unfinished;
 *   3. a single round's failure is isolated (reported via callback) and never lets an exception escape to a process-level unhandled rejection;
 *   4. after `stop()`, no round fires again, and it can be called repeatedly.
 *
 * All with injected fake timers + a fake clock; no dependence on real time.
 */
import { describe, expect, it, vi } from 'vitest';
import { ReorgScheduler } from '../src/reorg-scheduler.js';

/** A fake timer that can be advanced manually. */
function fakeTimer() {
  let handler: (() => void) | undefined;
  let cleared = false;
  let unrefCalled = false;
  const handle = {
    unref: () => {
      unrefCalled = true;
    },
  };
  return {
    setInterval: (fn: () => void, _ms: number) => {
      handler = fn;
      return handle;
    },
    clearInterval: () => {
      cleared = true;
      handler = undefined;
    },
    get isCleared() {
      return cleared;
    },
    get isUnref() {
      return unrefCalled;
    },
    fire: () => handler?.(),
    get armed() {
      return handler !== undefined;
    },
  };
}

describe('ReorgScheduler (a leftover gap from DFR-M1-D07)', () => {
  it('start() is idempotent: repeated calls hang only one timer, and unref so it does not block process exit', () => {
    const timer = fakeTimer();
    const reconcile = vi.fn(async () => 0);
    const scheduler = new ReorgScheduler({
      reconcile,
      intervalMs: 60_000,
      setInterval: timer.setInterval as never,
      clearInterval: timer.clearInterval as never,
    });

    scheduler.start();
    scheduler.start();

    expect(timer.armed).toBe(true);
    expect(timer.isUnref).toBe(true);
    scheduler.stop();
  });

  it('single-flight: while the previous round is unresolved, the timer firing again does not start a second round concurrently', async () => {
    const timer = fakeTimer();
    let resolveFirst: ((value: number) => void) | undefined;
    const reconcile = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const scheduler = new ReorgScheduler({
      reconcile,
      intervalMs: 1_000,
      setInterval: timer.setInterval as never,
      clearInterval: timer.clearInterval as never,
    });
    scheduler.start();

    timer.fire();
    timer.fire();
    timer.fire();
    expect(reconcile).toHaveBeenCalledTimes(1);

    resolveFirst?.(0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Only after the previous round ends may the next trigger start a new round.
    timer.fire();
    expect(reconcile).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('a single round failure is isolated and reported, produces no unhandled rejection, and the next round still runs', async () => {
    const timer = fakeTimer();
    const errors: unknown[] = [];
    const reconcile = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('canonical block RPC down'))
      .mockResolvedValue(0);
    // `vi.spyOn(process, 'emit')` cannot be used to assert "no unhandledRejection":
    // vitest workers rely on process.emit for IPC; intercepting it would swallow internal messages and **randomly hang the whole test process**
    // (measured at roughly 1/3 probability of hanging in this repo). Instead, listen to the `unhandledRejection` event itself —
    // neither intruding on IPC nor asserting anything but the property we actually care about.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const scheduler = new ReorgScheduler({
      reconcile,
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
    expect(reconcile).toHaveBeenCalledTimes(2);
    // Key property: a single round failure is absorbed by onError and did **not** become a process-level unhandled rejection.
    // Drain microtasks and I/O once each, giving any potential unhandledRejection enough time to surface.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    expect(errors[0]).toBeInstanceOf(Error);

    process.off('unhandledRejection', onUnhandled);
    scheduler.stop();
  });

  it('stop() clears the timer and nothing fires again; repeating stop() is safe', () => {
    const timer = fakeTimer();
    const reconcile = vi.fn(async () => 0);
    const scheduler = new ReorgScheduler({
      reconcile,
      intervalMs: 1_000,
      setInterval: timer.setInterval as never,
      clearInterval: timer.clearInterval as never,
    });
    scheduler.start();
    scheduler.stop();
    scheduler.stop();

    expect(timer.isCleared).toBe(true);
    timer.fire();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('passes the configured batch cap to ReorgReconciler.run', async () => {
    const timer = fakeTimer();
    const calls: number[] = [];
    const scheduler = new ReorgScheduler({
      reconcile: async ({ limit }) => {
        calls.push(limit);
        return 0;
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

  it('rejects an illegal intervalMs / batchLimit (fail-closed, no silent default)', async () => {
    const base = {
      reconcile: async () => 0,
      setInterval: fakeTimer().setInterval as never,
      clearInterval: fakeTimer().clearInterval as never,
    };
    expect(() => new ReorgScheduler({ ...base, intervalMs: 0 })).toThrow(RangeError);
    expect(() => new ReorgScheduler({ ...base, intervalMs: 1.5 })).toThrow(RangeError);
    expect(() => new ReorgScheduler({ ...base, intervalMs: 1_000, batchLimit: 0 })).toThrow(RangeError);
    expect(() => new ReorgScheduler({ ...base, intervalMs: 1_000, batchLimit: 501 })).toThrow(RangeError);
  });
});
