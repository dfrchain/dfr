/**
 * DFR Core（M0：Query Engine + Capability Router）。
 *
 * 职责：
 * - 把 Chain Registry、Adapter、Provider Manager 装配在一起；
 * - 在调用 Adapter 之前做 Capability 路由（未声明 → DFR_UNSUPPORTED_CAPABILITY）；
 * - 启动时对启用的链执行 `registry ⊆ adapter` 校验（fail-closed）；
 * - 保持 Core 不含任何链特定分支（链特定逻辑只在 Adapter）。
 */
import {
  ERROR_METADATA,
  createDfrError,
  isDfrError,
  isKnownErrorCode,
  newRequestId,
  toDfrError,
  type ErrorMetadata,
} from '@dfr/errors';
import {
  ProviderManager,
  type ProviderCallRecord,
  type ProviderObservabilitySnapshot,
} from '@dfr/provider';
import { projectChain, type ChainRegistry } from '@dfr/registry';
import { evaluateFinality } from '@dfr/transaction';
import type {
  AccountRef,
  AdapterContext,
  AssetRef,
  Balance,
  BalanceCapability,
  Block,
  BroadcastCapability,
  BroadcastObservation,
  BroadcastObservationReadMethod,
  BroadcastObservationRequest,
  ChainConfirmationObservation,
  ConfirmationObservationReadMethod,
  ConfirmationResult,
  BroadcastOptions,
  BroadcastResult,
  BuildCapability,
  BlockCapability,
  BlockRef,
  CapabilityId,
  Chain,
  ChainAdapter,
  ChainId,
  ChainInfo,
  ConsistencyHint,
  ContractLogsCapability,
  ContractLogsRequest,
  ContractReadCapability,
  ContractReadRequest,
  ContractReadResult,
  Account,
  AccountCodeCapability,
  ChainLog,
  DecimalUint,
  FinalityLevel,
  FinalityPolicy,
  Milestone,
  PendingNonceReadMethod,
  ProviderQuotaStore,
  SequencingTokenReadMethod,
  Receipt,
  RequestId,
  SequencingToken,
  SequencingTokenExpiryMethod,
  EnsureSequencingTokenMethod,
  SignedTransaction,
  SimulationCapability,
  SimulationOptions,
  SimulationResult,
  Transaction,
  TransactionQueryCapability,
  TransactionRef,
  TransactionRequest,
  UnsignedTransaction,
} from '@dfr/types';
import {
  InMemoryTransactionObservationStore,
  type TransactionObservationStore,
} from './stores.js';
import type {
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLeaseStore,
  TransactionStore,
} from '@dfr/transaction';

/** Adapter 注册项：Core 通过它为该链创建 Adapter 实例。 */
export interface AdapterRegistration {
  id: string;
  /** semver 实现版本。 */
  version: string;
  create(chain: Chain): ChainAdapter;
}

export interface DfrCoreOptions {
  registry: ChainRegistry;
  adapters: readonly AdapterRegistration[];
  /** 当前启用的里程碑；只有 milestone <= 该值的链会对内可用。默认 M0。 */
  milestone?: Milestone;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * 加权选择用的随机源（注入点，默认 `Math.random`）。
   *
   * 为什么需要它：Provider 选择在评分相同的前 2 名之间做**加权随机**（provider-spec 第 8 章）。
   * 这让"主 Provider 失败后切到备用"这类故障切换行为在测试里不可确定性复现——
   * 随机可能先选中备用，于是主 Provider 根本没被调用，断言时而通过时而失败。
   * 注入固定值（如 `() => 0`）即可稳定地先选最高分候选。与既有的 `now` 注入同一风格。
   */
  random?: () => number;
  onProviderCall?: (record: ProviderCallRecord) => void;
  /**
   * Adapter 调用观测出口（DFR-M1-E02 观测补充）。
   *
   * Core 是唯一知道"哪次 Adapter 调用对应哪个请求"的层，因此 `adapter.call` 记录在
   * Core 产生（observability-spec 第 4 章 span 层级）。与 `onProviderCall` 一样，
   * 回调**不得**抛错影响业务路径；composition root 负责把它接到结构化日志。
   */
  onAdapterCall?: (record: AdapterCallRecord) => void;
  /**
   * Core 编排操作观测出口（observability-spec §5.2）。
   *
   * 与 `onAdapterCall` 一起在 `callAdapter` 的单点发出——同一把锁、同一份计时，
   * 因此两者的耗时可比（Core 操作耗时 ≥ 其中 Adapter 调用耗时）。
   */
  onCoreOperation?: (record: CoreOperationRecord) => void;
  /**
   * `registry 声明了但 Adapter 未实现` 的能力计数出口（§5.2 的
   * `dfr_core_capability_unsupported_total`）。正常应为 0。
   */
  onCapabilityUnsupported?: (input: {
    readonly chain: ChainId;
    readonly capability: string;
    /**
     * 两种"能力不可用"的来源，映射到 §5.2 与 §5.3 的两个不同计数器：
     * - `capability_not_declared`：Adapter 的 `capabilities()` 里没有该能力
     *   → `dfr_core_capability_unsupported_total`；
     * - `method_missing`：Adapter **声明了**该能力却没有对应方法
     *   → `dfr_adapter_registry_mismatch_total`（spec §8 明确：这说明启动校验被绕过，应为 0）。
     */
    readonly kind: 'capability_not_declared' | 'method_missing';
  }) => void;
  /**
   * M0 只读观测缓存（不是 M1 引擎 Store）。
   *
   * DFR-M1-A06 前该选项名为 `transactionStore`，但 `TransactionStore` 现在是
   * `@dfr/transaction` 的 M1 引擎端口（`create/get/transition/listRecoverable`）。
   * 两者语义不同（观测缓存 vs 引擎记录），因此改名以消除歧义，
   * 避免 M1 装配时把链上观测误写进交易执行表。M1 引擎 Store 由 composition root 装配。
   */
  transactionObservationStore?: TransactionObservationStore;
  /** M1 交易数据面端口；M1+ 必须完整提供。 */
  transactionStores?: TransactionStores;
  /**
   * E5：Provider 日配额持久 Store。
   *
   * 由 composition root 注入；未提供时 Provider Manager 沿用进程内计数。
   * Core 只透传端口，不知道 SQL 或数据库实现。
   */
  providerQuotaStore?: ProviderQuotaStore;
}

export interface TransactionStores {
  readonly transaction: TransactionStore;
  readonly idempotency: IdempotencyStore;
  readonly nonce: NonceStore;
  /** M3-B03（ADR-033）：Solana 的 blockhash 排序租约；EVM 部署可不装配。 */
  readonly sequencing?: SequencingStore;
  readonly tracker: TrackerLeaseStore;
}

export interface CallContext {
  requestId: RequestId;
  traceId?: string;
  spanId?: string;
  signal?: AbortSignal;
}

const MILESTONE_ORDER: readonly Milestone[] = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];

function defaultFinality(policy: FinalityPolicy): FinalityLevel {
  switch (policy.kind) {
    case 'none': return 'submitted';
    case 'confirmations': return 'confirmed';
    case 'checkpoint': return 'finalized';
    case 'commitment': {
      const strongest = policy.levels.at(-1);
      if (strongest === 'finalized') return 'finalized';
      if (strongest === 'confirmed') return 'confirmed';
      return 'included';
    }
  }
}

interface ChainRuntime {
  chain: Chain;
  adapter: ChainAdapter;
  /**
   * Adapter 的**实际实现版本**（来自 `AdapterRegistration.version`，例如 `0.1.0`）。
   *
   * 刻意不用 `chain.adapter.version`：那是 Registry 声明的 **semver 范围**（如 `^0.1.0`），
   * 拿它当指标标签既不准确（不是具体版本）、也会被标签白名单折叠成 `other`
   * （含 `^` 字符）。观测要的是"跑的是哪个版本"。
   */
  adapterVersion: string;
  /** 惰性构造：未配置端点的链不阻塞整个进程启动。 */
  manager?: ProviderManager;
}

/**
 * 一次 Adapter 调用的观测记录（DFR-M1-E02 观测补充）。
 *
 * 权威来源：docs/architecture/observability-spec-v0.1.md 第 3 章关联字段与第 4 章 span 层级
 * （`core.operation` → `adapter.call` → `provider.request`）。
 *
 * 刻意**不**包含：调用参数、返回值、载荷、地址列表。Adapter 的参数可能含 calldata 与
 * unsigned payload；它们既可能很大也可能敏感，不属于日志字段。需要下钻时用 `requestId`/`traceId`
 * 关联已脱敏的 Gateway 日志与 Provider 调用日志。
 */
export interface AdapterCallRecord {
  readonly requestId: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  /** Adapter 标识，例如 evm。 */
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly chain: ChainId;
  /** Adapter 方法名，例如 getBalance / build / broadcast。 */
  readonly method: string;
  /**
   * 读写分类（observability-spec §5.3 的 `method_class` 标签）。
   *
   * 判定口径：**只有 `broadcast` 是链上写**。`build` / `simulate` 不改变链上状态，
   * 因此是 `read`——把它们算成写会虚高写路径指标、并让"写操作"这个信号失去意义。
   */
  readonly methodClass: 'read' | 'write';
  readonly status: 'success' | 'error';
  /** 稳定的 DFR 错误码（已归一化）。 */
  readonly errorCode?: string;
  readonly latencyMs: number;
}

/**
 * 一次 Core 编排操作的观测事件（observability-spec §5.2）。
 *
 * 与 `AdapterCallRecord` 分开：Core 的"操作"是面向调用方的语义单位，
 * 未来可能出现不经过 Adapter 的操作（例如纯缓存命中）。两者目前 1:1，但不合并，
 * 以免以后要为缓存路径伪造一个 adapter 记录。
 */
export interface CoreOperationRecord {
  readonly requestId: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly operation: string;
  readonly chain: ChainId;
  readonly status: 'success' | 'error';
  readonly errorCode?: string;
  /** 错误分类（来自 error-spec 的 metadata）；仅 error 时有值。 */
  readonly category?: string;
  readonly latencyMs: number;
}

/** 单链就绪明细（DFR-M1-E02）。 */
export interface ChainReadiness {
  readonly chain: string;
  readonly providers: number;
  readonly available: number;
}

/** Core 就绪报告；Gateway `/readyz` 的输入之一。 */
export interface CoreReadiness {
  readonly ready: boolean;
  readonly chains: readonly ChainReadiness[];
}

export class DfrCore {
  private readonly options: DfrCoreOptions;
  private readonly runtimes = new Map<string, ChainRuntime>();
  private readonly registry: ChainRegistry;
  /** 主动就绪探测的 TTL 缓存与单飞句柄（见 `probeReadiness`）。 */
  private readinessProbeCache: { readonly at: number; readonly result: CoreReadiness } | undefined;
  private readinessProbeInFlight: Promise<CoreReadiness> | undefined;

  readonly transactionObservationStore: TransactionObservationStore;
  readonly transactionStores?: TransactionStores;

  constructor(options: DfrCoreOptions) {
    this.options = options;
    this.registry = options.registry;
    this.transactionObservationStore =
      options.transactionObservationStore ?? new InMemoryTransactionObservationStore();

    const upTo = options.milestone ?? 'M0';
    const maxIndex = MILESTONE_ORDER.indexOf(upTo);
    if (maxIndex >= MILESTONE_ORDER.indexOf('M1')) {
      const stores = options.transactionStores;
      if (
        stores === undefined ||
        stores.transaction === undefined ||
        stores.idempotency === undefined ||
        stores.nonce === undefined ||
        stores.tracker === undefined
      ) {
        throw createDfrError('DFR_CONFIGURATION_ERROR', {
          requestId: newRequestId(),
          message: 'M1 requires complete persistent transaction stores',
        });
      }
      this.transactionStores = stores;
    }

    for (const entry of this.registry.listEntries()) {
      if (MILESTONE_ORDER.indexOf(entry.milestone) > maxIndex) continue;
      const registration = options.adapters.find((a) => a.id === entry.adapter.id);
      if (registration === undefined) {
        throw createDfrError('DFR_CONFIGURATION_ERROR', {
          requestId: newRequestId(),
          message: `链 ${entry.id} 引用了未注册的 Adapter "${entry.adapter.id}"`,
          chain: entry.id,
        });
      }
      const chain = projectChain(entry);
      const adapter = registration.create(chain);
      this.registry.assertAdapterCapabilities(entry.id, adapter.capabilities().capabilities);
      this.runtimes.set(entry.id, { chain, adapter, adapterVersion: registration.version });
    }
  }

  /** 当前里程碑下对内可用的链（领域模型，不含 milestone）。 */
  listChains(): readonly Chain[] {
    return [...this.runtimes.values()].map((r) => r.chain);
  }

  hasChain(chainId: string): boolean {
    return this.runtimes.has(chainId);
  }

  /* ------------------------------ 查询 ------------------------------ */

  async getChainInfo(chainId: string, ctx: CallContext): Promise<ChainInfo> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'block.read', ctx);
    const adapterCtx = this.adapterContext(runtime, ctx);
    return await this.callAdapter(runtime, ctx, 'getInfo', () => runtime.adapter.getInfo(adapterCtx));
  }

  async getBalance(
    request: {
      chain: ChainId;
      account: AccountRef;
      asset?: AssetRef;
      consistency?: ConsistencyHint;
    },
    ctx: CallContext,
  ): Promise<Balance> {
    const runtime = this.runtime(request.chain, ctx);
    this.requireCapability(runtime, 'account.balance', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BalanceCapability>;
    if (typeof adapter.getBalance !== 'function') {
      throw this.unsupported('account.balance', runtime, ctx);
    }
    const adapterCtx = this.adapterContext(runtime, ctx);
    try {
      return await this.callAdapter(runtime, ctx, 'getBalance', () =>
        adapter.getBalance!(adapterCtx, {
          account: request.account,
          ...(request.asset !== undefined ? { asset: request.asset } : {}),
          ...(request.consistency !== undefined ? { consistency: request.consistency } : {}),
        }),
      );
    } catch (err) {
      throw this.normalize(err, ctx, request.chain);
    }
  }

  async getBlock(chainId: ChainId, ref: BlockRef, ctx: CallContext): Promise<Block | null> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'block.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BlockCapability>;
    if (typeof adapter.getBlock !== 'function') {
      throw this.unsupported('block.read', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'getBlock', () =>
      adapter.getBlock!(this.adapterContext(runtime, ctx), ref),
    );
  }

  async getTransaction(
    chainId: ChainId,
    ref: TransactionRef,
    ctx: CallContext,
  ): Promise<Transaction | null> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<TransactionQueryCapability>;
    if (typeof adapter.getTransaction !== 'function') {
      throw this.unsupported('transaction.read', runtime, ctx);
    }
    const tx = await this.callAdapter(runtime, ctx, 'getTransaction', () =>
      adapter.getTransaction!(this.adapterContext(runtime, ctx), ref),
    );
    if (tx !== null) await this.transactionObservationStore.put(chainId, tx);
    return tx;
  }

  /** 单次确认观测 + Registry 策略判定；轮询、lease 与后台任务由 Transaction 负责。 */
  async observeConfirmation(
    chainId: ChainId,
    txHash: string,
    minFinality: FinalityLevel | undefined,
    ctx: CallContext,
  ): Promise<ConfirmationResult> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<ConfirmationObservationReadMethod>;
    if (typeof adapter.observeConfirmation !== 'function') {
      throw this.unsupported('transaction.read', runtime, ctx);
    }
    try {
      const observation: ChainConfirmationObservation | null = await this.callAdapter(
        runtime,
        ctx,
        'observeConfirmation',
        () => adapter.observeConfirmation!(this.adapterContext(runtime, ctx), { txHash }),
      );
      if (observation === null) {
        throw createDfrError('DFR_TRANSACTION_NOT_FOUND', {
          requestId: ctx.requestId,
          message: '链上未找到该交易',
          chain: chainId,
        });
      }
      const requiredFinality = minFinality ?? defaultFinality(runtime.chain.finality);
      const evaluation = evaluateFinality({
        policy: runtime.chain.finality,
        finalityStatus: runtime.chain.finalityStatus,
        required: requiredFinality,
        observed: observation.finality,
        ...(observation.confirmations !== undefined
          ? { confirmations: observation.confirmations }
          : {}),
      });
      // An unverified Registry policy must never let a raw adapter `finalized`
      // observation advance the DFR lifecycle to finalized. Keep the observed
      // finality fact, but cap the lifecycle status at confirmed.
      const lifecycleStatus = observation.status === 'finalized' &&
        runtime.chain.finalityStatus !== 'verified'
        ? 'confirmed'
        : observation.status;
      return {
        ref: { kind: 'hash', hash: txHash },
        status: lifecycleStatus,
        finality: evaluation.observed,
        requiredFinality,
        reached: evaluation.reached,
        ...(observation.blockRef !== undefined ? { blockRef: observation.blockRef } : {}),
        ...(observation.canonicalBlockHash !== undefined
          ? { canonicalBlockHash: observation.canonicalBlockHash }
          : {}),
        ...(observation.confirmations !== undefined
          ? { confirmations: observation.confirmations }
          : {}),
      };
    } catch (err) {
      throw this.normalize(err, ctx, chainId);
    }
  }

  async getReceipt(
    chainId: ChainId,
    ref: TransactionRef,
    ctx: CallContext,
  ): Promise<Receipt | null> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<TransactionQueryCapability>;
    if (typeof adapter.getReceipt !== 'function') return null;
    return await this.callAdapter(runtime, ctx, 'getReceipt', () =>
      adapter.getReceipt!(this.adapterContext(runtime, ctx), ref),
    );
  }

  /**
   * 只读合约调用（ADR-035，`eth_call`）。只读；ABI 编解码在 Adapter。
   */
  async readContract(
    chainId: ChainId,
    req: ContractReadRequest,
    ctx: CallContext,
  ): Promise<ContractReadResult> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'contract.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<ContractReadCapability>;
    if (typeof adapter.readContract !== 'function') {
      throw this.unsupported('contract.read', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'readContract', () =>
      adapter.readContract!(this.adapterContext(runtime, ctx), { ...req, chain: chainId }),
    );
  }

  /**
   * 账户存在性 / 合约判定（ADR-036，`eth_getCode`）。只读。
   */
  async getAccount(chainId: ChainId, account: AccountRef, ctx: CallContext): Promise<Account> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'account.code', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<AccountCodeCapability>;
    if (typeof adapter.getAccount !== 'function') {
      throw this.unsupported('account.code', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'getAccount', () =>
      adapter.getAccount!(this.adapterContext(runtime, ctx), account),
    );
  }

  /**
   * 事件日志查询（ADR-034，M4）。Capability 路由 + Adapter 调用，只读。
   *
   * 有界区间由 Adapter 保证（`maxBlockRange`）；Core 只做能力闸门、方法存在性判定与
   * 错误归一化。Adapter 未实现该能力时 fail-closed 为 `DFR_UNSUPPORTED_CAPABILITY`。
   */
  async getLogs(
    chainId: ChainId,
    req: ContractLogsRequest,
    ctx: CallContext,
  ): Promise<readonly ChainLog[]> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'contract.logs', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<ContractLogsCapability>;
    if (typeof adapter.logs !== 'function') {
      throw this.unsupported('contract.logs', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'logs', () =>
      adapter.logs!(this.adapterContext(runtime, ctx), { ...req, chain: chainId }),
    );
  }

  /* ------------------------------ M1 写路径 ------------------------------ */

  /**
   * 构造未签名交易（DFR-M1-B07）：Capability 路由 + Adapter 调用，不落库、不签名。
   *
   * Core 只做路由与错误归一化；nonce 分配、幂等与状态机属于 Transaction Engine。
   * 本方法**不**读取或分配 nonce——那是 `TransactionEngine` 的职责，它把引擎分配
   * 的显式 nonce 交给本方法（Adapter 因此不会再查一次 nonce）。
   */
  async buildTransaction(
    chainId: ChainId,
    request: TransactionRequest,
    ctx: CallContext,
  ): Promise<UnsignedTransaction> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.build', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BuildCapability>;
    if (typeof adapter.build !== 'function') {
      throw this.unsupported('transaction.build', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'build', () =>
      adapter.build!(this.adapterContext(runtime, ctx), request),
    );
  }

  /**
   * 模拟交易（DFR-M1-B08 使用；端口路径）。
   *
   * 回滚由 Adapter 表达为 `SimulationResult.success=false`，本方法不把它转成异常
   * （error-spec 第 5 章：不要把可预期的回滚包装成 5xx）。
   */
  async simulateTransaction(
    chainId: ChainId,
    transaction: TransactionRequest | UnsignedTransaction,
    ctx: CallContext,
    options?: SimulationOptions,
  ): Promise<SimulationResult> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.simulate', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<SimulationCapability>;
    if (typeof adapter.simulate !== 'function') {
      throw this.unsupported('transaction.simulate', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'simulate', () =>
      adapter.simulate!(this.adapterContext(runtime, ctx), transaction, options),
    );
  }

  /**
   * 广播已签名交易（DFR-M1-C03a；端口路径）。
   *
   * Core 只做 Capability 路由与错误归一化：链语义（签名载荷解析、绑定校验、
   * 单次 `eth_sendRawTransaction`）全部在 Adapter。`options` 里的记录真值
   * （`expectedFrom` / `expectedUnsignedPayload`）由 Engine 提供、Core 原样搬运，
   * Core 不解释它们。
   */
  async broadcastTransaction(
    chainId: ChainId,
    signed: SignedTransaction,
    ctx: CallContext,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.broadcast', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BroadcastCapability>;
    if (typeof adapter.broadcast !== 'function') {
      throw this.unsupported('transaction.broadcast', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'broadcast', () =>
      adapter.broadcast!(this.adapterContext(runtime, ctx), signed, options),
    );
  }

  /**
   * 读链上 pending nonce（DFR-M1-B07 端口路径，非 Capability）。
   *
   * Adapter 未实现该方法时 fail-closed 为 `DFR_UNSUPPORTED_CAPABILITY`，不静默
   * 返回 `0`——否则会把"读不到 nonce"变成"用 nonce 0 构造交易"。
   */
  async getPendingNonce(
    chainId: ChainId,
    account: AccountRef,
    ctx: CallContext,
  ): Promise<DecimalUint> {
    const runtime = this.runtime(chainId, ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<PendingNonceReadMethod>;
    if (typeof adapter.getPendingNonce !== 'function') {
      throw this.unsupported('transaction.build', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'getPendingNonce', () =>
      adapter.getPendingNonce!(this.adapterContext(runtime, ctx), account),
    );
  }

  /**
   * 取本链当前的**排序前提**（ADR-033，非 Capability 的内部协调入口）。
   *
   * 与 `getPendingNonce` 同理：不查 Registry 能力，只按 Adapter 的方法存在性路由；
   * 缺失时 fail-closed 为 `DFR_UNSUPPORTED_CAPABILITY`（而不是猜一个 token）。
   */
  async getSequencingToken(
    chainId: ChainId,
    account: AccountRef,
    ctx: CallContext,
  ): Promise<SequencingToken> {
    const runtime = this.runtime(chainId, ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<SequencingTokenReadMethod>;
    if (typeof adapter.getSequencingToken !== 'function') {
      throw this.unsupported('transaction.build', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'getSequencingToken', () =>
      adapter.getSequencingToken!(this.adapterContext(runtime, ctx), account),
    );
  }

  /**
   * 把引擎分配的排序前提注入请求（ADR-033）。
   *
   * Solana 的 `build` 必须用这个 blockhash（否则租约与载荷不一致）；EVM 用的是
   * `req.nonce`，Adapter 也实现本方法以保持同一套引擎路径。缺失即 fail-closed。
   */
  withSequencingToken(
    chainId: ChainId,
    request: TransactionRequest,
    token: SequencingToken,
  ): TransactionRequest {
    const runtime = this.runtime(chainId, {
      requestId: 'req_sequencing_inject' as never,
    });
    const adapter = runtime.adapter as ChainAdapter & Partial<EnsureSequencingTokenMethod>;
    if (typeof adapter.withSequencingToken !== 'function') {
      throw this.unsupported('transaction.build', runtime, {
        requestId: 'req_sequencing_inject' as never,
      });
    }
    return adapter.withSequencingToken(request, token);
  }

  /**
   * 观测广播后的链上处境（DFR-M1-C03b，非 Capability 的内部协调入口）。
   *
   * 与 `getPendingNonce` 同理：不查 Registry 能力（这不是对外 API），
   * 只按 Adapter 的方法存在性路由；缺失时 fail-closed 为
   * `DFR_UNSUPPORTED_CAPABILITY`，由引擎保持 `unknown`。
   */
  async observeBroadcast(
    chainId: ChainId,
    req: BroadcastObservationRequest,
    ctx: CallContext,
  ): Promise<BroadcastObservation> {
    const runtime = this.runtime(chainId, ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BroadcastObservationReadMethod>;
    if (typeof adapter.observeBroadcast !== 'function') {
      throw this.unsupported('transaction.read', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'observeBroadcast', () =>
      adapter.observeBroadcast!(this.adapterContext(runtime, ctx), req),
    );
  }

  /**
   * 判定一个**排序前提**（blockhash / nonce）在当前链状态下是否已过期
   * （DFR-M3-A01，ADR-032）。
   *
   * 与 `getPendingNonce` 同理：不查 Registry 能力（这不是对外 API），只按 Adapter
   * 的方法存在性路由。**仅 nonce 在缺失方法时视为永不过期**（EVM 语义）。
   * 对 blockhash 则必须 fail-closed：不能把“无法查询链高”误当作“尚未过期”。
   * 过期语义及实际链高判定仍由 Adapter 拥有（roadmap M3 第一条红线）。
   */
  async isSequencingExpired(
    chainId: ChainId,
    token: SequencingToken,
    ctx: CallContext,
  ): Promise<boolean> {
    const runtime = this.runtime(chainId, ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<SequencingTokenExpiryMethod>;
    if (typeof adapter.isSequencingExpired !== 'function') {
      if (token.kind === 'nonce') return false;
      // Solana blockhash validity is height-dependent. Adapter absence is
      // unknown validity, never affirmative evidence that the hash is live.
      throw this.unsupported('transaction.build', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'isSequencingExpired', () =>
      adapter.isSequencingExpired!(this.adapterContext(runtime, ctx), token),
    );
  }

  /**
   * 启动 Provider 健康巡检。
   *
   * 语义（M0 明确）：尝试为每条启用的链构造 Manager，**端点未配置的链被跳过**，
   * 不阻塞进程启动。这类链在首次收到请求时会以 `DFR_CONFIGURATION_ERROR` fail-closed。
   *
   * 结果通过返回值暴露，便于启动日志如实报告"哪条链有健康巡检、哪条没有"，
   * 而不是让运维以为全部在监控中。
   */
  startHealthChecks(): { started: string[]; skipped: string[] } {
    const started: string[] = [];
    const skipped: string[] = [];
    for (const [id, runtime] of this.runtimes) {
      try {
        this.managerFor(runtime, { requestId: newRequestId() });
        runtime.manager?.startHealthChecks();
        started.push(id);
      } catch {
        skipped.push(id);
      }
    }
    return { started, skipped };
  }

  stopHealthChecks(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.manager?.stopHealthChecks();
    }
  }

  /** Provider 健康快照（运维巡检用）。 */
  providerHealth(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, runtime] of this.runtimes) {
      out[id] = runtime.manager?.healthSnapshot() ?? [];
    }
    return out;
  }

  /**
   * Provider 观测快照（observability-spec §5.4 的 gauge 数据源，只读、不联网）。
   *
   * 返回 `chainId → 每 Provider 快照`；未配置端点的链返回空数组
   * （与 `readiness()` 的"0 providers"口径一致，不伪造 gauge）。
   */
  providerObservability(): Record<string, readonly ProviderObservabilitySnapshot[]> {
    const out: Record<string, readonly ProviderObservabilitySnapshot[]> = {};
    for (const [id, runtime] of this.runtimes) {
      const manager = this.managerIfConfigured(runtime);
      out[id] = manager?.observabilitySnapshot() ?? [];
    }
    return out;
  }

  /** E5：异步 Provider 观测（配额用量来自持久 Store）。 */
  async providerObservabilityAsync(): Promise<Record<string, readonly ProviderObservabilitySnapshot[]>> {
    const out: Record<string, readonly ProviderObservabilitySnapshot[]> = {};
    for (const [id, runtime] of this.runtimes) {
      const manager = this.managerIfConfigured(runtime);
      out[id] = manager !== undefined ? await manager.observabilitySnapshotAsync() : [];
    }
    return out;
  }

  /**
   * 运维就绪报告（DFR-M1-E02，observability-spec 第 9 章）。
   *
   * 语义刻意保持可从外部验证、且不发明新状态：
   * - `providers`：该链已装配的 Provider 数量（0 = 端点/凭证未解析成功）；
   * - `available`：其中**读熔断器未打开**的数量（open 的 Provider 不接流量）；
   * - `ready`：至少启用一条链，且至少一条链有可用 Provider。
   *
   * 这里不把"从未观测过"（health status = unknown）判为不可用：冷启动的 Provider
   * 在第一次探针之前就是这样，若判为不可用会导致刚启动的实例永远不就绪。
   * 该取舍写在 docs/runbooks/m1-local.md 的探针一节。
   */
  readiness(): CoreReadiness {
    const chains: ChainReadiness[] = [];
    for (const [id, runtime] of this.runtimes) {
      const manager = this.managerIfConfigured(runtime);
      if (manager === undefined) {
        chains.push({ chain: id, providers: 0, available: 0 });
        continue;
      }
      const snapshot = manager.healthSnapshot();
      const available = snapshot.filter(
        (entry) => manager.circuitState(entry.providerId, 'read') !== 'open',
      ).length;
      chains.push({ chain: id, providers: snapshot.length, available });
    }
    const ready = chains.length > 0 && chains.some((entry) => entry.available > 0);
    return { ready, chains };
  }

  /**
   * 主动探测就绪（DFR-M1-E02 观测补充；opt-in）。
   *
   * 与同步 `readiness()` 的区别：`readiness()` 只读**已有**的熔断/健康状态，因此一个刚启动、
   * 还没跑过任何探针的实例会把 `unknown` 的 Provider 计为可用——冷启动时可能"谎报就绪"。
   * 本方法对每条链的**每个** Provider 当场发一次低权重探针（`eth_chainId` 之类），
   * `available` 因此表示"刚才真的应答了"。
   *
   * 成本控制（三条，缺一不可）：
   * - **TTL 缓存**：`cacheMs`（默认 5s）内复用上一次结果，避免编排系统每秒轮询就打一次 RPC；
   * - **单飞**：并发调用共享同一个探测 Promise，不产生探测风暴；
   * - **短超时**：`timeoutMs`（默认 2s）限制就绪路径的最坏延迟。
   *
   * 探针走 `ProviderManager.probe`，它直接调用 `provider.request`，**不经过熔断器**，
   * 因此"探测失败"不会把熔断器打开（探针不应改写熔断状态）。
   */
  async probeReadiness(options: { timeoutMs?: number; cacheMs?: number } = {}): Promise<CoreReadiness> {
    const cacheMs = options.cacheMs ?? 5_000;
    const timeoutMs = options.timeoutMs ?? 2_000;
    const now = (this.options.now ?? Date.now)();
    const cached = this.readinessProbeCache;
    if (cached !== undefined && cacheMs > 0 && now - cached.at < cacheMs) return cached.result;
    if (this.readinessProbeInFlight !== undefined) return await this.readinessProbeInFlight;

    const inFlight = this.runReadinessProbe(timeoutMs, now).finally(() => {
      this.readinessProbeInFlight = undefined;
    });
    this.readinessProbeInFlight = inFlight;
    return await inFlight;
  }

  private async runReadinessProbe(timeoutMs: number, now: number): Promise<CoreReadiness> {
    const chains: ChainReadiness[] = [];
    for (const [id, runtime] of this.runtimes) {
      const manager = this.managerIfConfigured(runtime);
      if (manager === undefined) {
        chains.push({ chain: id, providers: 0, available: 0 });
        continue;
      }
      const providerIds = manager.healthSnapshot().map((entry) => entry.providerId);
      let available = 0;
      for (const providerId of providerIds) {
        // 串行探测：Provider 数量是个位数，串行避免瞬时并发冲击上游端点。
        if (await manager.probe(providerId, timeoutMs)) available += 1;
      }
      chains.push({ chain: id, providers: providerIds.length, available });
    }
    const result: CoreReadiness = {
      ready: chains.length > 0 && chains.some((entry) => entry.available > 0),
      chains,
    };
    this.readinessProbeCache = { at: now, result };
    return result;
  }

  /** 惰性构造 ProviderManager；端点/凭证解析失败视为该链不可用，而不是让探针抛错。 */
  private managerIfConfigured(runtime: ChainRuntime): ChainRuntime['manager'] {
    if (runtime.manager !== undefined) return runtime.manager;
    try {
      return this.managerFor(runtime, { requestId: newRequestId() });
    } catch {
      return undefined;
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  private runtime(chainId: string, ctx: CallContext): ChainRuntime {
    const runtime = this.runtimes.get(chainId);
    if (runtime === undefined) {
      throw createDfrError('DFR_NOT_FOUND', {
        requestId: ctx.requestId,
        message: `未知或未启用的链 "${chainId}"`,
      });
    }
    return runtime;
  }

  /**
   * 统一的 Adapter 调用包装（DFR-M1-E02 观测补充）。
   *
   * 做三件事，且顺序固定：
   * 1. 计时并调用 Adapter；
   * 2. 成功 → 发 `adapter.call`(success) 记录；
   * 3. 失败 → **先归一化**错误（`normalize`），用归一化后的稳定错误码发记录，
   *    再抛出归一化错误。
   *
   * 为什么先归一化再记录：`Provider`/`viem` 抛出的原始异常文本可能含端点或内部地址，
   * 而 `errorCode` 是稳定枚举。日志只记 code，不记原文。
   */
  private async callAdapter<T>(
    runtime: ChainRuntime,
    ctx: CallContext,
    method: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      const elapsed = Date.now() - started;
      this.emitAdapterCall(runtime, ctx, method, 'success', undefined, elapsed);
      this.emitCoreOperation(runtime, ctx, method, 'success', undefined, elapsed);
      return result;
    } catch (err) {
      const normalized = this.normalize(err, ctx, runtime.chain.id as ChainId);
      const elapsed = Date.now() - started;
      const code = isDfrError(normalized) ? normalized.code : 'DFR_INTERNAL_ERROR';
      this.emitAdapterCall(runtime, ctx, method, 'error', code, elapsed);
      this.emitCoreOperation(runtime, ctx, method, 'error', code, elapsed);
      throw normalized;
    }
  }

  /**
   * 发出一次 Core 操作记录（observability-spec §5.2）。
   *
   * 与 `emitAdapterCall` 同一约定：出口抛错被吞掉，观测失败不得改变业务结果。
   */
  private emitCapabilityUnsupported(
    chain: ChainId,
    capability: string,
    kind: 'capability_not_declared' | 'method_missing',
  ): void {
    const sink = this.options.onCapabilityUnsupported;
    if (sink === undefined) return;
    try {
      sink({ chain, capability, kind });
    } catch {
      // 观测是尽力而为。
    }
  }

  private emitCoreOperation(
    runtime: ChainRuntime,
    ctx: CallContext,
    operation: string,
    status: 'success' | 'error',
    errorCode: string | undefined,
    latencyMs: number,
  ): void {
    const onCoreOperation = this.options.onCoreOperation;
    if (onCoreOperation === undefined) return;
    // 先取出可能为 undefined 的派生值，避免 exactOptionalPropertyTypes 下的窄化丢失。
    const category = categoryOf(errorCode);
    try {
      onCoreOperation({
        requestId: ctx.requestId,
        ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
        ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
        operation,
        chain: runtime.chain.id as ChainId,
        status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        // 错误分类取自 error-spec 的 metadata；未知码不带 category（不猜）。
        ...(category !== undefined ? { category } : {}),
        latencyMs: Math.max(0, latencyMs),
      });
    } catch {
      // 观测是尽力而为。
    }
  }

  private emitAdapterCall(
    runtime: ChainRuntime,
    ctx: CallContext,
    method: string,
    status: 'success' | 'error',
    errorCode: string | undefined,
    latencyMs: number,
  ): void {
    const onAdapterCall = this.options.onAdapterCall;
    if (onAdapterCall === undefined) return;
    try {
      onAdapterCall({
        requestId: ctx.requestId,
        ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
        ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
        adapter: runtime.chain.adapter.id,
        // 实际实现版本，不是 Registry 的 semver 范围（见 ChainRuntime.adapterVersion）。
        adapterVersion: runtime.adapterVersion,
        chain: runtime.chain.id,
        method,
        methodClass: adapterMethodClass(method),
        status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        latencyMs: Math.max(0, latencyMs),
      });
    } catch {
      // 观测是尽力而为：日志出口失败不得改变业务结果。
    }
  }

  private requireCapability(
    runtime: ChainRuntime,
    capability: CapabilityId,
    ctx: CallContext,
  ): void {
    const declared = runtime.adapter.capabilities().capabilities;
    // 见 ADR-034：Provider 路由按**注册表声明**的能力过滤，而 Adapter 的 `capabilities()` 是
    // 实现真相。二者对 `contract.logs`/`contract.read` 这类"可能未被注册表启用"的能力可能
    // 不一致——若只查 Adapter，未声明的链会走到 Provider 选择并报出误导性的
    // `DFR_CHAIN_UNAVAILABLE`(503)。因此这里同时要求**注册表**声明该能力：
    // 未声明即 fail-closed 为 `DFR_UNSUPPORTED_CAPABILITY`(422)。
    const registryDeclares = runtime.chain.capabilities.includes(capability);
    if (!declared.includes(capability) || !registryDeclares) {
      // capability 不支持是**配置/契约**问题，不是运行时抖动：单独计数，
      // 便于用 §5.2 的 `capability_unsupported` 直接定位（值为 0 才是健康状态）。
      this.emitCapabilityUnsupported(runtime.chain.id as ChainId, capability, 'capability_not_declared');
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: `链 ${runtime.chain.id} 不支持能力 ${capability}`,
        chain: runtime.chain.id,
        details: { capability },
      });
    }
  }

  private unsupported(
    capability: CapabilityId,
    runtime: ChainRuntime,
    ctx: CallContext,
  ): Error {
    // 走到这里说明 Registry 声明了该能力、但 Adapter 没有实现对应方法——
    // 正是 spec §8 所说的"启动校验被绕过"，必须单独计数（正常为 0）。
    this.emitCapabilityUnsupported(runtime.chain.id as ChainId, capability, 'method_missing');
    return createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
      requestId: ctx.requestId,
      message: `链 ${runtime.chain.id} 声明了 ${capability} 但未实现对应方法`,
      chain: runtime.chain.id,
      details: { capability },
    });
  }

  private adapterContext(runtime: ChainRuntime, ctx: CallContext): AdapterContext {
    const manager = this.managerFor(runtime, ctx);
    const adapterCtx: AdapterContext = {
      chain: runtime.chain.id,
      network: runtime.chain.network,
      providers: manager,
      signal: ctx.signal ?? new AbortController().signal,
      requestId: ctx.requestId,
    };
    if (ctx.traceId !== undefined) adapterCtx.traceId = ctx.traceId;
    if (ctx.spanId !== undefined) adapterCtx.spanId = ctx.spanId;
    return adapterCtx;
  }

  private managerFor(runtime: ChainRuntime, ctx: CallContext): ProviderManager {
    if (runtime.manager !== undefined) return runtime.manager;
    const descriptors = this.registry.listProviders(runtime.chain.id);
    if (descriptors.length === 0) {
      throw createDfrError('DFR_CHAIN_UNAVAILABLE', {
        requestId: ctx.requestId,
        message: `链 ${runtime.chain.id} 未配置任何 Provider`,
        chain: runtime.chain.id,
      });
    }
    const options: ConstructorParameters<typeof ProviderManager>[0] = {
      chain: runtime.chain.id,
      descriptors,
      resolveEndpoint: (d) => this.registry.resolveEndpoint(d),
      resolveCredential: (d) => this.registry.resolveCredential(d),
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.options.random !== undefined ? { random: this.options.random } : {}),
      ...(this.options.onProviderCall !== undefined ? { onCall: this.options.onProviderCall } : {}),
      ...(this.options.providerQuotaStore !== undefined
        ? { quotaStore: this.options.providerQuotaStore }
        : {}),
    };
    const manager = new ProviderManager(options);
    runtime.manager = manager;
    return manager;
  }

  private normalize(err: unknown, ctx: CallContext, chainId: string): Error {
    if (err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
      return err;
    }
    return toDfrError(err, { requestId: ctx.requestId, chain: chainId as ChainId });
  }

}

/** 取错误码的分类（error-spec metadata）；未知码返回 undefined，不猜测。 */
function categoryOf(errorCode: string | undefined): ErrorMetadata['category'] | undefined {
  if (errorCode === undefined) return undefined;
  if (!isKnownErrorCode(errorCode)) return undefined;
  return ERROR_METADATA[errorCode].category;
}

/**
 * Adapter 方法的读写分类（observability-spec §5.3 的 `method_class`）。
 *
 * 只有 `broadcast` 改变链上状态。`build` / `simulate` 都是构造或只读探测，
 * 算成写会虚高写路径指标，让"写操作"这个信号失去意义。
 */
function adapterMethodClass(method: string): 'read' | 'write' {
  return method === 'broadcast' ? 'write' : 'read';
}
