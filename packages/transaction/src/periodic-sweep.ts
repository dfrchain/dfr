/**
 * 有界周期巡检原语（DFR-M1-D04/D03 运行时补充）。
 *
 * 为什么抽取：M1 有两个后台维护任务需要**完全相同**的生命周期语义——
 *   1. 重组巡检（`ReorgReconciler`，D04/ADR-021）；
 *   2. 恢复巡检（`RecoveryCoordinator`，D03：过期幂等清理、孤儿 nonce 租约回收、unknown 解析）。
 * 这些语义（幂等启动、单飞、失败隔离、`unref`、参数 fail-closed）属于并发关键代码，
 * 复制两份意味着两份都要单独被测、且很容易只修其中一份。因此收敛为一个原语，
 * 由 `ReorgScheduler` 与 `RecoveryScheduler` 各自薄封装。
 *
 * 四条运行时不变式（由 packages/transaction/test/periodic-sweep.test.ts 锁定）：
 * 1. `start()` 幂等：重复调用不会挂第二个定时器；定时器 `unref()`，不阻止进程退出；
 * 2. 单飞：上一轮未结束时不再启动下一轮——巡检自我叠加会在故障期放大 RPC/数据库压力；
 * 3. 单轮失败被隔离：异常交给 `onError`，绝不逃逸成进程级 unhandled rejection；
 * 4. `stop()` 幂等，之后不再触发。
 *
 * 本类只认识"一次有界巡检"这个函数，不 import Adapter / Core / Storage / Provider。
 */

export interface PeriodicSweepDeps {
  /** 人类可读的任务名，仅用于错误信息（不参与逻辑）。 */
  readonly name: string;
  /** 执行一轮有界巡检，返回值语义由调用方定义（回退数 / 恢复数）。 */
  readonly run: (input: { readonly limit: number }) => Promise<number>;
  readonly intervalMs: number;
  readonly batchLimit: number;
  readonly onError: (error: unknown) => void;
  readonly onSweep: (result: number) => void;
  /** 注入点（测试用）；默认全局 setInterval / clearInterval。 */
  readonly setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

/** 巡检间隔下界：低于 1s 对 RPC 与数据库都不友好。 */
export const MIN_SWEEP_INTERVAL_MS = 1_000;
/** 巡检间隔上界：高于 24h 等于没有巡检。 */
export const MAX_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
/** 单轮上限：与 `Store.listRecoverable` / `ReorgReconciler.run` 的 1..500 契约一致。 */
export const MAX_SWEEP_BATCH = 500;

/**
 * 校验周期与批次（fail-closed）。
 *
 * 故意**不**静默回落到默认值：一个写错的巡检间隔若被静默吞掉，运维会以为巡检在跑，
 * 而它其实用的是另一个值。调用方（composition root）应显式传默认值。
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
  /** 单飞标志：true 表示当前有一轮巡检在飞行中。 */
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

  /** 幂等启动。重复调用不会挂第二个定时器。 */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalImpl(() => {
      void this.tick();
    }, this.deps.intervalMs);
    // 巡检属后台维护工作，不应阻止进程退出（与 Provider 健康巡检同一约定）。
    this.timer.unref?.();
  }

  /** 幂等停止；停止后不再触发任何一轮。 */
  stop(): void {
    if (this.timer === undefined) return;
    this.clearIntervalImpl(this.timer);
    this.timer = undefined;
  }

  /**
   * 立即执行一轮（定时器触发用；也供运维/测试直接调用）。
   *
   * 单飞：飞行中再次调用直接返回 0，不排队——排队会让故障期间的巡检无限堆积。
   */
  async tick(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const result = await this.deps.run({ limit: this.deps.batchLimit });
      this.deps.onSweep(result);
      return result;
    } catch (error) {
      // 隔离：单轮失败只上报，不影响后续轮次，也不冒泡成 unhandled rejection。
      this.deps.onError(error);
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}
