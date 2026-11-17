/**
 * 重组巡检调度器契约测试（DFR-M1-D07 遗留运行时缺口）。
 *
 * 背景：`ReorgReconciler`（D04/ADR-021）早已实现并通过组件级测试，但**没有任何常驻调度**，
 * 即"生产上不会自动发现重组"。本测试锁定调度器的四条运行时不变式：
 *   1. `start()` 幂等；重复调用不会挂第二个定时器；
 *   2. 单飞：上一轮未结束时不会并发启动下一轮；
 *   3. 单轮失败被隔离（回调上报），绝不让异常逃逸到进程级 unhandled rejection；
 *   4. `stop()` 之后不再触发任何一轮，且可重复调用。
 *
 * 全部用注入的假定时器 + 假时钟，不依赖真实时间。
 */
import { describe, expect, it, vi } from 'vitest';
import { ReorgScheduler } from '../src/reorg-scheduler.js';

/** 可手动推进的假定时器。 */
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

describe('ReorgScheduler（DFR-M1-D07 遗留缺口）', () => {
  it('start() 幂等：重复调用只挂一个定时器，且 unref 以免阻塞进程退出', () => {
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

  it('单飞：上一轮未 resolve 时，定时器再次触发不会并发启动第二轮', async () => {
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

    // 上一轮结束后，下一次触发才能启动新一轮。
    timer.fire();
    expect(reconcile).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('单轮失败被隔离并上报，不产生未处理拒绝，且下一轮仍会运行', async () => {
    const timer = fakeTimer();
    const errors: unknown[] = [];
    const reconcile = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('canonical block RPC down'))
      .mockResolvedValue(0);
    // 不能用 `vi.spyOn(process, 'emit')` 来断言"没有 unhandledRejection"：
    // vitest 的 worker 依赖 process.emit 做 IPC，拦掉它会吞掉内部消息、**随机卡死整个测试进程**
    // （本仓库实测约 1/3 概率挂起）。改为监听 `unhandledRejection` 事件本身——
    // 既不侵入 IPC，又直接断言我们真正关心的性质。
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
    // 关键性质：单轮失败被 onError 吸收，**没有**变成进程级未处理拒绝。
    // 让微任务与 I/O 各排空一轮，给潜在的 unhandledRejection 足够时间浮现。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    expect(errors[0]).toBeInstanceOf(Error);

    process.off('unhandledRejection', onUnhandled);
    scheduler.stop();
  });

  it('stop() 清除定时器且不再触发；重复 stop() 安全', () => {
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

  it('把配置的批次上限传给 ReorgReconciler.run', async () => {
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

  it('拒绝非法 intervalMs / batchLimit（fail-closed，不静默用默认值）', () => {
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
