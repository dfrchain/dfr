/**
 * 重组巡检调度器（DFR-M1-D04 运行时补充）。
 *
 * 为什么需要它：`ReorgReconciler`（D04，ADR-021）能安全地把被重组掉的 included 交易
 * 回退到 pending，但在此之前**没有任何常驻调度**——即生产环境不会自动发现重组，
 * 该缺口在 D04/D05/D07 交付报告中被反复登记为发布阻塞项。本类只负责"周期性触发一次
 * 有界巡检"，所有安全性（tracker lease、CAS、只处理 included、提交后才发布事件）
 * 仍由 ReorgReconciler 保证。
 *
 * 生命周期语义（幂等启动、单飞、失败隔离、`stop()` 幂等、`unref`、参数 fail-closed）
 * 由共用原语 `PeriodicSweep` 实现并测试；本类只是把"重组"这个具体任务接到原语上，
 * 避免第二份并发关键代码。
 */

import { PeriodicSweep } from './periodic-sweep.js';

export interface ReorgSchedulerDeps {
  /** 执行一轮有界巡检，返回本轮回退的交易数（即 `ReorgReconciler.run`）。 */
  readonly reconcile: (input: { readonly limit: number }) => Promise<number>;
  /** 巡检间隔（毫秒）。默认 5 分钟：重组是低频事件，不需要高频轮询。 */
  readonly intervalMs?: number;
  /** 单轮扫描上限。默认 100，与启动恢复扫描同量级；上限由 ReorgReconciler 再校验（1..500）。 */
  readonly batchLimit?: number;
  /** 单轮失败的观测出口；默认静默（调用方可注入结构化日志）。 */
  readonly onError?: (error: unknown) => void;
  /** 单轮成功的观测出口（回退数 > 0 时才有意义）。 */
  readonly onSweep?: (rolledBack: number) => void;
  /** 注入点（测试用）；默认全局 setInterval / clearInterval。 */
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

  /** 立即执行一轮；单飞语义见 `PeriodicSweep.tick`。 */
  tick(): Promise<number> {
    return this.sweep.tick();
  }
}
