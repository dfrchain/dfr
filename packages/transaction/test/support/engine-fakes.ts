/**
 * The **shared in-memory test doubles** for M1 engine tests (extracted from build.test.ts, see ADR-037).
 *
 * Why extracted: ADR-037's preflight and build need the same test doubles to assert "zero side effects";
 * copying 300 lines would drift immediately. **Moved only, semantics unchanged**.
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
/* Test doubles: TransactionStore                                             */
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
    // Test doubles map events by reason; an unlisted event means the test used an edge the doubles do not support yet.
    // Since ADR-037, `abandon` is a legal event (defined in the state machine), so it must be recognized here,
    // or the abandon tests would fail with the false appearance of "rejected by the state machine".
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
      throw new Error(`FakeTransactionStore: unmapped transition reason "${input.reason}"`);
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
/* Test doubles: IdempotencyStore                                             */
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
  /** A test-advanceable monotonic clock (milliseconds), used to manufacture lease expiry and takeover. */
  clockMs = 1_000_000;
  /** When true, complete returns lost_ownership (simulating a takeover of execution rights). */
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
/* Test doubles: NonceStore                                                   */
/* ------------------------------------------------------------------ */

export class FakeNonceStore implements NonceStore {
  readonly reserveCalls: ReserveNonceInput[] = [];
  readonly releaseCalls: NonceLeaseRef[] = [];
  /** When true, reserve returns conflict. */
  conflict = false;
  /** When true, releaseIfSafe returns forbidden (same nonce already signed/broadcast). */
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
/* Test doubles: chain port                                                       */
/* ------------------------------------------------------------------ */

export class FakeChainPort implements TransactionChainPort {
  readonly pendingNonceCalls: GetPendingNonceInput[] = [];
  readonly buildCalls: ChainBuildInput[] = [];
  pendingNonce = dec('42');
  buildError?: Error;
  /** When non-empty, `build` throws DFR_TRANSACTION_REVERTED (simulating a revert at the gas-estimation phase). */
  buildRevert?: string;

  async getPendingNonce(input: GetPendingNonceInput): Promise<DecimalUint> {
    this.pendingNonceCalls.push(input);
    return this.pendingNonce;
  }

  async build(input: ChainBuildInput): Promise<UnsignedTransaction> {
    this.buildCalls.push(input);
    // ADR-037: preflight needs to manufacture "a revert at the build phase" (an EVM eth_estimateGas revert).
    if (this.buildRevert !== undefined) {
      throw createDfrError('DFR_TRANSACTION_REVERTED', {
        requestId: input.requestId ?? ('req_test' as never),
        chain: input.request.chain,
        message: 'Execution reverted (eth_estimateGas)',
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

  /** The simulate call record (used by ADR-037's preflight; build tests must not trigger it). */
  readonly simulateCalls: unknown[] = [];
  /**
   * B05 introduced simulate. **Throws by default**, so build tests can still assert "build does not call simulate";
   * preflight tests set it to true, meaning "simulation is allowed".
   */
  allowSimulate = false;
  simulateResult: SimulationResult = { success: true, estimatedCost: dec('21000') };

  async simulate(input: unknown): Promise<SimulationResult> {
    this.simulateCalls.push(input);
    if (!this.allowSimulate) throw new Error('build tests must not call simulate');
    return this.simulateResult;
  }
}

/* ------------------------------------------------------------------ */
/* Assembly                                                               */
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

