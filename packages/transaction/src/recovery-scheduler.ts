/**
 * 恢复巡检调度器（DFR-M1-D03 运行时补充）。
 *
 * 缺口：`RecoveryCoordinator`（D03）只在**启动**时跑一轮——过期幂等记录清理、
 * 孤儿 nonce 租约回收、unknown 交易解析。因此长期不重启的实例永远不会再回收它们，
 * 租约表与幂等表会随崩溃次数单调增长（TODO-009 记录的残余缺口）。
 *
 * 本类把同一份 `RecoveryCoordinator.run` 接入周期调度。安全性不变：恢复是幂等的、
 * 有界的，且 unknown 解析仍走 tracker lease（多实例下不会重复解析）。
 *
 * 默认间隔 10 分钟：比重组巡检更宽松——它是维护性回收，不是安全关键路径。
 * 生命周期语义由共用原语 `PeriodicSweep` 提供。
 */

import { PeriodicSweep } from './periodic-sweep.js';

export interface RecoverySchedulerDeps {
  /** 执行一轮有界恢复，返回本轮恢复数（即 `RecoveryCoordinator.run`）。 */
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
