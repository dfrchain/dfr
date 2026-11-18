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
    * Poll until the target is reached or the timeout; backoff starts at 1s, max 15s.
   *
    * An observation throwing `DFR_TRANSACTION_NOT_FOUND` is treated as "not yet visible on-chain", not a failure
    * (F-2): a just-broadcast transaction briefly invisible on a lagging RPC node is normal; continue polling as one
    * not-yet-reached round until the deadline, consistent with the background `runBackground` fault-tolerance semantics;
    * if it is still invisible at the deadline, return reached=false (observed='unknown'), leaving the caller
    * to synthesize the timeout and continue following in the background. Any other error is rethrown immediately.
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
         // Not yet visible: keep the last real observation (if any) and keep polling as not-yet-reached.
      }
      if (lastResult.reached || lastResult.owner === false || input.signal?.aborted === true || now() >= deadline) return lastResult;
      await sleep(Math.min(delay, Math.max(0, deadline - now())));
      delay = Math.min(delay * 2, 15_000);
    }
  }

   /** After a request wait times out, keep a single-process background scan; each observation is still serialized across processes via the lease. */
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
         // A background failure only delays the next read-only observation; it never broadcasts and never swallows any transaction state transition.
      }
      if (signal.aborted) return;
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }

  /**
    * Map on-chain confirmation facts onto the already-defined lifecycle events; each step still uses Store CAS.
    * When no reachable path exists, keep the record as-is; do not invent a state edge.
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
 * Check whether the anchor block of an included record is still canonical.
 * Uses only the existing `included → pending` state edge; chain RPC, Provider selection, and event transport are all the injected port's job.
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
     // A historical snapshot without a paired height/hash cannot be compared safely; leave it for a later observation to refresh.
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
