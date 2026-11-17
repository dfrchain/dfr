/**
 * @dfr/transaction —— 交易引擎（M1）。
 *
 * 责任（见 docs/development/module-catalog.md 第 3 节）：
 *   - 交易状态机；
 *   - Store **端口**（接口所有权在本包，实现由 packages/storage-postgres 提供）；
 *   - 幂等协调、nonce 协调、确认跟踪与恢复。
 *
 * 不负责：
 *   - HTTP 层、Provider 选择、链 RPC 编码、数据库驱动。
 *
 * 依赖方向：本包只依赖 `@dfr/types` 与 `@dfr/errors`。
 * 不得依赖 Core / Adapter / Provider / Registry / Storage——
 * 该边界由 tests/contract/module-boundaries.test.ts 自动守卫。
 *
 * 状态：状态机（A05）、Store 端口（A06）与 build 编排（B04）已落地；
 * simulate / broadcast / confirm 编排按任务书顺序后续落地。
 */

/**
 * 本包遵循的领域契约版本。
 *
 * 与 `docs/architecture/versioning-compatibility.md` 的规范版本对齐；
 * 因为业务代码尚未落地，此常量是 A04 阶段唯一可被引用的公开面，
 * 用于证明包在 workspace 中可被解析与 typecheck。
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

// 广播结果分类与 unknown 解析（DFR-M1-C03b，ADR-019）。
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

// build 阶段编排（DFR-M1-B04）。
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

// Store 端口（DFR-M1-A06）。用通配转出避免"加了端口却忘了导出"，
// 端口集合本身由 docs/architecture/m1-storage-model.md 第 8 节约束。
export * from './stores.js';
