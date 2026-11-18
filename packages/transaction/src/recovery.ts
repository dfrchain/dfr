import { newRequestId } from '@dfr/errors';
import type { Iso8601, TransactionId } from '@dfr/types';
import type {
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLeaseStore,
  TransactionRecord,
  TransactionStore,
} from './stores.js';

/** ADR-023: the default grace window after judging dropped, during which observation continues and correction is still allowed. */
const DEFAULT_DROPPED_GRACE_MS = 6 * 60 * 60_000;

/** The default void window for ADR-037 option C (30 minutes). */
export const DEFAULT_ABANDON_BUILT_AFTER_MS = 30 * 60_000;

/** The structural conclusions of `reconcileStrandedSigned` (ADR-040). */
export type StrandedSignedReconcileOutcome =
   /** CAS persisted: the record entered `unknown`, with one best-effort read-only observation made. */
  | 'transitioned'
   /** The record does not exist. */
  | 'not_found'
   /** The record exists but is not in `signed` (already advanced or terminal): the channel does nothing. */
  | 'not_signed'
   /** An EVM record with a nonce: owned by the `recoverStaleSigned` sweep; this channel refuses to do it on its behalf. */
  | 'not_applicable'
   /** Missing `expectedHash` or `sequencingRef`: an unverifiable record is never converted (same rule as TX-02). */
  | 'unverifiable'
   /** `updatedAt` is still inside the staleness window: a normal in-flight flow may exist; refuse to migrate. */
  | 'not_stale'
   /** The tracker lease for `expectedHash` is held by another owner: concurrent recovery/observation is in progress. */
  | 'lease_held'
   /** A recheck inside the lease, or the CAS, found the record already advanced by a concurrent writer: ops should reconcile again. */
  | 'conflict';

type StrandedSignedClass =
  | 'eligible'
  | 'not_signed'
  | 'not_applicable'
  | 'unverifiable'
  | 'not_stale';

/**
 * The eligibility classification for `reconcileStrandedSigned` (a pure function, run once before and once after the migration).
 *
 * The order is the rule: state first, then domain (EVM belongs to the sweep), then verifiability, then staleness —
 * guaranteeing "fresh" never hides "not this channel's job at all", and vice versa.
 */
function classifyStrandedSigned(
  record: TransactionRecord,
  staleBeforeMs: number,
): StrandedSignedClass {
  if (record.status !== 'signed') return 'not_signed';
  if (record.nonce !== undefined) return 'not_applicable';
  if (record.expectedHash === undefined || record.expectedHash === '' ||
      record.sequencingRef === undefined) {
    return 'unverifiable';
  }
  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt > staleBeforeMs) return 'not_stale';
  return 'eligible';
}

export interface RecoveryDeps {
  readonly transactions: TransactionStore;
  readonly idempotency: IdempotencyStore;
  readonly nonce: NonceStore;
  /**
    * M3-A01/C03: Solana blockhash ordering lease; optional.
   *
    * Only reclaims expired `reserved` leases in deployments where it is wired up (the process crashed after reserve).
    * Skipped when not wired up — an EVM-only deployment does not need it.
   */
  readonly sequencing?: SequencingStore;
  readonly trackerLeases: TrackerLeaseStore;
  readonly resolveUnknown: (transactionId: TransactionId) => Promise<void>;
   /** A one-time token per Gateway process; never reuse ownership from an expired worker. */
  readonly ownerToken: () => string;
  readonly leaseTtlMs?: number;
  /**
    * The grace window during which `dropped` records keep being observed and may be corrected (ADR-023). Defaults to 6 hours.
   *
    * Why bounded: `dropped` is a **judgment**, and a wrong judgment must stay correctable; but permanent observation would let the scan set
    * only grow and never shrink, running RPCs for nothing every round (exactly the problem TODO-011 fixes). Residual risk outside the window is explicitly accepted.
   */
  readonly droppedGraceMs?: number;
   /** The clock for the decision window; defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
    * After how long without **advancing** are `built` / `simulated` records auto-voided (ADR-037, option C).
   *
    * Why it is needed: option A's explicit `abandon` only works when the **caller remembers**; process crashes,
    * network interruptions, and callers forgetting to clean up all leave permanent gaps. This sweep is the safety net.
   *
    * Defaults to 30 minutes: clearly longer than the normal human-in-the-loop build→sign→broadcast time (minutes),
    * yet shorter than the "stuck for a whole day" threshold ops would notice. `undefined` means **disable** this sweep
    * (explicitly switchable off for non-EVM-only or test scenarios).
   */
  readonly abandonBuiltAfterMs?: number;
}

/**
 * Startup recovery: strict paging, bounded batches; only resolves unknown, never broadcasts.
 *
 * `unknown` on-chain resolution may be triggered concurrently by several restarting processes. Using the record's
 * expectedHash/txHash as the lease key, only the current owner may call the resolution port; a valid lease held by another
 * owner is skipped immediately. The lease is released when the callback ends, so this is not a background tracker and leaves no renewal behind.
 */
export class RecoveryCoordinator {
  constructor(private readonly deps: RecoveryDeps) {}

  async run(input: { limit: number }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }
    let afterTransactionId: TransactionId | undefined;
    let recovered = 0;
     // All three are bounded cleanup for this round; any remaining records are left for the next startup/sweep, never scanned without bound.
    await this.deps.idempotency.pruneExpired({ limit: input.limit });
    await this.deps.nonce.releaseExpiredOrphaned({ limit: input.limit });
     // Solana: reclaim blockhash leases whose TTL has passed and are still `reserved` (consumed ones are never reclaimed).
    await this.deps.sequencing?.releaseExpiredOrphaned({ limit: input.limit });
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      if (records.length === 0) return recovered;
      for (const record of records) {
        if (record.status !== 'unknown') continue;
        try {
          if (await this.resolveUnknownWithLease(record)) recovered += 1;
        } catch {
          // A broken RPC observation or tracker-lease operation on one
          // transaction must not block later unknown records and pages.
          // No transaction status is changed by this catch; retry next sweep.
        }
      }
      if (records.length < input.limit) return recovered;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
  }

  /**
   * TX-02 / DB-01: repair stale signed transactions after a process crash.
   *
   * The raw signed payload is deliberately never stored; a signed record
   * therefore MUST NOT be automatically rebroadcast. This sweep only moves
   * an old, verifiable signed EVM record to indeterminate/unknown and then
   * performs the existing chain-side read-only observation.
   *
   * Locking by expectedHash prevents two recovery workers from racing.
   * TransactionStore.transition CAS prevents overwriting a concurrent
   * successful broadcast. The caller chooses the minimum stale interval.
   */
  async recoverStaleSigned(input: {
    readonly limit: number;
    readonly staleAfterMs: number;
    readonly now?: number;
  }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }
    if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 60_000) {
      throw new RangeError('staleAfterMs must be >= 60000');
    }
    const now = input.now ?? this.deps.clock?.() ?? Date.now();
    const updatedBefore = new Date(now - input.staleAfterMs).toISOString() as Iso8601;
    let afterTransactionId: TransactionId | undefined;
    let repaired = 0;
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        statuses: ['signed'],
        updatedBefore,
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      if (records.length === 0) return repaired;
      for (const record of records) {
        const hash = record.expectedHash;
        // Never convert an unverifiable record to dropped. Solana sequencing
        // needs its own blockhash-aware recovery policy; this is EVM-only.
        // That policy is reconcileStrandedSigned below (operator-invoked,
        // ADR-040); this sweep must never auto-transition a Solana record.
        if (record.nonce === undefined || hash === undefined || hash === '') continue;
        const ownerToken = this.deps.ownerToken();
        try {
          const acquired = await this.deps.trackerLeases.acquire({
            chain: record.chain, txHash: hash, ownerToken,
            leaseTtlMs: this.deps.leaseTtlMs ?? 30_000,
          });
          if (acquired.kind === 'held_by_other') continue;
          try {
            const fresh = await this.deps.transactions.get(record.transactionId);
            if (fresh === null || fresh.status !== 'signed' ||
                fresh.expectedHash !== hash || fresh.nonce === undefined) continue;
            const updatedAt = Date.parse(fresh.updatedAt);
            if (!Number.isFinite(updatedAt) || updatedAt > Date.parse(updatedBefore)) continue;
            const transitioned = await this.deps.transactions.transition({
              transactionId: fresh.transactionId,
              expectedStatus: 'signed',
              expectedVersion: fresh.stateVersion,
              toStatus: 'unknown',
              reason: 'broadcast.indeterminate',
              requestId: newRequestId(),
            });
            if (transitioned.kind !== 'applied') continue;
            repaired += 1;
            // A failed RPC observation does not undo the durable unknown
            // transition. The ordinary recovery pass handles it next time.
            try { await this.deps.resolveUnknown(record.transactionId); } catch { /* retry later */ }
          } finally {
            await this.deps.trackerLeases.release({ chain: record.chain, txHash: hash, ownerToken });
          }
        } catch {
          // One bad record does not stop the recovery sweep.
        }
      }
      if (records.length < input.limit) return repaired;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
  }

  /**
    * Ops channel: after manual reconciliation, move a **Solana transaction stranded in `signed`** into the existing
    * `unknown` reconciliation state (leftover item from issue #22, gate 4, ADR-040).
   *
    * Why it exists separately instead of being folded into `recoverStaleSigned`:
    *   - `recoverStaleSigned` is a **scheduled sweep**, deliberately EVM-only (see its inline comment).
    *     Solana blockhashes expire by block height, not by time; "stale" only suggests the process most likely
    *     died — it says nothing about whether the payload ever propagated; letting the sweep auto-migrate Solana `signed` records
    *     would be deciding "abandon this signed transaction" on ops' behalf. This channel therefore **only accepts a human naming it**
    *     (a single `transactionId`), enters no scheduler, and has no batch entry point.
    *   - Call prerequisites (manual reconciliation, see the gate-4 reconciliation procedure): ops first queries the on-chain state read-only by signature,
    *     and only calls this after confirming it is not on-chain or the blockhash has expired. This method does not re-judge
    *     on-chain facts; it only performs the threshold-gated persistent migration.
   *
    * Safety (same origin as TX-02):
    *   - the target state is only `unknown` (the existing edge `signed + broadcast.indeterminate`,
    *     the same edge and reason as the EVM sweep): afterwards the existing read-only observation / caller
    *     confirm resolves it; this method does not judge `dropped` / `failed`;
    *   - the signed payload was never persisted; this method has no broadcast entry point and no replay path;
    *   - the staleness threshold (≥ 60 s, same lower bound as the sweep) rules out "the signing flow is actually still alive";
    *     tracker lease (by expectedHash) + in-lease recheck + CAS rule out concurrent advancement.
   *
    * Structural rejections are returned as a discriminated union (ops needs to see each conclusion item by item), not thrown;
    * infrastructure errors such as storage errors are still thrown, not disguised as business conclusions.
   */
  async reconcileStrandedSigned(input: {
    readonly transactionId: TransactionId;
    readonly staleAfterMs: number;
    readonly now?: number;
  }): Promise<StrandedSignedReconcileOutcome> {
    if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 60_000) {
      throw new RangeError('staleAfterMs must be >= 60000');
    }
    const now = input.now ?? this.deps.clock?.() ?? Date.now();
    const staleBeforeMs = now - input.staleAfterMs;

    const record = await this.deps.transactions.get(input.transactionId);
    if (record === null) return 'not_found';
    const classified = classifyStrandedSigned(record, staleBeforeMs);
    if (classified !== 'eligible') return classified;

     // classify has already guaranteed expectedHash is non-empty ('unverifiable' already returned above).
    const hash = record.expectedHash as string;
    const ownerToken = this.deps.ownerToken();
    const acquired = await this.deps.trackerLeases.acquire({
      chain: record.chain, txHash: hash, ownerToken,
      leaseTtlMs: this.deps.leaseTtlMs ?? 30_000,
    });
    if (acquired.kind === 'held_by_other') return 'lease_held';
    try {
      const fresh = await this.deps.transactions.get(input.transactionId);
      if (fresh === null) return 'not_found';
       // In-lease recheck: if the classification or the identity (expectedHash) changed, back off as a conflict —
       // a concurrent sign/broadcast may have just advanced this record; ops should reconcile again rather than retry to the end.
      if (classifyStrandedSigned(fresh, staleBeforeMs) !== 'eligible' ||
          fresh.expectedHash !== hash) {
        return 'conflict';
      }
      const transitioned = await this.deps.transactions.transition({
        transactionId: fresh.transactionId,
        expectedStatus: 'signed',
        expectedVersion: fresh.stateVersion,
        toStatus: 'unknown',
        reason: 'broadcast.indeterminate',
        requestId: newRequestId(),
      });
      if (transitioned.kind !== 'applied') return 'conflict';
       // Same rule as the sweep: an observation failure does not undo the persisted unknown migration,
       // and the normal recovery rounds keep handling it. The observation itself is read-only and never broadcasts.
      try { await this.deps.resolveUnknown(fresh.transactionId); } catch { /* retry later */ }
      return 'transitioned';
    } finally {
      await this.deps.trackerLeases.release({ chain: record.chain, txHash: hash, ownerToken });
    }
  }

  /**
    * Auto-void `built` / `simulated` records that have **not advanced for a long time** (ADR-037, option C).
   *
    * Relationship to option A: A is the caller's **explicit** void (the correct action); C is the **safety net** —
    * self-healing after a process crash / network interruption / caller forgetting. Both share the same semantics (release the lease + move to `abandoned`).
   *
    * Strict boundaries (all required):
    *   - only `built` / `simulated` (`signed` and above are **never** touched by this method —
    *     that would reclaim a signed transaction's nonce and break funds safety);
    *   - only records whose `updatedAt` predates the window (a normal in-flight flow may exist inside the window);
    *   - bounded paging (`limit` reuses the caller's batch cap), never an unbounded scan.
   *
    * Returns the number of records actually voided this round. **Failures are not thrown**: a single failure is left for the next round, and one bad record never
    * drags down the whole sweep (same closing rule as `run`).
   */
  async abandonStaleUnbroadcast(input: {
    readonly limit: number;
    readonly now?: number;
  }): Promise<number> {
    const afterMs = this.deps.abandonBuiltAfterMs;
     // Unconfigured = disabled (explicit, not silently using some default).
    if (afterMs === undefined) return 0;
    // Invalid or extremely short windows may abandon transactions while a
    // legitimate user is still signing. Config 0 is converted to undefined
    // (disabled) by the Gateway composition root; direct callers must not
    // interpret 0 as immediate lease reclamation.
    if (!Number.isSafeInteger(afterMs) || afterMs < 60_000 || afterMs > 7 * 24 * 60 * 60_000) {
      throw new RangeError('abandonBuiltAfterMs must be 60000..604800000 or omitted to disable');
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }

    const nowMs = input.now ?? this.deps.clock?.() ?? Date.now();
    const updatedBefore = new Date(nowMs - afterMs).toISOString() as Iso8601;

    let afterTransactionId: TransactionId | undefined;
    let abandoned = 0;
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        statuses: ['built', 'simulated'],
         // Only fetch records **earlier than** the window. Putting it in the query (instead of filtering after fetch) lets the cursor advance.
        updatedBefore,
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      if (records.length === 0) break;

      for (const record of records) {
        try {
          // CAS FIRST. A concurrent signer can advance built/simulated to
          // signed after the stale query. Releasing its nonce before checking
          // the status/version would free a LIVE signed transaction's lease,
          // even if our later CAS correctly reports a conflict.
          //
          // The narrow alternative is a temporary reserved-lease leak if
          // cleanup fails after the durable abandoned transition; the normal
          // releaseExpiredOrphaned sweep can safely reclaim that stale lease.
          const moved = await this.deps.transactions.transition({
            transactionId: record.transactionId,
            expectedStatus: record.status,
            expectedVersion: record.stateVersion,
            toStatus: 'abandoned',
            reason: 'abandon.stale',
            requestId: newRequestId(),
          });
          if (moved.kind !== 'applied') continue;
          abandoned += 1;
          try {
            if (record.nonce !== undefined) {
              await this.deps.nonce.releaseIfSafe({
                chain: record.chain,
                account: record.from,
                nonce: record.nonce,
                transactionId: record.transactionId,
              });
            } else if (record.sequencingRef !== undefined && this.deps.sequencing !== undefined) {
              await this.deps.sequencing.releaseIfSafe({
                chain: record.chain,
                account: record.from,
                transactionId: record.transactionId,
                tokenValue: record.sequencingRef.value,
              });
            }
          } catch {
            // The abandoned CAS already committed. Do not hide that fact;
            // the periodic orphan-lease sweep will retry lease cleanup.
          }
        } catch {
           // A single failure (e.g. a CAS conflict under concurrency) does not drag down the whole round; the next round handles it.
        }
      }

      if (records.length < input.limit) break;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
    return abandoned;
  }

  /**
    * Observe `dropped` records inside the observation grace window and try to correct them (ADR-023).
   *
    * Scanned separately from `unknown` because the sets differ and `dropped` needs an `updatedAfter` lower time bound:
    * putting the time condition in the query (instead of filtering after fetch) lets the paging cursor advance normally.
   *
    * Returns the number of records actually converged (had their state corrected) this round.
   */
  async reconcileDropped(input: { limit: number }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }
    const graceMs = this.deps.droppedGraceMs ?? DEFAULT_DROPPED_GRACE_MS;
    const now = this.deps.clock?.() ?? Date.now();
    const updatedAfter = new Date(now - graceMs).toISOString() as Iso8601;

    let afterTransactionId: TransactionId | undefined;
    let corrected = 0;
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        statuses: ['dropped'],
        updatedAfter,
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      if (records.length === 0) return corrected;
      for (const record of records) {
         // Only an observation can move dropped to another state; `resolveUnknown` only does convergence on dropped.
         // The count must be "states genuinely corrected", not "an observation happened" — otherwise absent would also count as convergence,
         // and the metrics would inflate and stop reflecting the true correction volume.
        try {
          const observed = await this.resolveUnknownWithLease(record);
          if (!observed) continue;
          const after = await this.deps.transactions.get(record.transactionId);
          if (after !== null && after.status !== record.status) corrected += 1;
        } catch {
          // A single failed observation, tracker lease or follow-up lookup
          // must not abort dropped correction for other records in this page.
          // Count only a successfully verified transition, never an attempt.
        }
      }
      if (records.length < input.limit) return corrected;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
  }

  private async resolveUnknownWithLease(record: TransactionRecord): Promise<boolean> {
    const txHash = record.expectedHash ?? record.txHash;
     // An unknown without a verifiable recorded hash cannot be safely handed to the tracker; keep the original state and wait for manual investigation.
    if (txHash === undefined || txHash === '') return false;

    const ownerToken = this.deps.ownerToken();
    const acquired = await this.deps.trackerLeases.acquire({
      chain: record.chain,
      txHash,
      ownerToken,
      leaseTtlMs: this.deps.leaseTtlMs ?? 30_000,
    });
    if (acquired.kind === 'held_by_other') return false;

    try {
      await this.deps.resolveUnknown(record.transactionId);
      return true;
    } finally {
       // If the lease is already lost, the Store returns lost; in any case, never keep writing state as the old owner.
      await this.deps.trackerLeases.release({ chain: record.chain, txHash, ownerToken });
    }
  }
}
