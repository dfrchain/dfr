/**
 * 兼容 re-export（DFR-M1-A06）。
 *
 * Store 接口的**唯一权威位置**已迁移到 `packages/transaction`：
 * 见 docs/development/module-catalog.md 第 3 节与 docs/architecture/m1-storage-model.md 第 8 节。
 *
 * 本文件刻意**不包含任何定义**，只做转出，避免 Core 与 Transaction 出现两份
 * 会各自漂移的 Store 契约。实现由 `packages/storage-postgres` 提供。
 *
 * 迁移说明（见 docs/development/deliveries/DFR-M1-A06.md）：
 *   - M0 旧接口 `TransactionStore`（`put/get/list` 的只读观测缓存）已更名为
 *     `TransactionObservationStore`，因为 `TransactionStore` 现在是 M1 引擎端口；
 *   - M0 旧接口 `IdempotencyStore`（`get/put/prune`）在整个仓库零调用，
 *     且其职责被 M1 的 `IdempotencyStore`（`begin/complete/get/pruneExpired`）
 *     完整取代，故不再保留同名死接口。
 */

export { InMemoryTransactionObservationStore } from '@dfr/transaction';

export type {
  // M1 端口：TransactionStore
  CreateTransactionInput,
  CreateTransactionResult,
  ListRecoverableInput,
  TransactionRecord,
  TransactionStore,
  TransitionPatch,
  TransitionTransactionInput,
  TransitionTransactionResult,
  // M1 端口：IdempotencyStore
  BeginIdempotencyInput,
  BeginIdempotencyResult,
  CompleteIdempotencyInput,
  CompleteIdempotencyResult,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyState,
  IdempotencyStore,
  PruneExpiredIdempotencyInput,
  // M1 端口：NonceStore
  AdvanceNonceLeaseResult,
  NonceLease,
  NonceLeaseRef,
  NonceLeaseStatus,
  NonceReleaseForbiddenReason,
  NonceStore,
  ReleaseNonceLeaseResult,
  ReserveNonceInput,
  ReserveNonceResult,
  // M1 端口：TrackerLeaseStore
  AcquireTrackerLeaseInput,
  AcquireTrackerLeaseResult,
  ListRecoverableTrackerLeasesInput,
  ReleaseTrackerLeaseInput,
  ReleaseTrackerLeaseResult,
  RenewTrackerLeaseInput,
  RenewTrackerLeaseResult,
  TrackerLease,
  TrackerLeaseStore,
  // M0 兼容：只读观测缓存
  TransactionObservationStore,
} from '@dfr/transaction';
