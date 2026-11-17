/**
 * M1 引擎测试的**共享内存替身**（从 build.test.ts 抽出，见 ADR-037）。
 *
 * 抽出原因：ADR-037 的 preflight 与 build 需要同一套替身来断言"零副作用"，
 * 复制 300 行会立刻漂移。**只搬移，不改语义**。
 */
import type {
  AccountRef,
  ChainId,
  DecimalUint,
  Iso8601,
  RequestId,
  TransactionId,
  SimulationResult,
  TransactionRequest,
  UnsignedTransaction,
} from '@dfr/types';
import { createDfrError } from '@dfr/errors';
import {
  TransactionEngine,
  transition,
  type BeginIdempotencyInput,
  type BeginIdempotencyResult,
  type ChainBuildInput,
  type CompleteIdempotencyInput,
  type CompleteIdempotencyResult,
  type GetPendingNonceInput,
  type IdempotencyRecord,
  type IdempotencyScope,
  type IdempotencyStore,
  type NonceLease,
  type NonceLeaseRef,
  type NonceStore,
  type PruneExpiredIdempotencyInput,
  type ReserveNonceInput,
  type ReserveNonceResult,
  type TransactionChainPort,
  type TransactionEvent,
  type TransactionRecord,
  type TransactionStore,
  type TransitionTransactionInput,
  type TransitionTransactionResult,
} from '../../src/index.js';

export const CHAIN = 'ethereum-sepolia' as ChainId;
export const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };
export const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };
export const REQUEST_ID = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;

export const REQUEST: TransactionRequest = {
  chain: CHAIN,
  from: FROM,
  to: TO,
  value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000000000000000' as DecimalUint },
};

export const dec = (value: string): DecimalUint => value as DecimalUint;
export const iso = (ms: number): Iso8601 => new Date(ms).toISOString() as Iso8601;

/* ------------------------------------------------------------------ */
/* 替身：TransactionStore                                             */
/* ------------------------------------------------------------------ */

export class FakeTransactionStore implements TransactionStore {
  readonly records = new Map<TransactionId, TransactionRecord>();
  readonly created: TransactionRecord[] = [];

  async create({ record }: { record: TransactionRecord }) {
    const existing = this.records.get(record.transactionId);
    if (existing !== undefined) return { kind: 'already_exists' as const, record: existing };
    this.records.set(record.transactionId, record);
    this.created.push(record);
    return { kind: 'created' as const, record };
  }

  async get(transactionId: TransactionId): Promise<TransactionRecord | null> {
    return this.records.get(transactionId) ?? null;
  }

  async getByHash(chain: ChainId, txHash: string): Promise<TransactionRecord | null> {
    return [...this.records.values()].find((record) => record.chain === chain &&
      (record.txHash === txHash || record.expectedHash === txHash)) ?? null;
  }

  async transition(input: TransitionTransactionInput): Promise<TransitionTransactionResult> {
    const current = this.records.get(input.transactionId);
    if (current === undefined) return { kind: 'not_found' };
    if (current.stateVersion !== input.expectedVersion) {
      return { kind: 'version_conflict', current };
    }
    if (current.status !== input.expectedStatus) {
      return { kind: 'status_conflict', current };
    }
    // 替身按 reason 映射事件；未列出的事件说明测试用到了替身尚未支持的边。
    // ADR-037 起 `abandon` 是合法事件（state-machine 已定义），这里必须认识它，
    // 否则 abandon 测试会以"状态机拒绝"的假象失败。
    const eventMap: Record<string, TransactionEvent> = {
      'broadcast.accepted': 'broadcast.accepted',
      build: 'build',
      sign: 'sign',
      abandon: 'abandon',
      'simulate.succeeded': 'simulate.succeeded',
      'simulate.failed': 'simulate.failed',
      'execution.failed': 'execution.failed',
    };
    const mappedEvent = eventMap[input.reason];
    if (mappedEvent === undefined) {
      throw new Error(`FakeTransactionStore: 未映射的 transition reason 「${input.reason}」`);
    }
    const moved = transition({
      from: current.status,
      event: mappedEvent,
      ...(input.toStatus === 'broadcast' ? { rebroadcast: false } : {}),
    });
    if (!moved.ok) return { kind: 'status_conflict', current };
    const patch = input.patch ?? {};
    const { blockRef: patchBlockRef, canonicalBlockHash: patchBlockHash, ...otherPatch } = patch;
    const { blockRef: currentBlockRef, canonicalBlockHash: currentBlockHash, ...currentWithoutAnchors } = current;
    const next: TransactionRecord = {
      ...currentWithoutAnchors,
      ...otherPatch,
      ...(patchBlockRef === null ? {} : patchBlockRef !== undefined
        ? { blockRef: patchBlockRef }
        : currentBlockRef !== undefined ? { blockRef: currentBlockRef } : {}),
      ...(patchBlockHash === null ? {} : patchBlockHash !== undefined
        ? { canonicalBlockHash: patchBlockHash }
        : currentBlockHash !== undefined ? { canonicalBlockHash: currentBlockHash } : {}),
      status: input.toStatus,
      stateVersion: dec((BigInt(current.stateVersion) + 1n).toString(10)),
      updatedAt: '2026-10-04T00:00:00.000Z' as Iso8601,
    };
    this.records.set(input.transactionId, next);
    return { kind: 'applied', record: next };
  }

  async listRecoverable(): Promise<readonly TransactionRecord[]> {
    return [...this.records.values()];
  }
}

/* ------------------------------------------------------------------ */
/* 替身：IdempotencyStore                                             */
/* ------------------------------------------------------------------ */

interface FakeIdemRow {
  fingerprint: string;
  state: 'in_flight' | 'completed';
  ownerToken: string;
  leaseExpiresAtMs: number;
  statusCode?: number;
  transactionId?: TransactionId;
  responseBody?: unknown;
}

export class FakeIdempotencyStore implements IdempotencyStore {
  readonly rows = new Map<string, FakeIdemRow>();
  readonly beginCalls: BeginIdempotencyInput[] = [];
  /** 测试可推进的单调时钟（毫秒），用于制造租约过期与接管。 */
  clockMs = 1_000_000;
  /** 置为 true 时 complete 返回 lost_ownership（模拟执行权被接管）。 */
  loseOwnership = false;

  private keyOf(scope: IdempotencyScope): string {
    return `${scope.projectId}|${scope.chain}|${scope.key}`;
  }

  private project(scope: IdempotencyScope, row: FakeIdemRow): IdempotencyRecord {
    return {
      scope,
      fingerprint: row.fingerprint,
      state: row.state,
      ownerToken: row.ownerToken,
      leaseExpiresAt: iso(row.leaseExpiresAtMs),
      expiresAt: iso(row.leaseExpiresAtMs + 86_400_000),
      ...(row.transactionId !== undefined ? { transactionId: row.transactionId } : {}),
      ...(row.statusCode !== undefined ? { statusCode: row.statusCode } : {}),
      ...(row.responseBody !== undefined ? { responseBody: row.responseBody } : {}),
    };
  }

  async begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult> {
    this.beginCalls.push(input);
    const key = this.keyOf(input.scope);
    const row = this.rows.get(key);
    if (row === undefined) {
      const created: FakeIdemRow = {
        fingerprint: input.fingerprint,
        state: 'in_flight',
        ownerToken: input.ownerToken,
        leaseExpiresAtMs: this.clockMs + input.leaseTtlMs,
      };
      this.rows.set(key, created);
      return { kind: 'acquired', record: this.project(input.scope, created) };
    }
    if (row.fingerprint !== input.fingerprint) {
      return { kind: 'conflict', record: this.project(input.scope, row) };
    }
    if (row.state === 'completed') {
      return { kind: 'replayed', record: this.project(input.scope, row) };
    }
    if (row.leaseExpiresAtMs > this.clockMs) {
      return {
        kind: 'in_flight',
        record: this.project(input.scope, row),
        retryAfterMs: row.leaseExpiresAtMs - this.clockMs,
      };
    }
    row.ownerToken = input.ownerToken;
    row.leaseExpiresAtMs = this.clockMs + input.leaseTtlMs;
    return { kind: 'acquired', record: this.project(input.scope, row) };
  }

  async complete(input: CompleteIdempotencyInput): Promise<CompleteIdempotencyResult> {
    const row = this.rows.get(this.keyOf(input.scope));
    if (row === undefined) return { kind: 'not_found' };
    if (this.loseOwnership || row.ownerToken !== input.ownerToken) {
      return { kind: 'lost_ownership' };
    }
    row.state = 'completed';
    row.statusCode = input.statusCode;
    if (input.transactionId !== undefined) row.transactionId = input.transactionId;
    if (input.responseBody !== undefined) row.responseBody = input.responseBody;
    return { kind: 'completed', record: this.project(input.scope, row) };
  }

  async get(scope: IdempotencyScope): Promise<IdempotencyRecord | null> {
    const row = this.rows.get(this.keyOf(scope));
    return row === undefined ? null : this.project(scope, row);
  }

  async pruneExpired(_input: PruneExpiredIdempotencyInput): Promise<number> {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* 替身：NonceStore                                                   */
/* ------------------------------------------------------------------ */

export class FakeNonceStore implements NonceStore {
  readonly reserveCalls: ReserveNonceInput[] = [];
  readonly releaseCalls: NonceLeaseRef[] = [];
  /** 置为 true 时 reserve 返回 conflict。 */
  conflict = false;
  /** 置为 true 时 releaseIfSafe 返回 forbidden（同 nonce 已签名/广播）。 */
  releaseForbidden = false;

  async reserve(input: ReserveNonceInput): Promise<ReserveNonceResult> {
    this.reserveCalls.push(input);
    const lease: NonceLease = {
      chain: input.chain,
      account: input.account,
      nonce: input.chainPendingNonce,
      transactionId: input.transactionId,
      status: 'reserved',
      expiresAt: iso(1_000_000 + input.leaseTtlMs),
    };
    if (this.conflict) return { kind: 'conflict', lease };
    return { kind: 'reserved', lease };
  }

  async markBroadcast(): Promise<never> {
    throw new Error('not used in B04');
  }

  async markConsumed(): Promise<never> {
    throw new Error('not used in B04');
  }

  async releaseIfSafe(ref: NonceLeaseRef) {
    this.releaseCalls.push(ref);
    const lease: NonceLease = {
      chain: ref.chain,
      account: ref.account,
      nonce: ref.nonce,
      transactionId: 'txn_x' as TransactionId,
      status: 'reserved',
      expiresAt: iso(1_000_000),
    };
    if (this.releaseForbidden) {
      return { kind: 'forbidden' as const, lease, reason: 'signed_or_broadcast' as const };
    }
    return { kind: 'released' as const, lease };
  }

  async releaseExpiredOrphaned(): Promise<number> {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* 替身：链端口                                                       */
/* ------------------------------------------------------------------ */

export class FakeChainPort implements TransactionChainPort {
  readonly pendingNonceCalls: GetPendingNonceInput[] = [];
  readonly buildCalls: ChainBuildInput[] = [];
  pendingNonce = dec('42');
  buildError?: Error;
  /** 非空时 `build` 抛 DFR_TRANSACTION_REVERTED（模拟 gas 估计阶段回滚）。 */
  buildRevert?: string;

  async getPendingNonce(input: GetPendingNonceInput): Promise<DecimalUint> {
    this.pendingNonceCalls.push(input);
    return this.pendingNonce;
  }

  async build(input: ChainBuildInput): Promise<UnsignedTransaction> {
    this.buildCalls.push(input);
    // ADR-037：preflight 需要能制造"build 阶段即回滚"（EVM 的 eth_estimateGas 回滚）。
    if (this.buildRevert !== undefined) {
      throw createDfrError('DFR_TRANSACTION_REVERTED', {
        requestId: input.requestId ?? ('req_test' as never),
        chain: input.request.chain,
        message: '执行回滚（eth_estimateGas）',
        details: { revertReason: this.buildRevert },
      });
    }
    if (this.buildError !== undefined) throw this.buildError;
    const nonce = input.request.nonce ?? ('0' as never);
    return {
      schemaVersion: '1',
      chain: input.request.chain,
      payload: `0x02f8${String(nonce).padStart(4, '0')}`,
      meta: {
        encoding: 'hex',
        requiresNonce: nonce,
        chainIdForSigning: '11155111',
      },
    };
  }

  /** simulate 调用记录（ADR-037 的 preflight 会用到；build 测试不应触发它）。 */
  readonly simulateCalls: unknown[] = [];
  /**
   * B05 才引入 simulate。**默认抛错**，这样 build 测试仍然能断言"build 不调用 simulate"；
   * preflight 测试把它置为 true，表示"允许模拟"。
   */
  allowSimulate = false;
  simulateResult: SimulationResult = { success: true, estimatedCost: dec('21000') };

  async simulate(input: unknown): Promise<SimulationResult> {
    this.simulateCalls.push(input);
    if (!this.allowSimulate) throw new Error('build 测试不应调用 simulate');
    return this.simulateResult;
  }
}

/* ------------------------------------------------------------------ */
/* 组装                                                               */
/* ------------------------------------------------------------------ */

export interface Harness {
  engine: TransactionEngine;
  transactions: FakeTransactionStore;
  idempotency: FakeIdempotencyStore;
  nonce: FakeNonceStore;
  chain: FakeChainPort;
}

export function harness(): Harness {
  const transactions = new FakeTransactionStore();
  const idempotency = new FakeIdempotencyStore();
  const nonce = new FakeNonceStore();
  const chain = new FakeChainPort();
  let sequence = 0;
  const engine = new TransactionEngine({
    stores: { transaction: transactions, idempotency, nonce },
    chain,
    now: () => '2026-10-04T00:00:00.000Z' as Iso8601,
    newTransactionId: () => `txn_test_${++sequence}` as TransactionId,
    newOwnerToken: () => `owner_${sequence}`,
  });
  return { engine, transactions, idempotency, nonce, chain };
}

