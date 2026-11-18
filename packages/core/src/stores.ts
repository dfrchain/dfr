/**
 * Compatibility re-export (DFR-M1-A06).
 *
 * The **single authoritative location** for the Store interfaces has moved to `packages/transaction`:
 * see docs/development/module-catalog.md section 3 and docs/architecture/m1-storage-model.md section 8.
 *
 * This file deliberately contains **no definitions** at all, only re-exports, so Core and Transaction never end up with two
 * Store contracts that drift apart. Implementations come from `packages/storage-postgres`.
 *
 * Migration notes (see docs/development/deliveries/DFR-M1-A06.md):
 *   - the M0 old interface `TransactionStore` (the read-only observation cache with `put/get/list`) has been renamed to
 *     `TransactionObservationStore`, because `TransactionStore` is now the M1 engine port;
 *   - the M0 old interface `IdempotencyStore` (`get/put/prune`) has zero call sites in the whole repo,
 *     and its responsibilities are fully replaced by M1's `IdempotencyStore` (`begin/complete/get/pruneExpired`),
 *     so the dead interface of the same name is no longer kept.
 */

export { InMemoryTransactionObservationStore } from '@dfr/transaction';

export type {
  // M1 port: TransactionStore
  CreateTransactionInput,
  CreateTransactionResult,
  ListRecoverableInput,
  TransactionRecord,
  TransactionStore,
  TransitionPatch,
  TransitionTransactionInput,
  TransitionTransactionResult,
  // M1 port: IdempotencyStore
  BeginIdempotencyInput,
  BeginIdempotencyResult,
  CompleteIdempotencyInput,
  CompleteIdempotencyResult,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyState,
  IdempotencyStore,
  PruneExpiredIdempotencyInput,
  // M1 port: NonceStore
  AdvanceNonceLeaseResult,
  NonceLease,
  NonceLeaseRef,
  NonceLeaseStatus,
  NonceReleaseForbiddenReason,
  NonceStore,
  ReleaseNonceLeaseResult,
  ReserveNonceInput,
  ReserveNonceResult,
  // M1 port: TrackerLeaseStore
  AcquireTrackerLeaseInput,
  AcquireTrackerLeaseResult,
  ListRecoverableTrackerLeasesInput,
  ReleaseTrackerLeaseInput,
  ReleaseTrackerLeaseResult,
  RenewTrackerLeaseInput,
  RenewTrackerLeaseResult,
  TrackerLease,
  TrackerLeaseStore,
  // M0 compatibility: read-only observation cache
  TransactionObservationStore,
} from '@dfr/transaction';
