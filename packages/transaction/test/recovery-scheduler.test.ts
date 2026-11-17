/**
 * 恢复巡检调度器契约测试（DFR-M1-D03 运行时补充）。
 *
 * 生命周期语义（幂等启动、单飞、失败隔离、stop）已由
 * `reorg-scheduler.test.ts` 通过共用原语 `PeriodicSweep` 覆盖；
 * 本文件只断言"恢复"任务特有的行为，避免重复测试同一实现。
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

describe('RecoveryScheduler（DFR-M1-D03 运行时补充）', () => {
  it('默认间隔是 10 分钟（比重组巡检的 5 分钟宽松）', () => {
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

  it('把配置的批次上限传给 RecoveryCoordinator.run', async () => {
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

  it('单轮失败被隔离并上报（与重组巡检同一原语语义）', async () => {
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

  it('与 ReorgScheduler 共用同一个原语：参数错误信息带各自任务名', () => {
    const base = {
      recover: async () => 0,
      setInterval: fakeTimer().setInterval as never,
      clearInterval: fakeTimer().clearInterval as never,
    };
    expect(() => new RecoveryScheduler({ ...base, intervalMs: 0 })).toThrow(/recovery scheduler/u);
    // 直接构造原语时同理；这是"只有一个实现"的可观测证据。
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
