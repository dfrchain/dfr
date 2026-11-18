/**
 * @dfr/transaction — the transaction engine (M1).
 *
 * Responsibilities (see docs/development/module-catalog.md section 3):
 *   - the transaction state machine;
 *   - Store **ports** (interface ownership lives in this package; implementations come from packages/storage-postgres);
 *   - idempotency coordination, nonce coordination, confirmation tracking, and recovery.
 *
 * Not responsible for:
 *   - the HTTP layer, Provider selection, chain RPC encoding, or database drivers.
 *
 * Dependency direction: this package only depends on `@dfr/types` and `@dfr/errors`.
 * It must not depend on Core / Adapter / Provider / Registry / Storage —
 * that boundary is guarded automatically by tests/contract/module-boundaries.test.ts.
 *
 * Status: the state machine (A05), Store ports (A06), and build orchestration (B04) have landed;
 * simulate / broadcast / confirm orchestration lands later, in task-book order.
 */

/**
 * The domain-contract version this package follows.
 *
 * Aligned with the spec version in `docs/architecture/versioning-compatibility.md`;
 * because the business code has not landed yet, this constant is the only public surface referenceable from phase A04,
 * proving the package can be resolved and typechecked in the workspace.
 */
export const TRANSACTION_SPEC_VERSION = '0.1' as const;

export {
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
  TRANSACTION_EVENTS,
  canTransition,
  transition,
} from './state-machine.js';
export type {
  TransitionAllowed,
  TransitionInput,
  TransitionRejected,
  TransitionRejectionReason,
  TransitionResult,
  TransitionSpec,
  TransactionEvent,
} from './state-machine.js';

// Broadcast result classification and unknown resolution (DFR-M1-C03b, ADR-019).
export { classifyBroadcastFailure, resolveUnknownOutcome } from './broadcast-outcome.js';
export type { BroadcastFailureClass, ChainBroadcastObservation } from './broadcast-outcome.js';

export { evaluateFinality } from './finality.js';
export type { EvaluateFinalityInput, FinalityEvaluation } from './finality.js';
export { TransactionMetrics, type TraceContext } from './metrics.js';
export {
  observeStores,
  storeCallKind,
  tagStoreName,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  withStoreCallContext,
  type StoreCallKind,
  type StoreCallRecord,
  type StoreCallSink,
  type StoreName,
} from './store-call.js';
export type {
  ReorgDepthBucket,
  TrackerLeaseOutcome,
  TransactionMetricsOptions,
  TransactionMetricsSink,
  TransactionStage,
  TransactionStageStatus,
} from './metrics.js';
export { ConfirmationTracker, ReorgReconciler } from './tracker.js';
export { ReorgScheduler, type ReorgSchedulerDeps } from './reorg-scheduler.js';
export { RecoveryScheduler, type RecoverySchedulerDeps } from './recovery-scheduler.js';
export {
  PeriodicSweep,
  assertSweepOptions,
  MAX_SWEEP_BATCH,
  MAX_SWEEP_INTERVAL_MS,
  MIN_SWEEP_INTERVAL_MS,
  type PeriodicSweepDeps,
} from './periodic-sweep.js';
export type {
  ConfirmationObservation,
  ConfirmationTrackerDeps,
  ConfirmationTrackResult,
  ReorgReconcilerDeps,
} from './tracker.js';
export { RecoveryCoordinator } from './recovery.js';
export type { RecoveryDeps, StrandedSignedReconcileOutcome } from './recovery.js';

// Build-phase orchestration (DFR-M1-B04).
export { TransactionEngine, fingerprintBuildRequest } from './engine.js';
export type {
  BroadcastTransactionInput,
  BroadcastTransactionResult,
  ChainConfirmInput,
  ConfirmTransactionInput,
  BuildTransactionInput,
  ChainObserveInput,
  BuiltTransactionResult,
  ChainBroadcastInput,
  ChainBuildInput,
  ChainSimulateInput,
  ChainSequencingExpiryInput,
  GetPendingNonceInput,
  PreflightTransactionInput,
  PreflightTransactionResult,
  SimulateTransactionInput,
  SimulatedTransactionResult,
  TransactionChainPort,
  TransactionEngineDeps,
  TransactionEngineStores,
} from './engine.js';

// Store ports (DFR-M1-A06). Wildcard re-export, so a newly added port is never forgotten in the exports;
// the port set itself is constrained by docs/architecture/m1-storage-model.md section 8.
export * from './stores.js';
