/**
 * Adapter 契约（见 docs/architecture/adapter-spec-v0.1.md）。
 *
 * 采用"基础接口 + Capability 拆分接口"，不采用单个宽接口。
 * 未声明的能力必须返回 DFR_UNSUPPORTED_CAPABILITY，禁止静默降级。
 */
import type { ChainId, NetworkId, ChainFamily, RequestId, DecimalUint } from './primitives.js';
import type { SequencingToken } from './sequencing.js';
import type { CapabilityId, AdapterCapabilities } from './capability.js';
import type { ChainInfo } from './chain.js';
import type { Account, AccountRef } from './account.js';
import type { AssetRef, Balance } from './asset.js';
import type { BlockRef, Block, FinalityState } from './block.js';
import type { ChainLog } from './transaction.js';
import type {
  TransactionRef,
  Transaction,
  Receipt,
  TransactionRequest,
  UnsignedTransaction,
  SignedTransaction,
  SimulationResult,
  BroadcastResult,
  BroadcastOptions,
  ConfirmRequest,
  ConfirmationResult,
} from './transaction.js';
import type { EventFilter, ChainEvent } from './event.js';
import type { ProviderRouter } from './provider.js';

/** 由 Provider Manager 注入，Adapter 不持有端点或凭证。 */
export interface AdapterContext {
  chain: ChainId;
  network: NetworkId;
  /** Provider 路由器；Adapter 按需 acquire，不持有端点或凭证。 */
  providers: ProviderRouter;
  signal: AbortSignal;
  requestId: RequestId;
  traceId?: string;
  spanId?: string;
}

/** 所有 Adapter 必须实现的基础接口。 */
export interface ChainAdapter {
  readonly family: ChainFamily;
  /** Adapter 实现版本（semver）。 */
  readonly version: string;
  readonly specVersion: '0.1';
  getInfo(ctx: AdapterContext): Promise<ChainInfo>;
  capabilities(): AdapterCapabilities;
}

export interface GetBalanceRequest {
  account: AccountRef;
  asset?: AssetRef;
  consistency?: ConsistencyHint;
}

export interface BalanceCapability {
  getBalance(ctx: AdapterContext, req: GetBalanceRequest): Promise<Balance>;
}

export interface BlockCapability {
  getBlock(ctx: AdapterContext, ref: BlockRef): Promise<Block | null>;
}

export interface TransactionQueryCapability {
  getTransaction(ctx: AdapterContext, ref: TransactionRef): Promise<Transaction | null>;
  getReceipt?(ctx: AdapterContext, ref: TransactionRef): Promise<Receipt | null>;
}

export interface BuildCapability {
  build(ctx: AdapterContext, req: TransactionRequest): Promise<UnsignedTransaction>;
}

/**
 * `simulate` 的补充输入（DFR-M1-B07 新增，可选、向后兼容）。
 *
 * `UnsignedTransaction` 本身不含发送方（载荷只有 chainId/nonce/to/value/gas/data
 * 与费用字段）。直接调用 Adapter 时省略 `options` 即维持 B03 行为：不伪造 `from`，
 * 并在 `warnings` 中显式声明"发送方相关检查未被覆盖"。
 *
 * Transaction Engine 拥有记录，知道该载荷的发送方；它通过 `options.from` 让
 * Adapter 把 `from` 补进 `eth_call`，从而让余额 / 授权 / nonce 检查真正生效。
 */
export interface SimulationOptions {
  /** 记录中的发送方；仅在载荷路径（`UnsignedTransaction`）有意义。 */
  from?: AccountRef;
}

export interface SimulationCapability {
  simulate(
    ctx: AdapterContext,
    req: TransactionRequest | UnsignedTransaction,
    options?: SimulationOptions,
  ): Promise<SimulationResult>;
}

/**
 * 非 Capability 的 Adapter 扩展方法：读链上 pending nonce（DFR-M1-B07）。
 *
 * 刻意**不进** `CapabilityId` / `capabilities()`：它不是对外 API 能力，不能被
 * Gateway 直接路由，只服务 Transaction Engine 的 nonce 租约（m1-storage-model §3）。
 * Core 用"方法存在性"判定是否支持，缺失则 fail-closed 为
 * `DFR_UNSUPPORTED_CAPABILITY`，不静默降级。
 */
export interface PendingNonceReadMethod {
  /** 链上 pending nonce，十进制字符串（绝不经 JS `number`）。 */
  getPendingNonce(ctx: AdapterContext, account: AccountRef): Promise<DecimalUint>;
}

/**
 * 非 Capability 的 Adapter 扩展方法：判定一个**排序前提**在当前链状态下是否已过期
 * （DFR-M3-A01，ADR-032）。
 *
 * 为什么必须由 Adapter 拥有（roadmap M3 的第一条红线："链特定过期语义在 Adapter"）：
 * 过期是**链特定的**——
 *   - Solana：比对 `getBlockHeight()` 与 token 的 `lastValidBlockHeight`
 *     （按**区块高度**，不是时间；实测 devnet 有效窗口约 166 个 block）；
 *   - EVM：nonce 不会"过期"，只会被更高的 nonce 消耗 → 不实现本方法。
 *
 * 与 `PendingNonceReadMethod` 同理：不进 `CapabilityId` / `capabilities()`，不能被
 * Gateway 直接路由，只服务 Transaction Engine 的排序租约（`SequencingStore`）。
 * Core 以**方法存在性**判定支持性；缺失即视为"永不过期"（EVM 语义）——
 * 这是显式约定，不是静默降级。
 */
/**
 * 非 Capability 的 Adapter 扩展方法：取本链当前的**排序前提**（ADR-032/033）。
 *
 * 与 `PendingNonceReadMethod` 同理：不进 `CapabilityId` / `capabilities()`，只服务
 * Transaction Engine 的排序租约——EVM 用 `getPendingNonce`（nonce 路径），
 * Solana 用本方法（blockhash 路径）。Core 以方法存在性判定走哪条路径。
 */
export interface SequencingTokenReadMethod {
  getSequencingToken(ctx: AdapterContext, account: AccountRef): Promise<SequencingToken>;
}

/**
 * 非 Capability 的 Adapter 扩展方法：把**引擎分配的排序前提**注入请求（ADR-033）。
 *
 * Solana 的 `build` 必须使用引擎/Store 已经选定并落租约的 blockhash（否则租约与载荷
 * 不一致，等于绕过了"同一交易重复 build 稳定"的保证）。EVM 用的是 `req.nonce`，
 * 不需要本方法。
 */
export interface EnsureSequencingTokenMethod {
  /** 返回注入了排序前提的请求（不修改入参）；非法 token 形状即 fail-closed。 */
  withSequencingToken(req: TransactionRequest, token: SequencingToken): TransactionRequest;
}

export interface SequencingTokenExpiryMethod {
  isSequencingExpired(ctx: AdapterContext, token: SequencingToken): Promise<boolean>;
}

/**
 * 广播后链上观测的输入/输出（DFR-M1-C03b，ADR-019）。
 *
 * 定义在 `types` 而不是 `transaction`，是因为它是 Adapter 与 Core 之间的**链访问契约**
 * （Adapter 报告它看到了什么），而"对应哪个状态事件"属于状态语义、留在 transaction 包。
 * Core 只做搬运，不解释这些字段。
 */
export interface BroadcastObservationRequest {
  readonly chain: ChainId;
  /** 记录里的 expectedHash（由载荷重算，不是调用方声明）。 */
  readonly txHash: string;
  readonly from: AccountRef;
  readonly nonce: DecimalUint;
}

export type BroadcastObservation =
  | { readonly kind: 'included'; readonly txHash: string; readonly blockRef?: BlockRef }
  | { readonly kind: 'pending'; readonly txHash: string }
  | { readonly kind: 'replaced'; readonly nonce: DecimalUint; readonly byTxHash?: string }
  /**
   * 按 expectedHash 查不到，且该 nonce 仍未被占用。
   *
   * 注意：**不等于 dropped** —— mempool 传播是异步的，其它端点可能仍持有该交易。
   * 是否判 `dropped` 由上层在 `dropTimeoutMs` 窗口之后决定（ADR-019）。
   */
  | { readonly kind: 'absent' };

/**
 * 非 Capability 的 Adapter 扩展方法：观测广播后的链上处境（DFR-M1-C03b）。
 *
 * 与 `PendingNonceReadMethod` 同理：不进 `CapabilityId` / `capabilities()`，
 * 因为它是内部协调入口，不对应对外 API 能力。Core 用方法存在性判定，
 * 缺失则引擎保持 `unknown`（fail-closed，不假装 dropped / failed）。
 */
export interface BroadcastObservationReadMethod {
  observeBroadcast(
    ctx: AdapterContext,
    req: BroadcastObservationRequest,
  ): Promise<BroadcastObservation>;
}

/** 单次只读确认观测；Provider/Adapter 不负责轮询或状态持久化。 */
export interface ChainConfirmationObservation {
  readonly status: Transaction['status'];
  readonly finality: FinalityState;
  readonly blockRef?: BlockRef;
  readonly canonicalBlockHash?: string;
  readonly confirmations?: DecimalUint;
}

/**
 * 内部确认观测入口，不是 `transaction.confirm.native` Capability。
 * Core/Transaction 负责最终性策略判定、租约、等待与持久化协调。
 */
export interface ConfirmationObservationReadMethod {
  observeConfirmation(
    ctx: AdapterContext,
    req: { readonly txHash: string },
  ): Promise<ChainConfirmationObservation | null>;
}

export interface BroadcastCapability {
  /**
   * 广播已签名交易。
   *
   * 审计修正 A-06：新增 `options` 参数以承载 `rebroadcast` 标记与幂等键。
   * transaction-lifecycle.md 要求 `dropped → broadcast` 重播携带 `rebroadcast: true`，
   * 但旧签名没有承载它的位置。
   */
  broadcast(
    ctx: AdapterContext,
    signed: SignedTransaction,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult>;
}

/**
 * 原生确认能力（可选，R-02）。
 *
 * 默认路径是 Core 用 transaction.read + Registry 的 FinalityPolicy 轮询派生确认；
 * 只有提供原生确认订阅的链才实现本接口并声明 `transaction.confirm.native`。
 */
export interface NativeConfirmCapability {
  waitForConfirmation(ctx: AdapterContext, req: ConfirmRequest): Promise<ConfirmationResult>;
}

/** event.subscribe 是部署级能力（ADR-025）：Adapter 不实现；本接口仅用于类型映射。 */
export interface EventCapability {
  subscribe(ctx: AdapterContext, filter: EventFilter): AsyncIterable<ChainEvent>;
}

/**
 * 只读合约调用（ADR-035，`eth_call`）。
 *
 * 两种输入二选一，**同时给出即 fail-closed**（避免"用哪个"含糊）：
 *   - `data`：预编码 calldata（`0x…`）——BEX 已用 `cast calldata` 时走这条；
 *   - `abi` + `method`（+ `args`）：由 Adapter 用 viem 编码，并按 outputs 解码返回。
 */
export interface ContractReadRequest {
  readonly chain?: ChainId;
  readonly contract: string;
  /** 预编码 calldata（0x…）。与 abi/method 二选一。 */
  readonly data?: string;
  /** human-readable 或 JSON 片段；提供 method 时用于编码与解码。 */
  readonly abi?: readonly (string | Record<string, unknown>)[];
  readonly method?: string;
  readonly args?: readonly unknown[];
  readonly blockRef?: BlockRef;
}

export interface ContractReadResult {
  /** `eth_call` 的原始返回（0x…）。 */
  readonly data: string;
  /** 提供 abi+method 时，按 outputs 解码的值；否则缺省。 */
  readonly decoded?: unknown;
}

export interface ContractReadCapability {
  readContract(ctx: AdapterContext, req: ContractReadRequest): Promise<ContractReadResult>;
}

/**
 * 账户存在性 / 合约判定（ADR-036，`eth_getCode` + `eth_getTransactionCount`）。
 *
 * 复用既有 `Account` / `AccountKind`。EVM：code 非空 → `contract`，否则 `externally-owned`；
 * `exists` 是**启发式**（code 非空或余额>0 或 nonce>0），不谎称精确。
 */
export interface AccountCodeCapability {
  getAccount(ctx: AdapterContext, account: AccountRef): Promise<Account>;
}

/**
 * 事件日志查询（ADR-034，BEX 链上核对）。
 *
 * 与 `contract.read`（`eth_call`）是**不同**语义：这里按**区块区间**取日志。
 * 有界区间是硬约束：`fromBlock`/`toBlock` 必填，跨度超过 Adapter 声明的
 * `constraints.maxBlockRange` 时 fail-closed（不静默截断）。
 */
export interface ContractLogsRequest {
  readonly chain?: ChainId;
  /** 合约地址；省略 = 任意合约（谨慎：仍须有界区间）。 */
  readonly address?: string;
  /** 与 `eth_getLogs` 的 topics 对齐：null = 通配，数组 = OR。 */
  readonly topics?: readonly (string | readonly string[] | null)[];
  readonly fromBlock: BlockRef;
  readonly toBlock: BlockRef;
  /** 单次返回上限；实现可再收紧。 */
  readonly limit?: number;
}

export interface ContractLogsCapability {
  logs(ctx: AdapterContext, req: ContractLogsRequest): Promise<readonly ChainLog[]>;
}

export interface ConsistencyHint {
  mode: 'best-effort' | 'at-block' | 'finalized';
  blockRef?: BlockRef;
}

/** 供 Core 路由使用的 Capability → 接口映射说明（类型层面）。 */
export interface AdapterCapabilityMap {
  'account.balance': BalanceCapability;
  'block.read': BlockCapability;
  'transaction.read': TransactionQueryCapability;
  'transaction.build': BuildCapability;
  'transaction.simulate': SimulationCapability;
  'transaction.broadcast': BroadcastCapability;
  'event.subscribe': EventCapability;
  'account.code': AccountCodeCapability;
  'contract.read': ContractReadCapability;
  'contract.logs': ContractLogsCapability;
  'transaction.confirm.native': NativeConfirmCapability;
}

export type AdapterCapabilityId = keyof AdapterCapabilityMap;

/** 编译期保证 CapabilityId 与接口映射一致。 */
export type _AssertCapabilityParity = CapabilityId extends AdapterCapabilityId
  ? AdapterCapabilityId extends CapabilityId
    ? true
    : never
  : never;
