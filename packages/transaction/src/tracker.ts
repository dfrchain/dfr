import { randomUUID } from 'node:crypto';
import { reachesFinalityLevel } from '@dfr/types';
import type {
  ChainEvent,
  ChainId,
  Cursor,
  FinalityLevel,
  FinalityState,
  ConfirmationResult,
  RequestId,
  TransactionId,
} from '@dfr/types';
import { isDfrError, newRequestId } from '@dfr/errors';
import { transition, type TransactionEvent } from './state-machine.js';
import type { ReorgEventPayload } from '@dfr/types';
import type { TrackerLeaseStore, TransactionRecord, TransactionStore, TransitionPatch } from './stores.js';
import type { TransactionMetricsSink } from './metrics.js';

export interface ConfirmationObservation {
  readonly observed: FinalityState;
  readonly reached?: boolean;
  readonly confirmation?: ConfirmationResult;
}
export interface ConfirmationTrackerDeps {
  readonly leases: TrackerLeaseStore;
  readonly transactions?: TransactionStore;
  readonly metrics?: TransactionMetricsSink;
  readonly observe: (input: {
    chain: ChainId;
    txHash: string;
    stickyKey: string;
    required?: FinalityLevel;
    requestId?: RequestId;
    traceId?: string;
    spanId?: string;
    signal?: AbortSignal;
  }) => Promise<ConfirmationObservation>;
  readonly ownerToken: () => string;
  readonly leaseTtlMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}
export type ConfirmationTrackResult =
  | { readonly reached: false; readonly owner: false }
  | {
      readonly reached: boolean;
      readonly owner: true;
      readonly observed: FinalityState;
      readonly confirmation?: ConfirmationResult;
    };

export class ConfirmationTracker {
  private readonly background = new Map<string, AbortController>();

  constructor(private readonly deps: ConfirmationTrackerDeps) {}
  async track(input: {
    chain: ChainId;
    txHash: string;
    required?: FinalityLevel;
    requestId?: RequestId;
    traceId?: string;
    spanId?: string;
    signal?: AbortSignal;
  }): Promise<ConfirmationTrackResult> {
    const ownerToken = this.deps.ownerToken();
    const acquired = await this.deps.leases.acquire({ chain: input.chain, txHash: input.txHash, ownerToken, leaseTtlMs: this.deps.leaseTtlMs ?? 30_000 });
    this.deps.metrics?.recordLease({ chain: input.chain, outcome: acquired.kind === 'held_by_other' ? 'held_by_other' : 'acquired' });
    if (acquired.kind === 'held_by_other') return { reached: false, owner: false };
    try {
      const renewed = await this.deps.leases.renew({ chain: input.chain, txHash: input.txHash, ownerToken, leaseTtlMs: this.deps.leaseTtlMs ?? 30_000 });
      this.deps.metrics?.recordLease({ chain: input.chain, outcome: renewed.kind });
      if (renewed.kind === 'lost') return { reached: false, owner: false };
      const observation = await this.deps.observe({
        chain: input.chain,
        txHash: input.txHash,
        stickyKey: `${input.chain}:${input.txHash}`,
        ...(input.required !== undefined ? { required: input.required } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      if (observation.confirmation !== undefined) {
        await this.persistObservedLifecycle(input.chain, input.txHash, observation.confirmation, input.requestId);
      }
      const reached = observation.reached ?? (input.required !== undefined
        ? reachesFinalityLevel(observation.observed, input.required)
        : false);
      return {
        reached,
        owner: true,
        observed: observation.observed,
        ...(observation.confirmation !== undefined ? { confirmation: observation.confirmation } : {}),
      };
    } finally {
      const released = await this.deps.leases.release({ chain: input.chain, txHash: input.txHash, ownerToken });
      this.deps.metrics?.recordLease({ chain: input.chain, outcome: released.kind });
    }
  }

  /**
   * 轮询到达目标或超时；退避从 1s 起、最多 15s。
   *
   * 观测抛 `DFR_TRANSACTION_NOT_FOUND` 视为「链上尚不可见」而非失败
   * （F-2）：刚广播的交易在滞后 RPC 节点上短暂查无此笔是常态，按一次
   * 未达目标的轮询继续至截止，与后台 `runBackground` 的容错语义一致；
   * 截止时仍不可见则返回 reached=false（observed='unknown'），由调用方
   * 走超时合成与后台续跟。其余任何错误立即上抛。
   */
  async trackUntil(input: {
    chain: ChainId;
    txHash: string;
    required?: FinalityLevel;
    timeoutMs: number;
    requestId?: RequestId;
    traceId?: string;
    spanId?: string;
    signal?: AbortSignal;
  }): Promise<ConfirmationTrackResult> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? (async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + input.timeoutMs;
    let delay = 1_000;
    let lastResult: ConfirmationTrackResult = { reached: false, owner: true, observed: 'unknown' };
    for (;;) {
      try {
        lastResult = await this.track(input);
      } catch (err) {
        if (!isDfrError(err) || err.code !== 'DFR_TRANSACTION_NOT_FOUND') throw err;
        // 尚不可见：保留上一次真实观测（若有），按未达目标继续轮询。
      }
      if (lastResult.reached || lastResult.owner === false || input.signal?.aborted === true || now() >= deadline) return lastResult;
      await sleep(Math.min(delay, Math.max(0, deadline - now())));
      delay = Math.min(delay * 2, 15_000);
    }
  }

  /** 请求等待超时后维持单进程后台扫描；每次观测仍经跨进程 lease 串行化。 */
  continueInBackground(input: { chain: ChainId; txHash: string; required?: FinalityLevel }): void {
    const key = `${input.chain}:${input.txHash}`;
    if (this.background.has(key)) return;
    const controller = new AbortController();
    this.background.set(key, controller);
    void this.runBackground(input, controller.signal).finally(() => this.background.delete(key));
  }

  stopBackground(): void {
    for (const controller of this.background.values()) controller.abort();
    this.background.clear();
  }

  private async runBackground(
    input: { chain: ChainId; txHash: string; required?: FinalityLevel },
    signal: AbortSignal,
  ): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }));
    let delay = 1_000;
    while (!signal.aborted) {
      try {
        const result = await this.track({ ...input, signal });
        if (result.reached) return;
      } catch {
        // 后台失败只会延后下一次只读观测；永不广播，也不吞掉任何交易状态转换。
      }
      if (signal.aborted) return;
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }

  /**
   * 将链上确认事实映射到已经定义的生命周期事件；每一步仍使用 Store CAS。
   * 不存在可达路径时保持记录原状，不发明状态边。
   */
  private async persistObservedLifecycle(
    chain: ChainId,
    txHash: string,
    confirmation: ConfirmationResult,
    requestId?: RequestId,
  ): Promise<void> {
    if (this.deps.transactions === undefined) return;
    const events = lifecycleEvents(confirmation.status);
    if (events.length === 0) return;
    for (const event of events) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await this.deps.transactions.getByHash(chain, txHash);
        if (current === null) return;
        const next = transition({ from: current.status, event });
        if (!next.ok) continue;
        const transitionPatch: TransitionPatch = {
          ...(event === 'included' && confirmation.blockRef !== undefined
            ? { blockRef: confirmation.blockRef }
            : {}),
          ...(event === 'included' && confirmation.canonicalBlockHash !== undefined
            ? { canonicalBlockHash: confirmation.canonicalBlockHash }
            : {}),
          ...(current.txHash === undefined ? { txHash } : {}),
        };
        const moved = await this.deps.transactions.transition({
          transactionId: current.transactionId,
          expectedStatus: current.status,
          expectedVersion: current.stateVersion,
          toStatus: next.status,
          reason: event,
          ...(requestId !== undefined ? { requestId } : {}),
          ...(Object.keys(transitionPatch).length > 0 ? { patch: transitionPatch } : {}),
        });
        if (moved.kind === 'applied') break;
        if (moved.kind === 'not_found') return;
        if (attempt === 2) return;
      }
    }
  }
}

type PersistedLifecycleEvent = TransactionEvent;

function lifecycleEvents(status: TransactionRecord['status']): readonly PersistedLifecycleEvent[] {
  switch (status) {
    case 'pending': return ['mempool.entered'];
    case 'included': return ['mempool.entered', 'included'];
    case 'confirmed': return ['mempool.entered', 'included', 'confirmed'];
    case 'finalized': return ['mempool.entered', 'included', 'confirmed', 'finalized'];
    case 'reverted': return ['execution.failed'];
    case 'replaced': return ['replaced'];
    case 'dropped': return ['dropped'];
    default: return [];
  }
}

export interface ReorgReconcilerDeps {
  readonly transactions: TransactionStore;
  readonly leases: TrackerLeaseStore;
  readonly metrics?: TransactionMetricsSink;
  readonly canonicalBlockHash: (input: {
    readonly chain: ChainId;
    readonly blockRef: NonNullable<TransactionRecord['blockRef']>;
    readonly stickyKey: string;
  }) => Promise<string | null>;
  readonly publish: (event: ChainEvent<ReorgEventPayload>) => Promise<void> | void;
  readonly ownerToken: () => string;
  readonly leaseTtlMs?: number;
  readonly now?: () => string;
}

/**
 * 检查 included 记录锚定区块是否仍为 canonical。
 * 仅使用既有 `included → pending` 状态边；链 RPC、Provider 选择与事件传输均由注入端口负责。
 */
export class ReorgReconciler {
  private cursor = 0n;

  constructor(private readonly deps: ReorgReconcilerDeps) {}

  async run(input: { limit: number }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }
    let afterTransactionId: TransactionId | undefined;
    let rolledBack = 0;
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        statuses: ['included'],
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      for (const record of records) {
        if (await this.reconcile(record)) rolledBack += 1;
      }
      if (records.length < input.limit) return rolledBack;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
  }

  private async reconcile(record: TransactionRecord): Promise<boolean> {
    const blockRef = record.blockRef;
    const blockHash = record.canonicalBlockHash;
    const txHash = record.txHash ?? record.expectedHash;
    // 历史快照没有成对的高度/hash 时无法安全比较，留给后续观测刷新。
    if (blockRef === undefined || blockHash === undefined || txHash === undefined) return false;

    const ownerToken = this.deps.ownerToken();
    const leaseInput = {
      chain: record.chain,
      txHash,
      ownerToken,
      leaseTtlMs: this.deps.leaseTtlMs ?? 30_000,
    };
    const acquired = await this.deps.leases.acquire(leaseInput);
    if (acquired.kind === 'held_by_other') return false;

    try {
      const renewed = await this.deps.leases.renew(leaseInput);
      if (renewed.kind === 'lost') return false;
      const canonicalHash = await this.deps.canonicalBlockHash({
        chain: record.chain,
        blockRef,
        stickyKey: `${record.chain}:${txHash}`,
      });
      if (canonicalHash === null || canonicalHash === blockHash) return false;

      const allowed = transition({ from: record.status, event: 'reorg' });
      if (!allowed.ok) return false;
      const moved = await this.deps.transactions.transition({
        transactionId: record.transactionId,
        expectedStatus: record.status,
        expectedVersion: record.stateVersion,
        toStatus: allowed.status,
        reason: 'reorg',
        requestId: newRequestId(),
        patch: { blockRef: null, canonicalBlockHash: null },
      });
      if (moved.kind !== 'applied') return false;
      this.deps.metrics?.recordReorg({ chain: record.chain, depthBucket: 'unknown' });

      // Publish only after the Store confirms its atomic snapshot + audit transition commit.
      this.cursor += 1n;
      const now = this.deps.now ?? (() => new Date().toISOString());
      const event: ChainEvent<ReorgEventPayload> = {
        eventId: randomUUID(),
        cursor: this.cursor.toString(10) as Cursor,
        type: 'chain.reorg',
        chain: record.chain,
        blockRef: { kind: 'hash', hash: canonicalHash },
        payload: {
          oldBlockRef: { kind: 'hash', hash: blockHash },
          newBlockRef: { kind: 'hash', hash: canonicalHash },
          affectedTransactions: [txHash],
        },
        schemaVersion: '1',
        occurredAt: now() as ChainEvent<ReorgEventPayload>['occurredAt'],
      };
      await this.deps.publish(event);
      return true;
    } finally {
      await this.deps.leases.release({ chain: record.chain, txHash, ownerToken });
    }
  }
}
