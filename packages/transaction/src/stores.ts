/**
 * M1 Store ports (DFR-M1-A06).
 *
 * Authoritative sources: docs/architecture/m1-storage-model.md section 8, ADR-015.
 *
 * This file is the **single authoritative location** for the Store interfaces. `packages/core/src/stores.ts` is only a
 * compatibility re-export; `packages/storage-postgres` provides the implementations.
 *
 * Three hard constraints:
 *
 * 1. **Ports express behavior, not tables**. Method names come from storage-model section 8
 *    (`create / get / transition / listRecoverable` etc.), not from a SQL mapping.
 * 2. **No driver types leak**. This file must contain no `pg`, connection pool, SQL fragment, or transaction handle;
 *    otherwise Core and tests would be forced to depend on a concrete database. Implementers keep driver details inside
 *    `packages/storage-postgres`.
 * 3. **Failures are expressed as discriminated unions, not `undefined`**. One `undefined` cannot distinguish
 *    "does not exist" / "version conflict" / "ownership lost"; the caller can only guess.
 *
 * Port methods are always async: the implementation is remote (PostgreSQL), and a sync signature would hide that fact.
 */

import type { AccountRef, BlockRef, ChainId, DecimalUint, DfrErrorCode, FinalityLevel, Iso8601, RequestId, SequencingLeaseStatus, SequencingToken, Transaction, TransactionId, TransactionRef, TransactionStatus } from '@dfr/types';

/* ================================================================== */
/* TransactionStore                                                   */
/* ================================================================== */

/**
 * A transaction record (a storage-layer fact).
 *
 * A **different thing** from the domain model `Transaction` (an on-chain observation result):
 * this record is created and advanced by DFR during execution, carrying an internal `transactionId`, a request fingerprint, and
 * an optimistic-concurrency version; `Transaction` describes facts that already happened on-chain.
 * The two must never substitute for each other, and they do not share a Store.
 *
 * `signedPayload` is forbidden here: M1 explicitly does not persist the signature text (ADR-015, item 9).
 */
export interface TransactionRecord {
  readonly transactionId: TransactionId;
   /** M1 fixes this to `default`; a multi-tenant control plane belongs to M5. */
  readonly projectId: string;
  readonly chain: ChainId;
   /** The SHA-256 of the normalized request body. */
  readonly requestFingerprint: string;
  readonly status: TransactionStatus;
   /** Optimistic-concurrency token; a decimal string (avoiding JS number precision issues). +1 on every CAS. */
  readonly stateVersion: DecimalUint;
   /** The normalized sender address. */
  readonly from: AccountRef;
  readonly to?: AccountRef;
  readonly nonce?: DecimalUint;
  /**
    * Chain-agnostic ordering-precondition reference (ADR-033): a nonce for EVM, a blockhash for Solana.
   *
    * Relation to `nonce`: the `nonce` column is kept (existing EVM code/indexes stay put); for EVM records,
    * `sequencingRef.value` must equal `nonce` (checked by `TransactionStore.create`).
   */
  readonly sequencingRef?: SequencingToken;
   /** The unsigned payload. Not a Secret, but forbidden in logs. */
  readonly unsignedPayload?: string;
  readonly payloadEncoding?: 'hex' | 'base64';
  readonly expectedHash?: string;
  readonly txHash?: string;
   /** The canonical hash of the included block; paired with the height in blockRef to detect reorgs. */
  readonly canonicalBlockHash?: string;
  readonly minFinality?: FinalityLevel;
  readonly blockRef?: BlockRef;
   /** Only stable DFR error codes are stored, never the original error text. */
  readonly errorCode?: DfrErrorCode;
  readonly createdAt: Iso8601;
  readonly updatedAt: Iso8601;
}

export interface CreateTransactionInput {
  readonly record: TransactionRecord;
  /** TX-05: when build uses an idempotency key, creation and claim binding
   * must be a single durable transaction. DB implementations fail closed
   * if the original owner has been taken over or its lease has expired. */
  readonly idempotencyClaim?: {
    readonly scope: IdempotencyScope;
    readonly ownerToken: string;
  };
}

export type CreateTransactionResult =
  | { readonly kind: 'created'; readonly record: TransactionRecord }
   /** The same `transactionId` already exists: return the existing record without overwriting. */
  | { readonly kind: 'already_exists'; readonly record: TransactionRecord };

export interface TransitionTransactionInput {
  readonly transactionId: TransactionId;
   /** The old state and version the caller read, used as write conditions (no last-write-wins). */
  readonly expectedStatus: TransactionStatus;
  readonly expectedVersion: DecimalUint;
  readonly toStatus: TransactionStatus;
   /** A stable reason code, written to the transition audit row. */
  readonly reason: string;
  readonly requestId?: RequestId;
   /** Fields allowed to be updated outside a state change. */
  readonly patch?: TransitionPatch;
}

/** Fields allowed to be updated together with a state transition (an allowlist, preventing casual writes to arbitrary columns). */
export interface TransitionPatch {
  readonly txHash?: string;
  readonly expectedHash?: string;
  readonly nonce?: DecimalUint;
  readonly blockRef?: BlockRef | null;
  readonly canonicalBlockHash?: string | null;
  readonly minFinality?: FinalityLevel;
  readonly errorCode?: DfrErrorCode;
}

export type TransitionTransactionResult =
  | { readonly kind: 'applied'; readonly record: TransactionRecord }
  | { readonly kind: 'not_found' }
   /** Version mismatch: the caller is writing from a stale snapshot. Must re-read; overwriting is not allowed. */
  | { readonly kind: 'version_conflict'; readonly current: TransactionRecord }
   /** State mismatch: the edge in the state machine no longer applies. */
  | { readonly kind: 'status_conflict'; readonly current: TransactionRecord };

export interface ListRecoverableInput {
   /** Per-batch cap. The spec requires paging with at most 500 per batch; unbounded scans are forbidden. */
  readonly limit: number;
   /** Keyset-paging cursor: the transactionId of the last record in the previous batch. */
  readonly afterTransactionId?: TransactionId;
   /** Defaults to the non-terminal set; pass explicitly for a targeted sweep. */
  readonly statuses?: readonly TransactionStatus[];
  /**
    * Only records with `updatedAt >= updatedAfter` are returned (ADR-023).
   *
    * Purpose: `dropped` keeps being observed only inside a bounded grace window (otherwise the "scan set only grows" problem returns).
    * Why a **query condition** instead of filtering after fetch: the latter would leave the paging cursor stuck on a whole page of expired records,
    * returning the same batch every round and never advancing.
   */
  readonly updatedAfter?: Iso8601;
  /**
    * Only records with `updatedAt <= updatedBefore` are returned (ADR-037, option C).
   *
    * Purpose: auto-void `built`/`simulated` records that have **not advanced for a long time**. Like `updatedAfter`,
    * it must be part of the query — filtering after fetch would stall the paging cursor and return the same batch every round.
   */
  readonly updatedBefore?: Iso8601;
}

export interface TransactionStore {
  create(input: CreateTransactionInput): Promise<CreateTransactionResult>;
  get(transactionId: TransactionId): Promise<TransactionRecord | null>;
   /** Locate a DFR transaction record by its on-chain broadcast/expected hash; external transactions return null. */
  getByHash(chain: ChainId, txHash: string): Promise<TransactionRecord | null>;
  transition(input: TransitionTransactionInput): Promise<TransitionTransactionResult>;
  listRecoverable(input: ListRecoverableInput): Promise<readonly TransactionRecord[]>;
}

/* ================================================================== */
/* IdempotencyStore                                                   */
/* ================================================================== */

/** Idempotency scope: the same `(projectId, chain, key)` counts as one logical request. */
export interface IdempotencyScope {
  readonly projectId: string;
  readonly chain: ChainId;
  readonly key: string;
}

export type IdempotencyState = 'in_flight' | 'completed';

export interface IdempotencyRecord {
  readonly scope: IdempotencyScope;
   /** The SHA-256 of the normalized request body. */
  readonly fingerprint: string;
  readonly state: IdempotencyState;
   /** The current executor's random token; a takeover must change the token so the old executor cannot write back. */
  readonly ownerToken: string;
   /** Judged by the database clock, not the process clock. */
  readonly leaseExpiresAt: Iso8601;
  readonly transactionId?: TransactionId;
  readonly statusCode?: number;
   /** The redacted first response body. */
  readonly responseBody?: unknown;
   /** When the whole record expires (24h after creation by default). */
  readonly expiresAt: Iso8601;
}

export interface BeginIdempotencyInput {
  readonly scope: IdempotencyScope;
  readonly fingerprint: string;
  readonly ownerToken: string;
   /** The in-progress lease duration; another executor may take over after it expires. */
  readonly leaseTtlMs: number;
}

export type BeginIdempotencyResult =
   /** First request: the caller gains execution rights. */
  | { readonly kind: 'acquired'; readonly record: IdempotencyRecord }
   /** Same key, same fingerprint, already complete: replay the first response verbatim; do not re-execute. */
  | { readonly kind: 'replayed'; readonly record: IdempotencyRecord }
   /** Same key, same fingerprint, but still in progress: return 409 + Retry-After; do not execute twice. */
  | { readonly kind: 'in_flight'; readonly record: IdempotencyRecord; readonly retryAfterMs: number }
   /** Same key, different fingerprint: a permanent conflict; the original record must not be overwritten. */
  | { readonly kind: 'conflict'; readonly record: IdempotencyRecord };

export interface CompleteIdempotencyInput {
  readonly scope: IdempotencyScope;
  readonly ownerToken: string;
  readonly statusCode: number;
  readonly responseBody?: unknown;
  readonly transactionId?: TransactionId;
}

export type CompleteIdempotencyResult =
  | { readonly kind: 'completed'; readonly record: IdempotencyRecord }
   /** Token mismatch: execution rights were taken over; this result must be discarded. */
  | { readonly kind: 'lost_ownership' }
  | { readonly kind: 'not_found' };

export interface PruneExpiredIdempotencyInput {
  readonly limit: number;
   /** Inject a clock for tests; implementations use the database clock by default. */
  readonly now?: Iso8601;
}

export interface IdempotencyStore {
  begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult>;
  complete(input: CompleteIdempotencyInput): Promise<CompleteIdempotencyResult>;
  get(scope: IdempotencyScope): Promise<IdempotencyRecord | null>;
   /** Delete expired records in batches, returning the number deleted. */
  pruneExpired(input: PruneExpiredIdempotencyInput): Promise<number>;
}

/* ================================================================== */
/* NonceStore                                                         */
/* ================================================================== */

export type NonceLeaseStatus = 'reserved' | 'broadcast' | 'consumed' | 'released' | 'expired';

export interface NonceLease {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly nonce: DecimalUint;
  readonly transactionId: TransactionId;
  readonly status: NonceLeaseStatus;
  readonly expiresAt: Iso8601;
}

export interface ReserveNonceInput {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly transactionId: TransactionId;
   /** The on-chain pending nonce, read by the Adapter; the implementation takes max(that value, the local next_nonce). */
  readonly chainPendingNonce: DecimalUint;
  readonly leaseTtlMs: number;
}

export type ReserveNonceResult =
  | { readonly kind: 'reserved'; readonly lease: NonceLease }
   /** Replaying the same transactionId: return the original lease without incrementing the nonce. */
  | { readonly kind: 'reused'; readonly lease: NonceLease }
   /** The nonce is already occupied by another transaction. */
  | { readonly kind: 'conflict'; readonly lease: NonceLease };

export interface NonceLeaseRef {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly nonce: DecimalUint;
  /**
    * B39 safety constraint: transaction ownership must be explicitly bound.
   *
    * A `released` or strictly expired lease may be safely reallocated, so the original
    * `(chain, account, nonce)` is no longer enough to prove the current caller owns the lease (ABA).
    * The Store must match transactionId against the database's current holder before modifying a lease.
    * On mismatch, return not_found (advance) or forbidden/not_owner (release);
    * a missing or empty string always fails closed with not_found (protecting old JS callers).
   */
  readonly transactionId: TransactionId;
}

export type AdvanceNonceLeaseResult =
  | { readonly kind: 'updated'; readonly lease: NonceLease }
  | { readonly kind: 'not_found' };

export type ReleaseNonceLeaseResult =
  | { readonly kind: 'released'; readonly lease: NonceLease }
  | { readonly kind: 'not_found' }
  /**
    * Refuse to release. A signed / broadcast nonce must not be auto-released for reuse
    * (m1-storage-model §3.4), or the same nonce would be double-spent in a repeat broadcast.
   */
  | { readonly kind: 'forbidden'; readonly lease: NonceLease; readonly reason: NonceReleaseForbiddenReason };

export type NonceReleaseForbiddenReason = 'signed_or_broadcast' | 'not_owner';

export interface ReleaseExpiredOrphanedNonceLeasesInput {
   /** Per-round cap; a recovery job must not run an unbounded anti-join scan. */
  readonly limit: number;
}

export interface NonceStore {
  reserve(input: ReserveNonceInput): Promise<ReserveNonceResult>;
  markBroadcast(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult>;
  markConsumed(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult>;
  releaseIfSafe(ref: NonceLeaseRef): Promise<ReleaseNonceLeaseResult>;
  /**
    * Bounded cleanup of expired reserved leases: only orphans without a transaction row, or
    * terminal-state reverted transactions (neither expectedHash nor txHash recorded). Never touch unexpired leases,
    * signed transactions, or signed transactions that failed on-chain execution. The `next_nonce` watermark never rolls back,
    * and later reserves only reuse a released gap through strict state/ownership and on-chain pending checks.
   */
  releaseExpiredOrphaned(input: ReleaseExpiredOrphanedNonceLeasesInput): Promise<number>;
}

/* ================================================================== */
 /* SequencingStore (ADR-032, M3-A01)                                 */
/* ================================================================== */

/**
  * Ordering lease (as opposed to the "sequence number" semantics of NonceLease, this carries the chain-agnostic ordering precondition).
 *
  * `token` is an opaque discriminated union: a nonce for EVM, a blockhash for Solana.
  * The Store **does not interpret** the token contents and makes no expiry judgments — expiry semantics belong to the chain, i.e. the Adapter.
 *
  * **The lease identity is `transactionId`, not the token value** (the key difference from NonceLease under ADR-032):
  * one Solana blockhash legitimately serves countless transactions, so `token_value` **cannot** uniquely identify a lease.
  * Correspondingly, `(chain, account, transactionId)` uniquely identifies a row; once a row is created it is **never re-bound**
  * to another transaction, so "a late caller wrongly updating an already-reused lease" (the ADR-030 ABA scenario) structurally cannot happen.
  * `tokenValue` is still kept in the reference as a defensive assertion of caller self-consistency (a mismatch fails closed).
 *
  * `expiresAt` is the **lease TTL** (local bookkeeping: how long this reservation record is kept), which is a different thing from the blockhash's
  * on-chain validity (`lastValidBlockHeight`, judged by block height).
 */
export interface SequencingLease {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly token: SequencingToken;
  readonly transactionId: TransactionId;
  readonly status: SequencingLeaseStatus;
  readonly expiresAt: Iso8601;
}

export interface SequencingLeaseRef {
  readonly chain: ChainId;
  readonly account: AccountRef;
   /** The lease's true identity (the row key). Required: a token value can be shared by many transactions, so it cannot serve as identity. */
  readonly transactionId: TransactionId;
   /** The token value declared by the caller; a mismatch with the row fails closed (a defensive assertion, not identity). */
  readonly tokenValue: string;
}

export interface ReleaseExpiredOrphanedSequencingLeasesInput {
   /** Per-round cap; a recovery job must not run an unbounded anti-join scan. */
  readonly limit: number;
}

export interface ReserveSequencingInput {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly transactionId: TransactionId;
  /**
    * The candidate token supplied by the Adapter (it knows what this chain takes: a nonce or a blockhash).
    * The Store only handles "serializing the same (chain, account)" and persistence.
   */
  readonly token: SequencingToken;
  readonly leaseTtlMs: number;
}

export type ReserveSequencingResult =
  | { readonly kind: 'reserved'; readonly lease: SequencingLease }
   /** The same transactionId already has a lease (concurrent replay) — return the original lease without allocating again. */
  | { readonly kind: 'reused'; readonly lease: SequencingLease };

export type ReleaseSequencingResult =
  | { readonly kind: 'released'; readonly lease: SequencingLease }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'forbidden'; readonly lease: SequencingLease; readonly reason: ReleaseSequencingForbiddenReason };

export type ReleaseSequencingForbiddenReason = 'already_consumed' | 'not_owner';

export type AdvanceSequencingResult =
  | { readonly kind: 'updated'; readonly lease: SequencingLease }
  | { readonly kind: 'not_found' };

/**
  * Ordering-lease Store (ADR-032, option A).
 *
  * It **coexists** with `NonceStore`: EVM keeps using NonceStore (verified, protected by ADR-018/030),
  * and this port serves Solana only for now. Unifying the two is a later refactor needing its own ADR.
 */
export interface SequencingStore {
  reserve(input: ReserveSequencingInput): Promise<ReserveSequencingResult>;
  /**
    * Mark the token as used by a signed/broadcast transaction.
   *
    * This is an audit record ("this reference really was consumed"), not a mutex: a blockhash can be shared by many transactions,
    * so it does **not** stop other transactions from continuing to use the same token. Idempotent (calling again when already consumed returns `updated`).
   */
  markConsumed(ref: SequencingLeaseRef): Promise<AdvanceSequencingResult>;
  /**
    * Release an **unsigned** lease (a compensating action for a failed/aborted build) and commit it to the session record.
   *
    * A `consumed` lease refuses release (`forbidden` + `already_consumed`): once signed/broadcast,
    * releasing it would hide the fact. A reference/row mismatch gives `forbidden` + `not_owner` (fail-closed).
   */
  releaseIfSafe(ref: SequencingLeaseRef): Promise<ReleaseSequencingResult>;
  /**
    * Reclaim expired leases still `reserved`, by **lease TTL** (the process crashed after reserve).
   *
    * Note this is not "blockhash-expiry reclamation": whether a blockhash is still usable is judged by the Adapter from the chain height
    * (`isSequencingExpired`). This method only cleans up local reservation records; `consumed` is never reclaimed.
   */
  releaseExpiredOrphaned(input: ReleaseExpiredOrphanedSequencingLeasesInput): Promise<number>;
}

/* ================================================================== */
/* TrackerLeaseStore                                                  */
/* ================================================================== */

/** Confirmation-tracking lease: the unique key is `(chain, txHash)`. */
export interface TrackerLease {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly ownerToken: string;
  readonly leaseExpiresAt: Iso8601;
  readonly heartbeatAt: Iso8601;
}

export interface AcquireTrackerLeaseInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly ownerToken: string;
  readonly leaseTtlMs: number;
}

export type AcquireTrackerLeaseResult =
  | { readonly kind: 'acquired'; readonly lease: TrackerLease }
   /** Already held by another owner inside the lease validity window: single-flight; no concurrent tracking. */
  | { readonly kind: 'held_by_other'; readonly lease: TrackerLease };

export interface RenewTrackerLeaseInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly ownerToken: string;
  readonly leaseTtlMs: number;
}

export type RenewTrackerLeaseResult =
  | { readonly kind: 'renewed'; readonly lease: TrackerLease }
   /** Ownership is lost (taken over or released): stop writing state immediately. */
  | { readonly kind: 'lost' };

export interface ReleaseTrackerLeaseInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly ownerToken: string;
}

export type ReleaseTrackerLeaseResult =
  | { readonly kind: 'released' }
  | { readonly kind: 'lost' };

export interface ListRecoverableTrackerLeasesInput {
   /** The recovery scan pages by chain; txHash is only unique within a chain. */
  readonly chain: ChainId;
  readonly limit: number;
  readonly afterTxHash?: string;
}

export interface TrackerLeaseStore {
  acquire(input: AcquireTrackerLeaseInput): Promise<AcquireTrackerLeaseResult>;
  renew(input: RenewTrackerLeaseInput): Promise<RenewTrackerLeaseResult>;
  release(input: ReleaseTrackerLeaseInput): Promise<ReleaseTrackerLeaseResult>;
  listRecoverable(
    input: ListRecoverableTrackerLeasesInput,
  ): Promise<readonly TrackerLease[]>;
}

/* ================================================================== */
 /* M0 compatibility: read-only observation cache                              */
/* ================================================================== */

/**
  * M0 read-only observation cache.
 *
  * **This is not M1's `TransactionStore`.** M0's Core puts the on-chain-observed `Transaction` into this cache after a read-only query (`getTransaction`);
 * it has no request fingerprint, no state machine,
 * no optimistic-concurrency version, and it does not take part in the broadcast write path.
 *
  * Keep the original name's semantics when migrating, only renaming the type (the old name `TransactionStore` is taken by the M1 port),
  * so the "M0 cache" and the "M1 engine record" are never mistaken for the same thing.
 *
  * The in-process implementation is only for M0, unit tests, and local demos; once M1 enables broadcast, a
  * persistent implementation that survives restarts must be used (ADR-014).
 */
export interface TransactionObservationStore {
  put(chain: ChainId, transaction: Transaction): Promise<void>;
  get(chain: ChainId, ref: TransactionRef): Promise<Transaction | undefined>;
  list(chain: ChainId): Promise<readonly Transaction[]>;
}

export class InMemoryTransactionObservationStore implements TransactionObservationStore {
  private readonly byChain = new Map<string, Map<string, Transaction>>();

  private keyOf(ref: TransactionRef): string {
    return ref.kind === 'hash' ? `hash:${ref.hash}` : `id:${ref.id}`;
  }

  async put(chain: ChainId, transaction: Transaction): Promise<void> {
    let bucket = this.byChain.get(chain);
    if (bucket === undefined) {
      bucket = new Map<string, Transaction>();
      this.byChain.set(chain, bucket);
    }
    bucket.set(this.keyOf(transaction.ref), transaction);
  }

  async get(chain: ChainId, ref: TransactionRef): Promise<Transaction | undefined> {
    return this.byChain.get(chain)?.get(this.keyOf(ref));
  }

  async list(chain: ChainId): Promise<readonly Transaction[]> {
    return [...(this.byChain.get(chain)?.values() ?? [])];
  }
}
