/**
 * TransactionEngine —— build 阶段编排（DFR-M1-B04）。
 *
 * 权威来源：docs/architecture/development-plan.md 第 4.3/4.4 节、
 * docs/architecture/transaction-lifecycle.md 第 8 节、
 * docs/architecture/m1-api-contract.md 第 2 节。
 *
 * 职责（只做编排，不做链语义、不做数据库驱动）：
 *
 * ```text
 * 幂等 begin ─► 读链上 pending nonce ─► NonceStore.reserve ─► 链 build（显式 nonce）
 *                                                   │
 *                                   失败 ───────────┴─► 安全释放未签名租约 → 原错误上抛
 *                                   成功 ─► TransactionStore.create(status='built')
 *                                        ─► 幂等 complete（保存 transactionId）
 * ```
 *
 * 依赖方向（AGENTS.md 第 3 节）：本包只依赖 `@dfr/types` 与 `@dfr/errors`。
 * 链访问因此通过**端口** `TransactionChainPort` 注入，由 composition root
 * （Gateway main）用具体 Adapter 实现；本包不 import Adapter / Provider / Core / Storage。
 *
 * M1 边界：
 * - nonce 一律由服务端分配并落租约；请求自带 `nonce` 直接拒绝（fail-closed），
 *   避免调用方绕过租约造成同 nonce 双花。Adapter 的"显式 nonce"正是给本引擎用的；
 * - `signedPayload` 不属于本阶段，记录里也没有该字段；
 * - build 无链上副作用，因此幂等键可选（gateway-spec 第 7.1 节）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDfrError, isDfrError, newRequestId } from '@dfr/errors';
import type {
  AccountRef,
  BroadcastOptions,
  BroadcastResult,
  ChainId,
  ConfirmationResult,
  DecimalUint,
  FinalityLevel,
  Iso8601,
  RequestId,
  SignedTransaction,
  SimulationResult,
  SequencingToken,
  TransactionId,
  TransactionRequest,
  TransactionStatus,
  UnsignedTransaction,
} from '@dfr/types';
import { ConfirmationTracker } from './tracker.js';
import type { ConfirmationTrackResult } from './tracker.js';
import type { TransactionMetricsSink, TransactionStage } from './metrics.js';
import {
  observeStores,
  tagStoreName,
  withStoreCallContext,
  type StoreCallSink,
} from './store-call.js';
import { classifyBroadcastFailure, resolveUnknownOutcome } from './broadcast-outcome.js';
import type { ChainBroadcastObservation } from './broadcast-outcome.js';
import { transition, type TransactionEvent } from './state-machine.js';
import type {
  IdempotencyScope,
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLeaseStore,
  TransactionRecord,
  TransactionStore,
  TransitionPatch,
} from './stores.js';

/* ================================================================== */
/* 端口：链访问                                                       */
/* ================================================================== */

export interface GetPendingNonceInput {
  readonly chain: ChainId;
  readonly account: AccountRef;
  /**
   * 关联错误与审计的请求 ID（DFR-M1-B07 起由引擎透传）。
   * 端口实现必须把它带进 `AdapterContext.requestId`，不得用随机值掩盖调用来源。
   */
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

export interface ChainBuildInput {
  /**
   * 携带引擎**分配并落租约**的排序前提（ADR-033）：EVM 路径注入 `nonce`，
   * Solana 路径注入 `recentBlockhash`。Adapter 必须原样使用，不得自行查询，
   * 否则租约与载荷会不一致。
   */
  readonly request: TransactionRequest;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

export interface ChainSimulateInput {
  readonly transactionId: TransactionId;
  readonly unsigned: UnsignedTransaction;
  /**
   * 记录中的发送方。
   *
   * `UnsignedTransaction` 本身**不含**发送方（见 B03 交付报告），而 EVM 的
   * `eth_call` 需要 `from` 才能覆盖余额 / 授权 / nonce 检查。引擎知道这个事实，
   * 因此显式传给端口；具体如何使用由实现方（composition root + Adapter）决定。
   */
  readonly from: AccountRef;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

/**
 * 链访问端口（由 composition root 实现）。
 *
 * 只暴露 build 阶段需要的两个动作：读 pending nonce 与构造未签名载荷。
 * 两次调用必须落到**同一个** Provider 句柄上的同一条链，该约束由实现方（Adapter）保证。
 */
/**
 * 广播端口输入（DFR-M1-C03a）。
 *
 * `expected` 是**记录真值**：`SignedTransaction` 不含发送方，客户端回传的 unsigned
 * 也只是回声。Adapter 必须用它与签名载荷逐项比对（`bindSignedTransaction`），
 * 否则"换账户/换参数但复用同一 transactionId"无法被发现。
 */
export interface ChainBroadcastInput {
  readonly signed: SignedTransaction;
  readonly expected: {
    readonly from: AccountRef;
    readonly unsignedPayload: string;
  };
  readonly options?: BroadcastOptions;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

/** B43: verify a PERSISTED sequencing reference's validity before any send.
 * The adapter owns block-height semantics; Transaction only routes this port.
 * Caller must supply the Store's original token, never a client echo.
 */
export interface ChainSequencingExpiryInput {
  readonly chain: ChainId;
  readonly token: SequencingToken;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

export interface TransactionChainPort {
  /** EVM nonce 路径（有则优先用它，保持 M1 行为不变）。 */
  getPendingNonce?(input: GetPendingNonceInput): Promise<DecimalUint>;
  /**
   * 链无关排序前提（ADR-033）：EVM 返回 nonce，Solana 返回 blockhash。
   * 引擎按"本链用哪条路径"选择：有 `getPendingNonce` 走 nonce，否则走本方法。
   */
  getSequencingToken?(input: GetPendingNonceInput): Promise<SequencingToken>;
  /** Mandatory pre-broadcast validity check for Store-persisted blockhash tokens. */
  isSequencingExpired?(input: ChainSequencingExpiryInput): Promise<boolean>;
  /**
   * 把引擎分配的排序前提注入请求（ADR-033）。走 sequencing 路径时必填：
   * Solana 的 build 必须用 Store 已落租约的 blockhash，否则租约与载荷不一致。
   */
  withSequencingToken?(request: TransactionRequest, token: SequencingToken): TransactionRequest;
  build(input: ChainBuildInput): Promise<UnsignedTransaction>;
  /** 只读模拟（无副作用）。回滚通过 `SimulationResult.success=false` 表达，不抛错。 */
  simulate(input: ChainSimulateInput): Promise<SimulationResult>;
  /**
   * 单次广播（DFR-M1-C03a）。
   *
   * 可选：未装配广播实现的部署在运行时 fail-closed（`DFR_UNSUPPORTED_CAPABILITY`），
   * 而不是静默跳过。实现方（composition root）负责把它接到 Adapter 的
   * `broadcast()` 与签名绑定校验上。
   */
  broadcast?(input: ChainBroadcastInput): Promise<BroadcastResult>;

  /**
   * 观测一笔交易在链上的真实处境（DFR-M1-C03b，ADR-019）。
   *
   * 只在广播结果不确定时调用。**可选**：未装配时引擎保持 `unknown`
   * （fail-closed：不假装 dropped，也不假装 failed）。
   *
   * 实现方（composition root + Adapter）按 expectedHash 查询，并在查不到时
   * 比较该账户的链上 nonce 以区分 `replaced` 与 `absent`。
   */
  observe?(input: ChainObserveInput): Promise<ChainBroadcastObservation>;

  /** 单次只读确认观测；状态判定由 Core/Registry 提供，等待与 lease 由 Transaction 负责。 */
  confirm?(input: ChainConfirmInput): Promise<ConfirmationResult>;
}

export interface ChainConfirmInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly minFinality?: FinalityLevel;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
  readonly background?: boolean;
}

/** 观测输入：全部来自记录（expectedHash / from / nonce），不来自调用方声明。 */
export interface ChainObserveInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly from: AccountRef;
  readonly nonce: DecimalUint;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

/* ================================================================== */
/* 依赖与结果类型                                                     */
/* ================================================================== */

export interface TransactionEngineStores {
  readonly transaction: TransactionStore;
  readonly idempotency: IdempotencyStore;
  readonly nonce: NonceStore;
  /** M3-B03：Solana 的 blockhash 排序租约；走 sequencing 路径时必填。 */
  readonly sequencing?: SequencingStore;
  /** D02 tracker lease；缺失时 confirm 必须 fail-closed。 */
  readonly tracker?: TrackerLeaseStore;
}

export interface ConfirmTransactionInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly minFinality?: FinalityLevel;
  readonly timeoutMs?: number;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
}

export interface TransactionEngineDeps {
  readonly stores: TransactionEngineStores;
  readonly chain: TransactionChainPort;
  /** 注入时钟（测试确定性）；默认 `() => new Date().toISOString()`。 */
  readonly now?: () => Iso8601;
  /** 注入交易 ID 生成器；默认 `txn_<32 hex>`。 */
  readonly newTransactionId?: () => TransactionId;
  /** 幂等执行权 owner token 生成器；默认随机 16 字节 hex。 */
  readonly newOwnerToken?: () => string;
  /**
   * 请求指纹。默认 `fingerprintBuildRequest`。
   *
   * m1-api-contract 第 4 节要求"canonicalization 只有一个实现"：Gateway 必须
   * 复用本函数（或注入同一个实现），不得再写一份。
   */
  readonly fingerprint?: (request: TransactionRequest) => string;
  /** 幂等 in-flight 租约时长；默认 30s。 */
  readonly idempotencyLeaseTtlMs?: number;
  /** nonce 租约时长；默认 5 分钟。 */
  readonly nonceLeaseTtlMs?: number;
  /** 确认等待时钟注入点；生产使用 Date.now/setTimeout。 */
  readonly confirmationClock?: () => number;
  readonly confirmationSleep?: (ms: number) => Promise<void>;
  readonly metrics?: TransactionMetricsSink;
  /**
   * Store 调用观测出口（observability-spec 第 4 章 `store.read` / `store.write`）。
   * 与 metrics 一样是可选汇点；未注入时零开销。观测失败绝不影响业务。
   */
  readonly onStoreCall?: StoreCallSink;
  /**
   * 状态迁移事件出口（transaction-lifecycle 第 6 章："一切状态变化必须发事件"）。
   *
   * 与 `onStoreCall` 同一约定：可选汇点，未注入时零开销，**抛错被吞掉**——
   * 事件投递失败绝不能改变业务结果（与"观测失败不得影响被观测路径"一致）。
   *
   * 为什么用回调而不是让引擎依赖 `@dfr/events`：模块边界要求本包只依赖叶子工具包
   * （types/errors/metrics）。引擎不感知总线；composition root 负责把它接到总线上，
   * 并分配 cursor（cursor 属于**订阅作用域**，是总线侧的概念）。
   */
  readonly onTransition?: TransitionEventSink;
  /**
   * `unknown` 判定为 `dropped` 所需的静默时长（ADR-023）。默认 30 分钟。
   *
   * 只有"观测为 absent **且** 静默已超过本时长"才判丢弃；单独任一条都不够。
   */
  readonly dropTimeoutMs?: number;
  /**
   * 判定超时用的时钟（毫秒）。默认 `Date.now`。
   *
   * 与 `now`（写记录时间戳）分开：测试需要"记录时间固定、当前时间可推进"才能
   * 验证超时语义；生产两者都是真实时钟。
   */
  readonly dropClock?: () => number;
}

/**
 * 一次已提交的状态迁移（引擎 → 汇点）。
 *
 * 只在 Store 确认写入成功后发出（"事务提交后才发布"），因此订阅者看到的
 * 都是已持久化的事实，不会出现"事件说变了、库里没变"。
 */
export interface TransitionEventRecord {
  readonly transactionId: TransactionId;
  readonly chain: ChainId;
  readonly fromStatus: TransactionStatus;
  readonly toStatus: TransactionStatus;
  readonly stateVersion: DecimalUint;
  readonly requestId: RequestId;
  readonly txHash?: string;
}

export type TransitionEventSink = (record: TransitionEventRecord) => void;

/**
 * 预检请求（ADR-037 方案 B）。
 *
 * 与 `build` 的区别：**不占 nonce、不落库、不产生任何持久副作用**。
 * 用途是回答"这笔交易大概能不能过、要多少 gas"——而当前 `simulate` 必须先有
 * `transactionId`（即必须先 build），于是调用方被迫用 `build` 做预检，
 * 每次预检都消耗一个链上 nonce，反复预检即留下永久空洞（ADR-037 背景）。
 */
/**
 * 显式作废一笔**未广播**的交易（ADR-037 方案 A）。
 *
 * 用途：build 会立即占用一个链上 nonce；若调用方决定不提交这笔交易，
 * 必须有正确的清理动作，否则 nonce 永久占位、链上形成永久空洞。
 */
export interface AbandonTransactionInput {
  readonly transactionId: TransactionId;
  /** Gateway identity, if provided, must own this persisted transaction. */
  readonly requesterProjectId?: string;
  /** Chain scope granted to the invoking API Key (not a client body claim). */
  readonly authorizedChains?: readonly ChainId[] | '*';
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface AbandonTransactionResult {
  readonly transactionId: TransactionId;
  readonly status: 'abandoned';
  /** 本次是否真的释放了 nonce 租约（幂等重放时为 false）。 */
  readonly leaseReleased: boolean;
  readonly nonce?: DecimalUint;
}

export interface PreflightTransactionInput {
  readonly request: TransactionRequest;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
  /**
   * 预检结果的「新鲜度上限」（毫秒）。省略即用端口默认。
   *
   * 与 `simulate` 一致的**只读**语义：`eth_call`/`eth_estimateGas` 走 pending 区块，
   * 结果不是承诺——链上状态可能在下一次调用前变化。
   */
  readonly estimateTimeoutMs?: number;
}

export interface PreflightTransactionResult {
  /**
   * 构造出来的未签名载荷。
   *
   * **仅供预览**：它是在**只读**的 pending nonce 之上构造的，没有租约保护，
   * 因此**不可用于签名与广播**（并发 build 可能拿到同一个 nonce）。
   * 要真正提交，必须另走 `build` → `simulate` → 签名 → `broadcast`。
   *
   * `undefined` 表示**在 gas 估计阶段就回滚了**（没有可通过的载荷可供预览）。
   * 这是诚实的：不伪造一个注定失败、且字段不完整的载荷。
   */
  readonly unsignedTransaction?: UnsignedTransaction;
  /** 只读模拟结果；回滚以 `success=false` 表达，不抛错（与 simulate 一致）。 */
  readonly simulation: SimulationResult;
  /** 本次预检**未**占用，仅供展示的 pending nonce；调用方不得据此签名。 */
  readonly observedNonce?: DecimalUint;
  readonly requestId: RequestId;
}

export interface BuildTransactionInput {
  readonly request: TransactionRequest;
  /** 可选：build 无副作用（gateway-spec 第 7.1 节）。 */
  readonly idempotencyKey?: string;
  /** M1 固定 `default`；多租户控制面属 M5。 */
  readonly projectId?: string;
  /** 用于关联错误与审计；省略时自动生成。 */
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
}

export interface BuiltTransactionResult {
  readonly transactionId: TransactionId;
  /** 记录**当前**生命周期状态；首次 build 为 `built`，重放时可能是后续状态。 */
  readonly status: TransactionStatus;
  /** EVM 的排序前提；Solana 为 undefined（用 `sequencingToken`）。 */
  readonly nonce?: DecimalUint;
  /** 链无关排序前提（ADR-033）：EVM={kind:nonce}，Solana={kind:blockhash}。 */
  readonly sequencingToken?: SequencingToken;
  readonly unsignedTransaction: UnsignedTransaction;
  /** true = 命中幂等记录，未重新执行、未消耗新 nonce。 */
  readonly replayed: boolean;
  /**
   * false = 该结果不会被重放：未提供幂等键，或本次失去幂等写入权。
   * 调用方据此决定"能否安全重试同一请求"。
   */
  readonly replayable: boolean;
}

export interface SimulateTransactionInput {
  readonly transactionId: TransactionId;
  /**
   * build 返回的未签名载荷。
   *
   * M1 不接受"另带一个载荷"：必须与落库记录逐字节一致，否则拒绝
   * （m1-api-contract 第 2 节："不接受与已保存 build 指纹不一致的 unsigned payload"）。
   */
  readonly unsignedTransaction: UnsignedTransaction;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
}

export interface SimulatedTransactionResult {
  readonly transactionId: TransactionId;
  /** 记录**当前**生命周期状态：`simulated`（成功）或调用方捕获 `reverted` 错误。 */
  readonly status: TransactionStatus;
  readonly simulation: SimulationResult;
}

/* ================================================================== */
/* 规范化指纹                                                         */
/* ================================================================== */

/** Encode canonical JSON directly: object reconstruction reorders integer-like keys. */
function canonicalize(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry) ?? 'null').join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => {
        const encoded = canonicalize(entry);
        return encoded === undefined ? null : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter((entry): entry is string => entry !== null);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * `TransactionRequest` 的规范指纹（SHA-256，hex）。
 *
 * 不含 header / requestId / traceId：调用方换个 User-Agent 不应被判成冲突
 * （gateway-spec 第 7.2 节）。数值仍是十进制字符串，因此指纹稳定。
 */
export function fingerprintBuildRequest(request: TransactionRequest): string {
  const encoded = canonicalize(request);
  if (encoded === undefined) throw new TypeError('Cannot fingerprint non-JSON input');
  return createHash('sha256').update(encoded).digest('hex');
}

/* ================================================================== */
/* 引擎                                                               */
/* ================================================================== */

const DEFAULT_IDEMPOTENCY_LEASE_TTL_MS = 30_000;
const DEFAULT_NONCE_LEASE_TTL_MS = 5 * 60_000;
/** ADR-023：unknown 静默超过该时长（且观测为 absent）才判 dropped。 */
const DEFAULT_DROP_TIMEOUT_MS = 30 * 60_000;

/** 状态迁移的 CAS 重试上限：冲突说明有并发写入者，重读后重新推导即可。 */
const MAX_TRANSITION_ATTEMPTS = 3;

function traceContext(input: { readonly traceId?: string; readonly spanId?: string }): {
  traceId?: string;
  spanId?: string;
} {
  return {
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
  };
}

/** 允许执行 simulate 的状态：只允许在签名之前（transaction-lifecycle 第 4.2 节）。 */
const SIMULATABLE_STATUSES: readonly TransactionStatus[] = ['built', 'simulated'];

type ScopedTransactionRequest = {
  /** Trusted gateway scope, never derived from client payload. */
  readonly requesterProjectId?: string;
  readonly authorizedChains?: readonly ChainId[] | '*';
};

export interface BroadcastTransactionInput extends ScopedTransactionRequest {
  readonly transactionId: TransactionId;
  /**
   * 客户端回传的签名结果。
   *
   * `signed.unsigned.payload` 只是回声：引擎把它与**记录里的** unsigned 载荷比对，
   * 不一致直接拒绝，绝不因为"客户端说一致"就放行。
   */
  readonly signed: SignedTransaction;
  /** `rebroadcast` 由状态机与 HTTP 层控制；引擎只透传。 */
  readonly options?: BroadcastOptions;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
}

export interface BroadcastTransactionResult {
  readonly transactionId: TransactionId;
  /** 广播成功后的记录状态，固定为 `broadcast`。 */
  readonly status: TransactionStatus;
  readonly txHash: string;
  readonly accepted: boolean;
  readonly rebroadcast?: boolean;
  readonly observedAt: Iso8601;
}

/* ================================================================== */
/* 引擎                                                               */
/* ================================================================== */

export class TransactionEngine {
  private readonly deps: TransactionEngineDeps;
  private readonly fingerprint: (request: TransactionRequest) => string;
  private readonly confirmationTracker?: ConfirmationTracker;

  /** 被观测包装后的 Store 端口；所有内部调用都走这里（见 store-call.ts）。 */
  private readonly stores: TransactionEngineStores;

  constructor(deps: TransactionEngineDeps) {
    this.deps = deps;
    // 端口层包装：单点实现，结构上不可能漏掉某个调用处。
    const sink = deps.onStoreCall;
    const tagged: TransactionEngineStores = {
      transaction: tagStoreName(deps.stores.transaction, 'transaction'),
      idempotency: tagStoreName(deps.stores.idempotency, 'idempotency'),
      nonce: tagStoreName(deps.stores.nonce, 'nonce'),
      ...(deps.stores.sequencing !== undefined
        ? { sequencing: tagStoreName(deps.stores.sequencing, 'sequencing') }
        : {}),
      ...(deps.stores.tracker !== undefined
        ? { tracker: tagStoreName(deps.stores.tracker, 'tracker') }
        : {}),
    };
    this.stores = {
      transaction: observeStores(tagged.transaction, sink),
      idempotency: observeStores(tagged.idempotency, sink),
      nonce: observeStores(tagged.nonce, sink),
      ...(tagged.sequencing !== undefined
        ? { sequencing: observeStores(tagged.sequencing, sink) }
        : {}),
      ...(tagged.tracker !== undefined ? { tracker: observeStores(tagged.tracker, sink) } : {}),
    };
    this.fingerprint = deps.fingerprint ?? fingerprintBuildRequest;
    if (this.stores.tracker !== undefined && deps.chain.confirm !== undefined) {
      this.confirmationTracker = new ConfirmationTracker({
        // 传入**包装后**的端口：confirm 路径的 Store 调用同样被观测。
        leases: this.stores.tracker,
        transactions: this.stores.transaction,
        observe: async (input) => {
          const confirmation = await deps.chain.confirm!({
            chain: input.chain,
            txHash: input.txHash,
            ...(input.required !== undefined ? { minFinality: input.required } : {}),
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
            ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
            ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
            ...(input.signal !== undefined ? { signal: input.signal } : { signal: new AbortController().signal }),
          });
          return {
            observed: confirmation.finality,
            reached: confirmation.reached,
            confirmation,
          };
        },
        ownerToken: () => this.newOwnerToken(),
        ...(deps.confirmationClock !== undefined ? { now: deps.confirmationClock } : {}),
        ...(deps.confirmationSleep !== undefined ? { sleep: deps.confirmationSleep } : {}),
      });
    }
  }

  /** 构造未签名交易并落库为 `built`（B04）。不签名、不广播。 */
  async build(input: BuildTransactionInput): Promise<BuiltTransactionResult> {
    // 建立进程内请求上下文：其间的 Store 调用自动携带 requestId/trace/span。
    return this.measure(input.request.chain, 'build', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.buildInternal(input),
      ),
    );
  }

  /**
   * 显式作废一笔未广播的交易（ADR-037 方案 A）。**幂等**：已 `abandoned` 再调返回 200。
   *
   * 安全顺序（B37）：**先基于状态+版本 CAS 转终态，再释放租约**。
   * 并发签名若抢赢 CAS，手动作废不得先释放仍可能上链的 nonce；
   * 如果后续释放暂时失败，租约仍 reserved，但 B34 的 TTL 清理仅允许
   * 无 expected_hash/tx_hash 的 abandoned 交易回收，避免误释放已签名 nonce。
   */
  async abandon(input: AbandonTransactionInput): Promise<AbandonTransactionResult> {
    const requestId = input.requestId ?? newRequestId();
    const record = await this.stores.transaction.get(input.transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_TRANSACTION_NOT_FOUND',
        requestId,
        undefined,
        `未知交易 ${input.transactionId}`,
        { transactionId: input.transactionId },
      );
    }

    // AUTH-03: DELETE carries only transactionId. Resolve the authoritative
    // chain and project from the persisted record before any release, idempotent
    // response, or state transition. Never trust a caller-supplied chain here.
    if (
      (input.requesterProjectId !== undefined && record.projectId !== input.requesterProjectId) ||
      (input.authorizedChains !== undefined && input.authorizedChains !== '*' &&
       !input.authorizedChains.includes(record.chain))
    ) {
      throw this.fail(
        'DFR_PROJECT_SCOPE_DENIED',
        requestId,
        undefined,
        '无权访问该交易',
      );
    }

    // 幂等：已经作废过就直接返回，不重复释放、不重复迁移。
    if (record.status === 'abandoned') {
      return {
        transactionId: record.transactionId,
        status: 'abandoned',
        leaseReleased: false,
        ...(record.nonce !== undefined ? { nonce: record.nonce } : {}),
      };
    }

    if (record.status !== 'built' && record.status !== 'simulated') {
      throw this.fail(
        'DFR_TRANSACTION_REJECTED',
        requestId,
        record.chain,
        `交易当前状态 ${record.status} 不允许作废（只允许 built / simulated）`,
        { reason: 'not_abandonable', fields: ['status'], status: record.status },
      );
    }

    // 1) CAS first: a different worker may have signed after our initial
    // read. Never release its live nonce on a stale built/simulated snapshot.
    // Retry-on-conflict is handled by applyTransition: once already signed,
    // abandoned is not an allowed edge and the request fails closed.
    const applied = await this.applyTransition(record, 'abandon', requestId);

    // 2) Post-CAS cleanup is best effort; terminal abandoned is durable.
    // B34 TTL orphan cleanup reclaims only hash-free abandoned transactions.
    let leaseReleased = false;
    if (record.nonce !== undefined) {
      try {
        const released = await this.stores.nonce.releaseIfSafe({
          chain: record.chain,
          account: record.from,
          nonce: record.nonce,
          transactionId: record.transactionId,
        });
        leaseReleased = released.kind === 'released';
      } catch {
        // 释放失败不掩盖主流程：记录仍必须进入终态，租约则由巡检/重启清理兜底。
        leaseReleased = false;
      }
    } else if (record.sequencingRef !== undefined && this.stores.sequencing !== undefined) {
      try {
        const released = await this.stores.sequencing.releaseIfSafe({
          chain: record.chain,
          account: record.from,
          transactionId: record.transactionId,
          tokenValue: record.sequencingRef.value,
        });
        leaseReleased = released.kind === 'released';
      } catch {
        leaseReleased = false;
      }
    }

    return {
      transactionId: applied.transactionId,
      status: 'abandoned',
      leaseReleased,
      ...(record.nonce !== undefined ? { nonce: record.nonce } : {}),
    };
  }

  /**
   * 预检：只读地回答"这笔交易能不能过"（ADR-037 方案 B）。**不占 nonce、不落库。**
   *
   * 与 `build` 的关键差异（也是它存在的理由）：
   *   - **不** `nonce.reserve`、**不** `transaction.create`、**不**写幂等表；
   *   - pending nonce 是**只读**读出来的，仅用于构造预览载荷与模拟 `from` 检查；
   *   - 因此可以安全地反复调用——这正是调用方此前用 `build` 做的事。
   *
   * `simulate` 必须先有 `transactionId`，而 `transactionId` 只在 `build` 时产生；
   * 在 preflight 出现之前，"预检"只能靠 build，每次消耗一个 nonce（ADR-037 实测成因）。
   */
  async preflight(input: PreflightTransactionInput): Promise<PreflightTransactionResult> {
    return this.measure(input.request.chain, 'preflight', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.preflightInternal(input),
      ),
    );
  }

  private async preflightInternal(input: PreflightTransactionInput): Promise<PreflightTransactionResult> {
    const { request } = input;
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const signal = input.signal ?? new AbortController().signal;

    if (request.nonce !== undefined) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        request.chain,
        'preflight 不接受自带 nonce；它会只读地取 pending nonce 用于预览',
        { fields: ['nonce'] },
      );
    }

    const port = this.deps.chain;

    // 只读取排序前提。**绝不复用 build 的 reserve 路径**——那正是本方法要消除的副作用。
    let pendingToken: SequencingToken;
    if (typeof port.getSequencingToken === 'function') {
      pendingToken = await port.getSequencingToken({
        chain: request.chain,
        account: request.from,
        requestId,
        ...trace,
        signal,
      });
    } else if (typeof port.getPendingNonce === 'function') {
      pendingToken = {
        kind: 'nonce',
        value: await port.getPendingNonce({
          chain: request.chain,
          account: request.from,
          requestId,
          ...trace,
          signal,
        }),
      };
    } else {
      throw this.fail(
        'DFR_UNSUPPORTED_CAPABILITY',
        requestId,
        request.chain,
        '本链既没有排序前提读取，也没有 nonce 读取，无法预检',
        { capability: 'transaction.build', reason: 'method_missing' },
      );
    }

    let adapterRequest: TransactionRequest;
    let observedNonce: DecimalUint | undefined;
    if (pendingToken.kind === 'nonce') {
      observedNonce = pendingToken.value;
      adapterRequest = { ...request, nonce: pendingToken.value };
    } else {
      // Solana：blockhash 注入只是让载荷可构造；不落租约，故与 build 的严格一致性要求无关。
      adapterRequest =
        typeof port.withSequencingToken === 'function'
          ? port.withSequencingToken(request, pendingToken)
          : { ...request, recentBlockhash: pendingToken.value };
    }

    let unsigned: UnsignedTransaction;
    try {
      unsigned = await port.build({ request: adapterRequest, requestId, ...trace, signal });
    } catch (err) {
      // ⚠️ 这是个**真实的**语义要点（2026-10-07 真实链联调抓到）：
      // `build` 会用 `eth_estimateGas` 推导 gas，而一笔注定回滚的交易在**估计阶段**
      // 就会回滚，于是 build 抛出 `DFR_TRANSACTION_REVERTED`——
      // 此时 preflight 根本走不到 simulate，调用方拿到的是 422 而不是"失败信息"。
      //
      // 但预检的价值**恰恰是**把失败当信息返回（否则调用方又要回到"用 build 试"的老路，
      // 而那正是 ADR-037 要消灭的成因）。因此这里把"可预期的执行回滚"转成
      // `simulation.success=false` 返回 200，与本方法的文档一致。
      //
      // 只吞**执行回滚**这一类：Provider 不可用、余额不足、配置错误等一律继续抛出——
      // error-spec 第 5.2 章：分类不确定时不得降级、不得猜测。
      if (!(isDfrError(err) && err.code === 'DFR_TRANSACTION_REVERTED')) throw err;
      return {
        // 明确**不返回** unsignedTransaction（回滚时没有可通过的载荷可供预览）。
        simulation: {
          success: false,
          ...(typeof err.details?.['revertReason'] === 'string'
            ? { revertReason: err.details['revertReason'] }
            : {}),
          warnings: ['preflight 在 gas 估计阶段即回滚；未生成预览载荷'],
        },
        ...(observedNonce !== undefined ? { observedNonce } : {}),
        requestId,
      };
    }

    // 只读模拟。回滚以 success=false 表达（与 simulate 相同），不转成异常。
    const simulation = await port.simulate({
      transactionId: `txn_preflight` as TransactionId,
      unsigned,
      from: request.from,
      requestId,
      ...trace,
      signal,
    });

    return {
      unsignedTransaction: unsigned,
      simulation,
      ...(observedNonce !== undefined ? { observedNonce } : {}),
      requestId,
    };
  }

  private async buildInternal(input: BuildTransactionInput): Promise<BuiltTransactionResult> {
    const { request } = input;
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const projectId = input.projectId ?? 'default';
    const signal = input.signal ?? new AbortController().signal;

    if (request.nonce !== undefined) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        request.chain,
        'M1 的 nonce 由服务端分配并落租约；请求不得自带 nonce',
        { fields: ['nonce'] },
      );
    }

    const fingerprint = this.fingerprint(request);
    const scope: IdempotencyScope | undefined =
      input.idempotencyKey === undefined
        ? undefined
        : { projectId, chain: request.chain, key: input.idempotencyKey };

    let ownerToken: string | undefined;
    if (scope !== undefined) {
      ownerToken = this.newOwnerToken();
      const began = await this.stores.idempotency.begin({
        scope,
        fingerprint,
        ownerToken,
        leaseTtlMs: this.deps.idempotencyLeaseTtlMs ?? DEFAULT_IDEMPOTENCY_LEASE_TTL_MS,
      });
      if (began.kind === 'conflict') {
        throw this.fail(
          'DFR_IDEMPOTENCY_CONFLICT',
          requestId,
          request.chain,
          '同一幂等键已用于不同的请求体',
          { idempotencyKey: scope.key },
        );
      }
      if (began.kind === 'in_flight') {
        // 并发重复请求：不重复执行，否则会产生两个 nonce / 两笔交易。
        throw this.fail(
          'DFR_IDEMPOTENCY_CONFLICT',
          requestId,
          request.chain,
          '同一幂等键的请求正在处理中',
          { idempotencyKey: scope.key, retryAfterMs: began.retryAfterMs },
        );
      }
      if (began.kind === 'replayed') {
        return await this.replay(began.record.transactionId, requestId, request.chain);
      }
    }

    const transactionId = this.newTransactionId();
    const leaseTtlMs = this.deps.nonceLeaseTtlMs ?? DEFAULT_NONCE_LEASE_TTL_MS;
    const port = this.deps.chain;

    // 排序前提（ADR-033）。**按 token 的 kind 分派到对应 Store**，而不是按链族——
    // 这样引擎完全不知道"哪条链是哪一家"，链差异只经 Adapter。
    //
    // 取 token 的入口优先级：
    //   1. `getSequencingToken`（链无关，EVM 返回 nonce / Solana 返回 blockhash）；
    //   2. 退回到 `getPendingNonce`（M1 的 EVM 端口只实现了它；向后兼容）。
    let pendingToken: SequencingToken;
    if (typeof port.getSequencingToken === 'function') {
      pendingToken = await port.getSequencingToken({
        chain: request.chain,
        account: request.from,
        requestId,
        ...trace,
        signal,
      });
    } else if (typeof port.getPendingNonce === 'function') {
      pendingToken = {
        kind: 'nonce',
        value: await port.getPendingNonce({
          chain: request.chain,
          account: request.from,
          requestId,
          ...trace,
          signal,
        }),
      };
    } else {
      throw this.fail(
        'DFR_UNSUPPORTED_CAPABILITY',
        requestId,
        request.chain,
        '本链既没有排序前提读取，也没有 nonce 读取，无法分配排序前提',
        { capability: 'transaction.build', reason: 'method_missing' },
      );
    }

    let nonce: DecimalUint | undefined;
    let sequencingToken: SequencingToken | undefined;
    // 需要传给 Adapter 的请求：nonce 路径注入 nonce，sequencing 路径注入 blockhash。
    let adapterRequest: TransactionRequest;
    let reservedKind: 'reserved' | 'reused';

    if (pendingToken.kind === 'nonce') {
      // EVM 路径：与 M1 完全一致（NonceStore + 显式 nonce）。
      const reserved = await this.stores.nonce.reserve({
        chain: request.chain,
        account: request.from,
        transactionId,
        chainPendingNonce: pendingToken.value,
        leaseTtlMs,
      });
      if (reserved.kind === 'conflict') {
        throw this.fail(
          'DFR_NONCE_CONFLICT',
          requestId,
          request.chain,
          `nonce ${reserved.lease.nonce} 已被其他交易占用`,
          { nonce: reserved.lease.nonce },
        );
      }
      nonce = reserved.lease.nonce;
      reservedKind = reserved.kind;
      sequencingToken = { kind: 'nonce', value: nonce };
      adapterRequest = { ...request, nonce };
    } else {
      // Solana 路径：SequencingStore + 固定的 blockhash。缺装配一律 fail-closed。
      if (this.stores.sequencing === undefined) {
        throw this.fail(
          'DFR_CONFIGURATION_ERROR',
          requestId,
          request.chain,
          '本链返回 blockhash 排序前提，但未装配 SequencingStore',
          { capability: 'transaction.build' },
        );
      }
      if (typeof port.withSequencingToken !== 'function') {
        throw this.fail(
          'DFR_UNSUPPORTED_CAPABILITY',
          requestId,
          request.chain,
          '本链缺少排序前提注入方法，无法保证租约与载荷一致',
          { capability: 'transaction.build', reason: 'method_missing' },
        );
      }
      const reserved = await this.stores.sequencing.reserve({
        chain: request.chain,
        account: request.from,
        transactionId,
        token: pendingToken,
        leaseTtlMs,
      });
      sequencingToken = reserved.lease.token;
      reservedKind = reserved.kind;
      // 注入 Store 已落租约的**同一个**前提，保证"租约 ↔ 载荷"一致（ADR-033）。
      adapterRequest = port.withSequencingToken(request, sequencingToken);
    }

    let unsigned: UnsignedTransaction;
    try {
      unsigned = await port.build({ request: adapterRequest, requestId, ...trace, signal });
    } catch (err) {
      // 未签名、未广播的租约必须释放，否则会留下永久空洞（m1-storage-model §3.4）。
      // 释放失败不得掩盖原始错误：调用方需要看到的是 build 为什么失败。
      // 携带 transactionId（ADR-030 的所有权证明）：该 nonce 可能已被回收并绑定到新交易，
      // 没有它会误释放别人的租约。
      if (reservedKind === 'reserved') {
        await this.releaseQuietly(
          request.chain,
          request.from,
          transactionId,
          nonce,
          sequencingToken,
        );
      }
      throw err;
    }

    const built = transition({ from: null, event: 'build' });
    if (!built.ok) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        request.chain,
        'build 边不存在（状态机与规范不一致）',
      );
    }
    const now = this.now();
    const created = await this.stores.transaction.create({
      record: {
        transactionId,
        projectId,
        chain: request.chain,
        requestFingerprint: fingerprint,
        status: built.status,
        stateVersion: '0' as DecimalUint,
        from: request.from,
        ...(request.to !== undefined ? { to: request.to } : {}),
        ...(nonce !== undefined ? { nonce } : {}),
        ...(sequencingToken !== undefined ? { sequencingRef: sequencingToken } : {}),
        unsignedPayload: unsigned.payload,
        payloadEncoding: unsigned.meta.encoding ?? 'hex',
        createdAt: now,
        updatedAt: now,
      },
      ...(scope !== undefined && ownerToken !== undefined
        ? { idempotencyClaim: { scope, ownerToken } }
        : {}),
    });
    if (created.kind === 'already_exists') {
      // 新生成的 transactionId 撞上既有记录，只可能是 ID 生成器坏了。
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        request.chain,
        `transactionId ${transactionId} 已存在`,
      );
    }

    let replayable = scope !== undefined;
    if (scope !== undefined && ownerToken !== undefined) {
      const completed = await this.stores.idempotency.complete({
        scope,
        ownerToken,
        statusCode: 201,
        transactionId,
        responseBody: {
          transactionId,
          ...(nonce !== undefined ? { nonce } : {}),
        },
      });
      // 失去写入权说明有并发执行者接管：本次结果仍然真实（记录已落库），
      // 但不能保证被重放，按 gateway-spec 第 7.2 节显式标记为不可重放。
      if (completed.kind !== 'completed') replayable = false;
    }

    return {
      transactionId,
      status: created.record.status,
      ...(nonce !== undefined ? { nonce } : {}),
      ...(sequencingToken !== undefined ? { sequencingToken } : {}),
      unsignedTransaction: unsigned,
      replayed: false,
      replayable,
    };
  }

  /** 有界同步等待；超时后启动不依赖 HTTP AbortSignal 的后台只读确认循环。 */
  async confirm(input: ConfirmTransactionInput): Promise<ConfirmationResult> {
    return this.measure(input.chain, 'confirm', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.confirmInternal(input),
      ),
    );
  }

  private async confirmInternal(input: ConfirmTransactionInput): Promise<ConfirmationResult> {
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const timeoutMs = input.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
      throw this.fail('DFR_VALIDATION_FAILED', requestId, input.chain, 'timeoutMs 必须在 1000..600000 之间');
    }
    if (this.confirmationTracker === undefined) {
      throw this.fail('DFR_UNSUPPORTED_CAPABILITY', requestId, input.chain, '未装配确认观测端口或 tracker lease store');
    }
    const signal = input.signal ?? new AbortController().signal;
    const tracked: ConfirmationTrackResult = await this.confirmationTracker.trackUntil({
      chain: input.chain,
      txHash: input.txHash,
      ...(input.minFinality !== undefined ? { required: input.minFinality } : {}),
    requestId,
    ...trace,
    timeoutMs,
      signal,
    });
    const confirmation = tracked.owner && tracked.confirmation !== undefined
      ? tracked.confirmation
      : {
          ref: { kind: 'hash' as const, hash: input.txHash },
          status: 'pending' as const,
          finality: 'unknown' as const,
          ...(input.minFinality !== undefined ? { requiredFinality: input.minFinality } : {}),
          reached: false,
        };
    if (!confirmation.reached && !signal.aborted) {
      this.confirmationTracker.continueInBackground({
        chain: input.chain,
        txHash: input.txHash,
        ...(input.minFinality !== undefined ? { required: input.minFinality } : {}),
      });
    }
    return confirmation;
  }

  /** Gateway graceful shutdown hook for process-local background loops. */
  close(): void {
    this.confirmationTracker?.stopBackground();
  }

  /* ---------------------------- broadcast ---------------------------- */

  /**
   * 广播一笔已模拟的交易（DFR-M1-C03a，**只做可判定路径**）。
   *
   * 顺序（与 transaction-lifecycle §4.4 对齐）：
   *
   * ```text
   * 取记录 ─► 状态检查（必须 simulated）─► 客户端回声 vs 记录载荷 ─► 端口存在性
   *        ─► 记录 sign 转移（signed，只写 expectedHash）─► 单次广播
   *             ├─ accepted ─► broadcast.accepted 转移（写 txHash）─► 返回
   *             └─ 其它 ─────► 状态**停在 signed**，原样上抛
   * ```
   *
   * 三个刻意的选择：
   *
   * 1. **失败不改状态**：`signed` 是"可能已发出"的唯一诚实落点。
   *    超时既不能当成功也不能当失败（`unknown` 的边尚未定义，见 ADR-019 / C03b），
   *    因此本方法绝不写 `failed` / `unknown`，只把原始错误上抛。
   * 2. **不重试**：广播的 `non-idempotent-write` 由 Adapter 声明、Provider 层拒绝重试；
   *    引擎这里也不加任何循环，否则会绕过那两道保护。
   * 3. **落库只写公开字段**：`expectedHash` 与 `txHash` 都是哈希，不是签名原文；
   *    `signedPayload` 永远不进入记录。
   */
  async broadcast(input: BroadcastTransactionInput): Promise<BroadcastTransactionResult> {
    return this.measure(input.signed.chain, 'broadcast', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.broadcastInternal(input),
      ),
    );
  }

  private async broadcastInternal(input: BroadcastTransactionInput): Promise<BroadcastTransactionResult> {
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const signal = input.signal ?? new AbortController().signal;
    const { signed } = input;

    const record = await this.stores.transaction.get(input.transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_TRANSACTION_NOT_FOUND',
        requestId,
        signed.chain,
        `未知交易 ${input.transactionId}`,
        { transactionId: input.transactionId },
      );
    }
    this.assertCallerTransactionScope(record, input, requestId);
    if (record.chain !== signed.chain) {
      throw this.fail(
        'DFR_CHAIN_MISMATCH',
        requestId,
        signed.chain,
        `签名载荷 chain ${signed.chain} 与记录 ${record.chain} 不一致`,
        { fields: ['chain'] },
      );
    }

    // 重播（TODO-012）与首次广播是两条不同的状态路径：
    //   首次：simulated --sign--> signed --broadcast.accepted--> broadcast
    //   重播：dropped --rebroadcast--> broadcast（须显式 rebroadcast: true）
    // 状态机禁止 `dropped → broadcast` 之外的隐式二次广播，因此这里必须显式分流，
    // 否则 `dropped` 记录会在 `assertBroadcastable` 被拒（这正是预复审发现的问题）。
    const rebroadcast = input.options?.rebroadcast === true;
    if (rebroadcast) {
      if (record.status !== 'dropped') {
        throw this.fail(
          'DFR_TRANSACTION_REJECTED',
          requestId,
          record.chain,
          `只有 dropped 状态的交易可以重播（当前 ${record.status}）`,
          { reason: 'rebroadcast_not_allowed', fields: ['rebroadcast'], status: record.status },
        );
      }
      // 重播必须使用记录里**已签名**的那笔交易：expectedHash 是记录真值，
      // 不接受客户端换一个哈希来"重播另一笔"。
      if (record.expectedHash === undefined || record.expectedHash !== signed.expectedHash) {
        throw this.fail(
          'DFR_TRANSACTION_REJECTED',
          requestId,
          record.chain,
          '重播的 expectedHash 与记录不一致，拒绝广播',
          { reason: 'expected_hash_mismatch', fields: ['signedTransaction.expectedHash'] },
        );
      }
    } else {
      this.assertBroadcastable(record, requestId);
    }

    // 客户端回传的 unsigned 只是回声，真值是记录；不一致说明客户端改了参数。
    if (record.unsignedPayload !== signed.unsigned.payload) {
      throw this.fail(
        'DFR_TRANSACTION_REJECTED',
        requestId,
        record.chain,
        '签名请求携带的 unsigned 载荷与记录不一致，拒绝广播',
        { reason: 'unsigned_payload_mismatch', fields: ['unsignedTransaction.payload'] },
      );
    }

    if (typeof this.deps.chain.broadcast !== 'function') {
      // fail-closed：宁可拒绝，也不静默跳过绑定校验直接广播。
      throw this.fail(
        'DFR_UNSUPPORTED_CAPABILITY',
        requestId,
        record.chain,
        '当前部署未装配广播实现',
        { capability: 'transaction.broadcast' },
      );
    }

    // 先落 signed（不含签名原文，只写 expectedHash），再广播：
    // 广播是不可逆动作，必须让"已签名"这一事实先可查。
    const signStarted = performance.now();
    const signedRecord = rebroadcast
      ? await this.applyTransition(
          record,
          'rebroadcast',
          requestId,
          { expectedHash: signed.expectedHash },
          { rebroadcast: true },
        )
      : await this.applyTransition(record, 'sign', requestId, {
          expectedHash: signed.expectedHash,
        });
    // 这里测量的是"签名落库"这一次状态转移的耗时（DB 写入 + CAS），
    // 不是客户端签名本身耗时——签名发生在 DFR 之外。
    this.deps.metrics?.recordStage({
      chain: record.chain,
      stage: 'sign',
      status: 'success',
      durationSeconds: Math.max(0, (performance.now() - signStarted) / 1000),
    });

    // B45 / ADR-032: a Solana blockhash is *consumed* once a signed
    // transaction has been durably recorded, not after the RPC accepts it.
    // Otherwise a TTL orphan sweep can expire a still-reserved lease during
    // network submission (or a crash), erasing that signed transaction's
    // sequencing ownership. Fail closed before any external broadcast.
    if (signedRecord.sequencingRef?.kind === 'blockhash') {
      if (this.stores.sequencing === undefined) {
        throw this.fail(
          'DFR_CONFIGURATION_ERROR', requestId, record.chain,
          '已签名的 blockhash 交易缺少 SequencingStore，拒绝广播',
          { capability: 'transaction.broadcast' },
        );
      }
      const consumed = await this.stores.sequencing.markConsumed({
        chain: signedRecord.chain,
        account: signedRecord.from,
        transactionId: signedRecord.transactionId,
        tokenValue: signedRecord.sequencingRef.value,
      });
      if (consumed.kind !== 'updated' || consumed.lease.status !== 'consumed') {
        throw this.fail(
          'DFR_TRANSACTION_REJECTED', requestId, record.chain,
          '已签名交易的排序租约不存在或已失效，拒绝广播',
          { reason: 'sequencing_lease_inactive' },
        );
      }
    }

    const expected = {
      from: record.from,
      unsignedPayload: record.unsignedPayload as string,
    };
    let broadcast: BroadcastResult;
    try {
      // B43: the signing client can take longer than a blockhash's validity
      // window. Check the durable Store sequencing token (not the client echo)
      // immediately before the non-idempotent network send. EVM nonce is
      // deliberately excluded: it has no block-height expiration semantics.
      if (signedRecord.sequencingRef?.kind === 'blockhash') {
        if (typeof this.deps.chain.isSequencingExpired !== 'function') {
          throw this.fail(
            'DFR_UNSUPPORTED_CAPABILITY', requestId, record.chain,
            '签名广播未配置 Solana blockhash 有效性链高检查，拒绝发送',
            { capability: 'transaction.broadcast', reason: 'blockhash_expiry_missing' },
          );
        }
        const expired = await this.deps.chain.isSequencingExpired({
          chain: record.chain,
          token: signedRecord.sequencingRef,
          requestId,
          ...trace,
          signal,
        });
        if (expired) {
          throw this.fail(
            'DFR_BLOCKHASH_EXPIRED', requestId, record.chain,
            'Solana 已签名交易使用的 blockhash 已过期，必须重新 build 并外部签名',
            { reason: 'blockhash_expired_before_broadcast' },
          );
        }
      }
      broadcast = await this.deps.chain.broadcast({
        signed,
        expected,
        ...(input.options !== undefined ? { options: input.options } : {}),
        requestId,
        ...trace,
        signal,
      });
    } catch (err) {
      if (rebroadcast) {
        // TX-04: after dropped→broadcast, an RPC error is not proof the
        // retransmission was rejected: the *original* signed tx may already
        // be mined and the new send may have reached the peer. Mark unknown
        // for read-only recovery; never auto-retry, release nonce or mark failed.
        // Isolate any storage/observation error so the original network
        // exception remains visible to the caller.
        try {
          const unknown = await this.applyTransition(
            signedRecord, 'rebroadcast.indeterminate', requestId,
          );
          await this.tryResolveUnknown(unknown, requestId, signal, trace);
        } catch {
          // A concurrent observer may already have advanced the record. CAS
          // prevents overwriting it. A failed DB write is not an accepted send.
        }
        throw err;
      }
      // 广播失败必须分类，不能一律停在 signed：ADR-019 要求
      //   可证明不可自愈的拒绝 → failed（终态）
      //   其余（超时/不可用/熔断/nonce 冲突/不可分类）→ unknown → 按观测解析
      try {
        await this.handleBroadcastFailure(signedRecord, err, requestId, signal, trace);
      } catch {
        // TX-02: do not replace the transport error with a secondary Store/
        // observation failure. The durable signed record and expectedHash
        // are picked up by restart recovery. Never replay the payload here.
      }
      throw err;
    }

    const txHash = broadcast.ref.kind === 'hash' ? broadcast.ref.hash : null;
    // 首次广播：signed → broadcast（顺带写入 txHash）。
    // 重播：`rebroadcast` 边**已经**把状态落到 `broadcast`，再走 `broadcast.accepted`
    // 会是 `broadcast → broadcast`（无此边）。txHash 在首次广播时已落库，无需重写。
    const advanced = rebroadcast
      ? signedRecord
      : await this.applyTransition(
          signedRecord,
          'broadcast.accepted',
          requestId,
          txHash !== null ? { txHash } : undefined,
        );

    const result: BroadcastTransactionResult = {
      transactionId: advanced.transactionId,
      status: advanced.status,
      txHash: txHash ?? signed.expectedHash,
      accepted: broadcast.accepted,
      observedAt: broadcast.observedAt,
    };
    // 是否重播由**引擎**判定（它知道本次请求是否要求重播），
    // 而不是依赖 Adapter 在结果里回显 —— 任何 Adapter 忘记回显都会破坏契约。
    // 保留对 Adapter 回显的兼容判断，但引擎的判断优先。
    return rebroadcast || broadcast.rebroadcast === true
      ? { ...result, rebroadcast: true }
      : result;
  }

  /**
   * 广播失败后的状态归属（ADR-019）。
   *
   * 本方法**不抛错**：原始错误必须原样上抛给调用方（唯一错误构造点），
   * 这里只负责把状态写到诚实的落点。任何内部失败（观测不可用、Store 冲突）
   * 都不得吞掉原始错误，也不得把交易推成终态。
   */
  private async handleBroadcastFailure(
    signedRecord: TransactionRecord,
    error: unknown,
    requestId: RequestId,
    signal: AbortSignal,
    trace: { traceId?: string; spanId?: string } = {},
  ): Promise<void> {
    // TX-02: only a signed Solana transaction with an on-record blockhash
    // sequencing token may rely on the adapter's DFR_BLOCKHASH_EXPIRED proof.
    // A generic EVM/provider rejection (even one mislabelled with that code)
    // is NOT network-wide evidence of non-propagation, so stay unknown.
    if (classifyBroadcastFailure(error) === 'rejected' && signedRecord.sequencingRef?.kind === 'blockhash') {
      await this.applyTransition(signedRecord, 'broadcast.rejected', requestId, {
        errorCode: isDfrError(error) ? error.code : 'DFR_INTERNAL_ERROR',
      });
      return;
    }

    // 不确定：先落 unknown（唯一入边），再尝试用一次链上观测解析。
    const unknown = await this.applyTransition(
      signedRecord,
      'broadcast.indeterminate',
      requestId,
    );
    await this.tryResolveUnknown(unknown, requestId, signal, trace);
  }

  /**
   * 用一次链上观测解析 `unknown`（ADR-019 第 4 节）。
   *
   * 解析不出结论、观测不可用、或部署未装配 `observe` 时**保持 `unknown`**：
   * "此刻查不到"不等于"已丢弃"（mempool 传播异步），`dropped` 留给 M1-D03 的
   * `dropTimeoutMs` 窗口判定。
   */
  private async tryResolveUnknown(
    unknown: TransactionRecord,
    requestId: RequestId,
    signal: AbortSignal,
    trace: { traceId?: string; spanId?: string } = {},
    /**
     * 是否允许把"观测为 `absent` 且已超时"判为 `dropped`（ADR-023）。
     *
     * **只有恢复/巡检的再次观测**才置 true。同一次广播请求内的观测必须保持保守
     * （ADR-019 第 142 行："同请求内的 absent 观测不解析为 dropped"，因为 mempool
     * 传播是异步的，此刻查不到可能只是还没传开）。
     */
    allowDropTimeout = false,
  ): Promise<TransactionRecord | null> {
    // 只对 unknown / dropped 生效（ADR-023）：其它状态由调用方在此之前过滤。
    if (unknown.status !== 'unknown' && unknown.status !== 'dropped') return null;
    if (typeof this.deps.chain.observe !== 'function' || unknown.nonce === undefined) {
      return null;
    }

    let observation: ChainBroadcastObservation;
    try {
      // 必须通过 this.deps.chain.observe(...) 调用：把方法取出再调用会丢接收者，
      // 端口实现里的 this（观测记录、连接句柄）会变成 undefined。
      observation = await this.deps.chain.observe({
        chain: unknown.chain,
        txHash: unknown.expectedHash ?? '',
        from: unknown.from,
        nonce: unknown.nonce,
        requestId,
        ...trace,
        signal,
      });
    } catch {
      // 观测故障不得改变分类（仍是 unknown），也不得覆盖原始广播错误。
      return null;
    }

    const event = resolveUnknownOutcome(observation);
    if (event === null) {
      // `absent`（或无法归类）：**只有在 unknown 且已跨过 dropTimeoutMs 时**才判 dropped。
      // ADR-023 的两个条件缺一不可——只凭一次"查不到"判丢弃会让调用方误以为可以重播。
      if (
        allowDropTimeout &&
        observation.kind === 'absent' &&
        unknown.status === 'unknown' &&
        this.dropTimeoutExceeded(unknown)
      ) {
        return await this.applyTransition(unknown, 'dropped', requestId);
      }
      return null;
    }

    const patch =
      observation.kind === 'included' && observation.txHash !== undefined
        ? {
            txHash: observation.txHash,
            ...(observation.blockRef !== undefined ? { blockRef: observation.blockRef } : {}),
            ...(observation.canonicalBlockHash !== undefined
              ? { canonicalBlockHash: observation.canonicalBlockHash }
              : {}),
          }
        : undefined;
    return await this.applyTransition(unknown, event, requestId, patch);
  }

  /**
   * 显式解析一个 `unknown` 或 `dropped` 交易（M1-D03 恢复扫描与运维排查用）。
   *
   * - `unknown`：观测 → 按观测落点推进；观测为 `absent` 且已超过 `dropTimeoutMs`
   *   才转 `dropped`（ADR-023）；
   * - `dropped`：只做**收敛纠正**（included / pending / replaced），观测为 `absent`
   *   时保持原状——`dropped` 是判断而非事实，缺这条会永久误报。
   *
   * 幂等：其它状态直接返回当前记录，不报错也不推进。
   */
  async resolveIndeterminate(input: {
    readonly transactionId: TransactionId;
    readonly requestId?: RequestId;
    readonly signal?: AbortSignal;
  }): Promise<TransactionRecord | null> {
    const requestId = input.requestId ?? newRequestId();
    const signal = input.signal ?? new AbortController().signal;
    const record = await this.stores.transaction.get(input.transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_TRANSACTION_NOT_FOUND',
        requestId,
        undefined,
        `未知交易 ${input.transactionId}`,
        { transactionId: input.transactionId },
      );
    }
    // unknown：观测 + 超时判定；dropped：只做收敛纠正（ADR-023）。
    // 这里是"再次观测"，因此允许超时判定为 dropped。
    if (record.status !== 'unknown' && record.status !== 'dropped') return record;
    const resolved = await this.tryResolveUnknown(record, requestId, signal, {}, true);
    return resolved ?? record;
  }

  /**
   * 静默时长是否已超过 `dropTimeoutMs`（ADR-023）。
   *
   * 以 `updatedAt` 为起点：`transition()` 在进入 `unknown` 时写入它，因此它标记
   * "进入 unknown 的时刻"。落库时钟与进程时钟可能略有偏差（Postgres 用
   * `clock_timestamp()`），对 30 分钟量级的判定不构成影响。
   */
  private dropTimeoutExceeded(record: TransactionRecord): boolean {
    const timeout = this.deps.dropTimeoutMs ?? DEFAULT_DROP_TIMEOUT_MS;
    const since = Date.parse(record.updatedAt);
    if (!Number.isFinite(since)) return false;
    const now = this.deps.dropClock?.() ?? Date.now();
    return now - since >= timeout;
  }

  /** 只有 `simulated` 允许进入广播；失败原因用稳定 reason 区分（不泄漏内部状态机词汇）。 */
  private assertBroadcastable(record: TransactionRecord, requestId: RequestId): void {
    if (record.status === 'simulated') return;
    const reason =
      record.status === 'built'
        ? 'simulation_required'
        : record.status === 'reverted'
          ? 'simulation_failed'
          : 'invalid_status';
    throw this.fail(
      'DFR_TRANSACTION_REJECTED',
      requestId,
      record.chain,
      `交易当前状态 ${record.status} 不允许广播`,
      { reason, fields: ['status'], status: record.status },
    );
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * 模拟一笔已 build 的交易（DFR-M1-B05）。
   *
   * 顺序（每一步失败都不得推进状态）：
   *
   * ```text
   * 取记录 ─► 绑定校验（chain / payload / nonce） ─► 状态校验（built | simulated）
   *        ─► 只读模拟
   *             ├─ success ─► built 转 simulated / simulated 只更新观测
   *             └─ failure ─► 转 reverted（终态，广播不可达）→ 抛 DFR_TRANSACTION_REVERTED
   * ```
   *
   * 两个刻意的选择：
   * - **失败抛错而不是返回结果**：链上回滚的错误构造点只有一个（gateway-spec 第 8 节
   *   "错误只在其归属层构造一次"）。HTTP 层只做状态码映射（422），不需要重新分类；
   * - **失败先落库再抛错**：状态必须先写成 `reverted` 才能保证"广播被封锁"这一安全属性，
   *   即使调用方忽略错误也不会留下可广播的交易。
   */
  async simulate(input: SimulateTransactionInput & ScopedTransactionRequest): Promise<SimulatedTransactionResult> {
    return this.measure(input.unsignedTransaction.chain, 'simulate', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.simulateInternal(input),
      ),
    );
  }

  private async simulateInternal(input: SimulateTransactionInput & ScopedTransactionRequest): Promise<SimulatedTransactionResult> {
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const signal = input.signal ?? new AbortController().signal;
    const record = await this.stores.transaction.get(input.transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_TRANSACTION_NOT_FOUND',
        requestId,
        input.unsignedTransaction.chain,
        `未知交易 ${input.transactionId}`,
        { transactionId: input.transactionId },
      );
    }

    this.assertCallerTransactionScope(record, input, requestId);
    this.assertSimulationBinding(record, input.unsignedTransaction, requestId);

    if (!SIMULATABLE_STATUSES.includes(record.status)) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        record.chain,
        `交易当前状态 ${record.status} 不允许模拟（只允许 ${SIMULATABLE_STATUSES.join(' / ')}）`,
        { fields: ['status'], status: record.status, allowed: [...SIMULATABLE_STATUSES] },
      );
    }

    const simulation = await this.deps.chain.simulate({
      transactionId: record.transactionId,
      unsigned: input.unsignedTransaction,
      from: record.from,
      requestId,
      ...trace,
      signal,
    });

    if (simulation.success) {
      if (record.status === 'simulated') {
        // 重复调用：结果作为新观测返回，不推进状态（m1-api-contract 第 2 节）。
        return { transactionId: record.transactionId, status: 'simulated', simulation };
      }
      const applied = await this.applyTransition(record, 'simulate.succeeded', requestId);
      return { transactionId: applied.transactionId, status: applied.status, simulation };
    }

    // 模拟失败：必须先落库为终态 reverted，再抛错。
    // 状态选择（不改状态机，只复用既有边）：
    //   built → simulate.failed（规范第 3.1 节明确定义的边）
    //   simulated → execution.failed（表内 `*` 行，唯一从 simulated 到 reverted 的边）
    const event: TransactionEvent = record.status === 'built' ? 'simulate.failed' : 'execution.failed';
    const reverted = await this.applyTransition(record, event, requestId, {
      errorCode: 'DFR_TRANSACTION_REVERTED',
    });

    // TX-01: a failed simulation is terminal and has never been signed or sent.
    // Release only unsigned EVM nonce leases, with ownership checked in the Store.
    // An unexpected Store failure must not mask the original simulation revert.
    if (reverted.nonce !== undefined && reverted.expectedHash === undefined && reverted.txHash === undefined) {
      try {
        await this.stores.nonce.releaseIfSafe({
          chain: reverted.chain,
          account: reverted.from,
          nonce: reverted.nonce,
          transactionId: reverted.transactionId,
        });
      } catch {
        // Safe retry/reconciliation is required if the lease release fails.
      }
    }

    const revertReason = simulation.revertReason ?? '模拟未通过，但节点未返回原因';
    throw createDfrError('DFR_TRANSACTION_REVERTED', {
      requestId,
      chain: record.chain,
      message: '模拟失败：交易执行回滚，已阻止广播',
      details: {
        transactionId: record.transactionId,
        revertReason,
        ...(simulation.estimatedCost !== undefined
          ? { estimatedCost: simulation.estimatedCost }
          : {}),
      },
    });
  }

  /* ---------------------------- 内部辅助 ---------------------------- */

  /**
   * A transactionId identifies persisted state but grants no authorization.
   * Enforce the authenticated project/chain before any RPC or state update.
   */
  private assertCallerTransactionScope(
    record: TransactionRecord,
    input: ScopedTransactionRequest,
    requestId: RequestId,
  ): void {
    if (
      (input.requesterProjectId !== undefined && record.projectId !== input.requesterProjectId) ||
      (input.authorizedChains !== undefined && input.authorizedChains !== '*' &&
       !input.authorizedChains.includes(record.chain))
    ) {
      throw this.fail('DFR_PROJECT_SCOPE_DENIED', requestId, undefined, '无权访问该交易');
    }
  }

  /**
   * 绑定校验：simulate 的载荷必须就是 build 落库的那一份。
   *
   * 三处逐一比较：chain、payload 字节、以及载荷声明的 nonce 与租约 nonce。
   * 任何不一致都 fail-closed，且**在调用链之前**完成——不给"用别人的载荷试探"
   * 留下任何 RPC 观测面。
   */
  private assertSimulationBinding(
    record: TransactionRecord,
    unsigned: UnsignedTransaction,
    requestId: RequestId,
  ): void {
    if (unsigned.chain !== record.chain) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        record.chain,
        `载荷 chain ${unsigned.chain} 与记录 ${record.chain} 不一致`,
        { fields: ['unsignedTransaction.chain'] },
      );
    }
    if (record.unsignedPayload === undefined) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        record.chain,
        `交易 ${record.transactionId} 没有落库未签名载荷，无法校验绑定`,
      );
    }
    if (unsigned.payload !== record.unsignedPayload) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        record.chain,
        '载荷与 build 结果不一致：只接受 build 返回的 unsigned payload',
        { fields: ['unsignedTransaction.payload'] },
      );
    }
    if (record.nonce !== undefined && unsigned.meta.requiresNonce !== record.nonce) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        record.chain,
        '载荷声明的 nonce 与已分配租约不一致',
        { fields: ['unsignedTransaction.meta.requiresNonce'] },
      );
    }
  }

  /**
   * 带 CAS 的状态迁移：冲突时重读记录并重新推导目标状态。
   *
   * 不允许 last-write-wins（development-plan 第 4.2 节）：每次写入都带上
   * 读到的 `expectedStatus` + `expectedVersion`，Store 用它们做条件。
   */
  private async applyTransition(
    record: TransactionRecord,
    event: TransactionEvent,
    requestId: RequestId,
    patch?: TransitionPatch,
    /**
     * 状态机的额外输入。目前只有 `rebroadcast`：
     * `dropped → broadcast` 这条边要求显式 `rebroadcast: true`，
     * 否则 `transition()` 会以 `REBROADCAST_FLAG_REQUIRED` 拒绝。
     */
    transitionOptions?: { readonly rebroadcast?: boolean },
  ): Promise<TransactionRecord> {
    let current = record;
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt += 1) {
      const moved = transition({
        from: current.status,
        event,
        ...(transitionOptions?.rebroadcast !== undefined
          ? { rebroadcast: transitionOptions.rebroadcast }
          : {}),
      });
      if (!moved.ok) {
        // 可达路径只有"并发执行者把状态改了"；按调用方可见的冲突处理，不报 500。
        throw this.fail(
          'DFR_VALIDATION_FAILED',
          requestId,
          current.chain,
          `交易状态 ${current.status} 不接受事件 ${event}（${moved.reason}）`,
          { fields: ['status'], status: current.status, transitionReason: moved.reason },
        );
      }

      const result = await this.stores.transaction.transition({
        transactionId: current.transactionId,
        expectedStatus: current.status,
        expectedVersion: current.stateVersion,
        toStatus: moved.status,
        reason: event,
        requestId,
        ...(patch !== undefined ? { patch } : {}),
      });
      if (result.kind === 'applied') {
        // 事务提交成功后才发布：订阅者看到的都是已持久化的事实。
        // 汇点抛错被吞掉——事件投递失败不得改变业务结果。
        try {
          this.deps.onTransition?.({
            transactionId: result.record.transactionId,
            chain: result.record.chain,
            fromStatus: current.status,
            toStatus: result.record.status,
            stateVersion: result.record.stateVersion,
            requestId,
            ...(result.record.txHash !== undefined ? { txHash: result.record.txHash } : {}),
          });
        } catch {
          // 事件投递是尽力而为：汇点异常绝不能改变"状态已迁移"这一业务结果。
        }
        return result.record;
      }
      if (result.kind === 'not_found') {
        throw this.fail(
          'DFR_INTERNAL_ERROR',
          requestId,
          current.chain,
          `迁移时交易 ${current.transactionId} 已不存在`,
        );
      }
      // version_conflict / status_conflict：以 Store 返回的最新记录重来。
      current = result.current;
    }
    throw this.fail(
      'DFR_INTERNAL_ERROR',
      requestId,
      record.chain,
      `状态迁移连续 ${MAX_TRANSITION_ATTEMPTS} 次冲突，未能写入`,
      { transactionId: record.transactionId },
    );
  }

  private async measure<T>(chain: ChainId, stage: TransactionStage, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let status: 'success' | 'error' | 'timeout' | 'pending' = 'success';
    let errorCode: string | undefined;
    try {
      const result = await operation();
      if (stage === 'confirm') {
        const confirmation = result as ConfirmationResult;
        if (!confirmation.reached) status = 'pending';
        else if (confirmation.requiredFinality !== undefined) {
          const durationSeconds = Math.max(0, (performance.now() - started) / 1000);
          this.deps.metrics?.recordFinality({ chain, level: confirmation.requiredFinality, durationSeconds });
          if (confirmation.requiredFinality === 'finalized') {
            this.deps.metrics?.recordStage({ chain, stage: 'finalize', status: 'success', durationSeconds });
          }
        }
      }
      return result;
    } catch (error) {
      errorCode = isDfrError(error) ? error.code : 'DFR_INTERNAL_ERROR';
      status = errorCode === 'DFR_PROVIDER_TIMEOUT' ? 'timeout' : 'error';
      throw error;
    } finally {
    this.deps.metrics?.recordStage({
        chain,
        stage,
        status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        durationSeconds: Math.max(0, (performance.now() - started) / 1000),
      });
    }
  }

  /** 命中幂等记录：用落库记录重建结果，不重新执行、不消耗新 nonce。 */
  private async replay(
    transactionId: TransactionId | undefined,
    requestId: RequestId,
    chain: ChainId,
  ): Promise<BuiltTransactionResult> {
    if (transactionId === undefined) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        chain,
        '幂等记录标记为已完成但缺少 transactionId',
      );
    }
    const record = await this.stores.transaction.get(transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        chain,
        `幂等记录引用的交易 ${transactionId} 不存在`,
      );
    }
    // 重放需要记录里有排序前提（EVM=nonce，Solana=blockhash）与未签名载荷。
    const sequencingToken = record.sequencingRef ?? (record.nonce !== undefined
      ? { kind: 'nonce' as const, value: record.nonce }
      : undefined);
    if (sequencingToken === undefined || record.unsignedPayload === undefined) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        chain,
        `交易 ${transactionId} 缺少排序前提或未签名载荷，无法重放 build`,
      );
    }
    return {
      transactionId: record.transactionId,
      status: record.status,
      ...(record.nonce !== undefined ? { nonce: record.nonce } : {}),
      sequencingToken,
      unsignedTransaction: {
        schemaVersion: '1',
        chain: record.chain,
        payload: record.unsignedPayload,
        meta: {
          encoding: record.payloadEncoding ?? 'hex',
          ...(record.nonce !== undefined ? { requiresNonce: record.nonce } : {}),
          ...(sequencingToken.kind === 'blockhash'
            ? { recentBlockhash: sequencingToken.value }
            : {}),
        },
      },
      replayed: true,
      replayable: true,
    };
  }

  /**
   * 释放未签名 nonce 租约（补偿动作）。
   *
   * 三种失败都必须吞掉：`not_found`（租约已过期被清理）、`forbidden`
   * （同 nonce 已签名/广播，**绝不能**释放）以及 Store 自身异常。释放是补偿，
   * 不能改变"这次 build 失败了"这个事实。
   */
  private async releaseQuietly(
    chain: ChainId,
    account: AccountRef,
    transactionId: TransactionId,
    nonce: DecimalUint | undefined,
    sequencingToken: SequencingToken | undefined,
  ): Promise<void> {
    try {
      if (nonce !== undefined) {
        // transactionId 是 ADR-030 的所有权证明：nonce 空洞可被回收复用，
        // 没有它，迟到的释放可能落在别人的新租约上。
        await this.stores.nonce.releaseIfSafe({ chain, account, nonce, transactionId });
        return;
      }
      if (sequencingToken !== undefined && this.stores.sequencing !== undefined) {
        await this.stores.sequencing.releaseIfSafe({
          chain,
          account,
          transactionId,
          tokenValue: sequencingToken.value,
        });
      }
    } catch {
      // 故意忽略：见方法注释。
    }
  }

  private now(): Iso8601 {
    return this.deps.now?.() ?? (new Date().toISOString() as Iso8601);
  }

  private newTransactionId(): TransactionId {
    return (
      this.deps.newTransactionId?.() ?? (`txn_${randomBytes(16).toString('hex')}` as TransactionId)
    );
  }

  private newOwnerToken(): string {
    return this.deps.newOwnerToken?.() ?? randomBytes(16).toString('hex');
  }

  private fail(
    code: Parameters<typeof createDfrError>[0],
    requestId: RequestId,
    /** 记录不存在时无法得知链，此时省略 */
    chain: ChainId | undefined,
    message: string,
    details?: Record<string, unknown>,
  ): Error {
    return createDfrError(code, {
      requestId,
      ...(chain !== undefined ? { chain } : {}),
      message,
      ...(details !== undefined ? { details } : {}),
    });
  }
}
