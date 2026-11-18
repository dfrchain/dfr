// Graceful shutdown signal handling contract test (DFR-M1-E02).
//
// Authoritative source: the m1-taskbook E02 handover — "the graceful shutdown order is already implemented in main.ts … E02 should write that order
// into the operations docs and add termination-signal tests".
//
// The orchestration order (main.ts) itself is the composition root's job; this test locks in the **signal-to-close() wiring**:
//   1. both SIGTERM and SIGINT must trigger shutdown;
//   2. repeated signals must not concurrently repeat the shutdown (idempotent), and the second should exit quickly rather than hang;
//   3. a failed shutdown must have a non-zero exit code, or the orchestrator will mistake a crash for a normal stop.
import { describe, expect, it, vi } from 'vitest';
import { installShutdownHandlers } from '../src/main.js';

type Handler = () => void;

/** Only implement the surface that is used, to avoid really attaching signal handlers to the test process. */
function fakeProcess(): {
  proc: { on(event: string, handler: Handler): void };
  emit(event: string): Promise<void>;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    proc: {
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    },
    emit: async (event) => {
      handlers.get(event)?.();
      // The handler internals are a promise chain; let microtasks drain before asserting side effects.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('graceful shutdown signals (DFR-M1-E02)', () => {
  it('SIGTERM triggers one close() and ends with exit code 0', async () => {
    const log = vi.fn();
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const { proc, emit, handlers } = fakeProcess();

    installShutdownHandlers(
      { close },
      { process: proc as never, exit: exit as never, log: log as never },
    );
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);

    await emit('SIGTERM');
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('SIGINT is equivalent to SIGTERM', async () => {
    const log = vi.fn();
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();
    const { proc, emit } = fakeProcess();

    installShutdownHandlers(
      { close },
      { process: proc as never, exit: exit as never, log: log as never },
    );
    await emit('SIGINT');
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a signal received during shutdown does not concurrently repeat the shutdown, and force-exits with a non-zero code', async () => {
    const log = vi.fn();
    let release = (): void => undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const exit = vi.fn();
    const { proc, handlers } = fakeProcess();

    installShutdownHandlers(
      { close },
      { process: proc as never, exit: exit as never, log: log as never },
    );

    handlers.get('SIGTERM')?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledTimes(1);

    handlers.get('SIGTERM')?.();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a failed close() ends with a non-zero exit code, without writing raw exception text into logs', async () => {
    const log = vi.fn();
    const exit = vi.fn();
    const { proc, emit } = fakeProcess();
    const close = vi.fn(async () => {
      throw new Error('pool.end failed: postgres://user:secret@db.internal/dfr');
    });

    installShutdownHandlers(
      { close },
      { process: proc as never, exit: exit as never, log: log as never },
    );
    await emit('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('db.internal');
  });
});
