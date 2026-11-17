// 优雅关闭信号处理契约测试（DFR-M1-E02）。
//
// 权威来源：m1-taskbook E02 交底——"优雅关闭顺序已在 main.ts 实现……E02 应把该顺序
// 写入运维文档并加终止信号测试"。
//
// 编排顺序（main.ts）本身由 composition root 负责；本测试锁定**信号到 close() 的接线**：
//   1. SIGTERM / SIGINT 都必须触发关闭；
//   2. 重复信号不得并发重复关闭（幂等），且第二次应快速退出而不是挂住；
//   3. 关闭失败必须非零退出码，否则编排系统会把崩溃当成正常停机。
import { describe, expect, it, vi } from 'vitest';
import { installShutdownHandlers } from '../src/main.js';

type Handler = () => void;

/** 只实现被用到的表面，避免真的给测试进程挂信号处理器。 */
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
      // 处理器内部是 promise 链；让微任务排空后再断言副作用。
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('优雅关闭信号（DFR-M1-E02）', () => {
  it('SIGTERM 触发一次 close() 并以退出码 0 结束', async () => {
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

  it('SIGINT 与 SIGTERM 等价', async () => {
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

  it('关闭进行中再次收到信号不会并发重复关闭，并以非零码强制退出', async () => {
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

  it('close() 失败时以非零退出码结束，且不把异常原文写进日志', async () => {
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
