/**
 * 交易与收据模型（见 docs/architecture/domain-model.md 第 4.5 节、
 * docs/architecture/transaction-lifecycle.md）。
 *
 * 禁止在本文件引入任何私钥、助记词或凭证字段。
 */
import type { ChainId, DecimalUint, Iso8601 } from './primitives.js';
import type { AccountRef } from './account.js';
import type { AssetRef } from './asset.js';
import type { BlockRef, FinalityLevel, FinalityState } from './block.js';
import type { DfrError } from './errors.js';

export type TransactionRef =
  | { kind: 'hash'; hash: string }
  | { kind: 'id'; id: string };

export type TransactionStatus =
  | 'built'
  | 'simulated'
  | 'signed'
  | 'broadcast'
  | 'pending'
  | 'included'
  | 'confirmed'
  | 'finalized'
  | 'failed'
  | 'reverted'
  | 'dropped'
  | 'replaced'
  | 'unknown'
  /**
   * 被**显式作废**的未广播交易（ADR-037）。
   *
   * 只对 `built` / `simulated` 可达：`signed` 及以上**永不**进入本状态，
   * 因此"已签名/已广播的 nonce 不可复用"这条资金安全约束不受影响。
   */
  | 'abandoned';

export interface Transaction {
  schemaVersion: '1';
  ref: TransactionRef;
  chain: ChainId;
  status: TransactionStatus;
  blockRef?: BlockRef;
  from?: AccountRef;
  to?: AccountRef;
  value?: Amount;
  fee?: Amount;
  /** EVM nonce；其他链可省略。 */
  nonce?: DecimalUint;
  /** 已获得的确认为十进制字符串，避免大数问题。 */
  confirmations?: DecimalUint;
  error?: DfrError;
  observedAt?: Iso8601;
  /**
   * 链特定原始数据。仅内部使用：
   * - 不进入公开 HTTP 响应；
   * - 不进入日志；
   * - 调用方不得依赖其结构。
   */
  raw?: unknown;
}

export interface Amount {
  asset: AssetRef;
  amount: DecimalUint;
}

export interface Receipt {
  ref: TransactionRef;
  chain: ChainId;
  /** 是否执行成功（EVM receipt.status == 1）。 */
  success: boolean;
  blockRef?: BlockRef;
  /** 消耗的 gas 或计算资源，十进制字符串。 */
  gasUsed?: DecimalUint;
  /**
   * 实际费用（含小费）。审计修正 A-21：改用 `Amount` 以携带计价资产，
   * 旧版本是裸 DecimalUint，消费方无法知道费用用的是哪个币种。
   */
  effectiveFee?: Amount;
  logs?: readonly ChainLog[];
  /** 失败原因（已脱敏）。 */
  revertReason?: string;
}

export interface ChainLog {
  /** EVM 日志索引（`logIndex`）。 */
  index?: DecimalUint;
  address?: string;
  /** 事件 topic / Solana program 标识。 */
  topics?: readonly string[];
  data?: string;
  /** 已解码的事件参数（仅当 ABI 已知时）。 */
  decoded?: Record<string, unknown>;
  /** 该日志所在区块（`contract.logs` 查询需要；ADR-034）。 */
  blockRef?: BlockRef;
  /** 区块内交易哈希与交易内日志序号。 */
  txHash?: string;
  txIndex?: DecimalUint;
  /** reorg 后作废的日志（`eth_getLogs` 的 removed 标志）。 */
  removed?: boolean;
}

/* ------------------------------------------------------------------ */
/* 交易生命周期：build / simulate / sign / broadcast / confirm        */
/* ------------------------------------------------------------------ */

export interface TransactionRequest {
  chain: ChainId;
  from: AccountRef;
  to?: AccountRef;
  value?: Amount;
  /** 十六进制（EVM）或 base64（Solana）编码的调用数据。 */
  data?: string;
  maxFee?: DecimalUint;
  /** EVM nonce；省略时由 build 阶段显式推导并写入 meta。 */
  nonce?: DecimalUint;
  /**
   * Solana recent blockhash；省略时由 build 阶段取链上最新（ADR-033）。
   * 引擎已分配排序前提时会**注入**该字段，确保租约与载荷一致。
   */
  recentBlockhash?: string;
  commitment?: string;
  options?: TransactionOptions;
}

export interface TransactionOptions {
  /** 默认 true；模拟失败必须阻止广播。 */
  simulateBeforeBroadcast?: boolean;
  /** 默认不等待最终性。类型为有序目标等级（审计修正 A-10）。 */
  waitForFinality?: FinalityLevel;
  idempotencyKey?: string;
}

export interface UnsignedTransaction {
  schemaVersion: '1';
  chain: ChainId;
  /** 不透明载荷，仅生成它的 Adapter 能解释。 */
  payload: string;
  meta: UnsignedTransactionMeta;
}

export interface UnsignedTransactionMeta {
  /**
   * 载荷的编码方式（审计修正 A-22）。旧版本未声明编码，二进制载荷只能靠约定。
   */
  encoding?: 'hex' | 'base64';
  requiresNonce?: DecimalUint;
  chainIdForSigning?: string;
  /** Solana recent blockhash。 */
  recentBlockhash?: string;
  expiresAt?: Iso8601;
  feeEstimate?: Amount;
  /** 需要调用方注意的风险提示，例如目标地址为新地址。 */
  warnings?: readonly string[];
}

export interface SignedTransaction {
  schemaVersion: '1';
  chain: ChainId;
  unsigned: UnsignedTransaction;
  /** 已签名载荷。禁止写入日志、错误详情或数据库明文存储以外的位置。 */
  signedPayload: string;
  /** 广播前用于去重的预期哈希。 */
  expectedHash: string;
  /** 仅标识签名来源，例如 "external:wallet"，不是凭证。 */
  signerRef?: string;
}

export interface SimulationResult {
  success: boolean;
  /** 预计消耗（EVM gas / Solana compute units）。 */
  estimatedCost?: DecimalUint;
  /** 预计费用。 */
  estimatedFee?: Amount;
  revertReason?: string;
  /** 状态变更摘要，供调用方展示或策略判断。 */
  stateChanges?: readonly StateChange[];
  warnings?: readonly string[];
}

export interface StateChange {
  kind: 'balance' | 'allowance' | 'storage' | 'account' | 'unknown';
  account?: string;
  asset?: AssetRef;
  before?: string;
  after?: string;
  note?: string;
}

export interface BroadcastResult {
  ref: TransactionRef;
  status: TransactionStatus;
  accepted: boolean;
  /** 广播节点返回的原始标识（已脱敏）。 */
  providerId?: string;
  /**
   * 本次广播是否为重播（审计修正 A-06）。
   *
   * `dropped → broadcast` 的回边由 transaction-lifecycle.md 定义并要求携带该标记，
   * 但旧版本契约中没有承载它的字段，规范要求了一个不存在的属性。
   */
  rebroadcast?: boolean;
  observedAt: Iso8601;
}

/**
 * 广播选项（审计修正 A-06）。
 *
 * `broadcast()` 旧签名只有 `(ctx, signed)`，无法传入重播标记或幂等键；
 * 这些是广播调用本身的属性，不属于已签名交易，因此放在选项参数上。
 */
export interface BroadcastOptions {
  /** 同一 nonce 的重播；用于把 `dropped` 交易重新提交。 */
  rebroadcast?: boolean;
  /** 幂等键，与 HTTP 层的 Idempotency-Key 对应。 */
  idempotencyKey?: string;
  /**
   * 记录里的发送方（DFR-M1-C03a）。
   *
   * 与 `SimulationOptions.from` 同源：`UnsignedTransaction` / `SignedTransaction`
   * 都**不含**发送方，而"签名恢复出的 from 必须等于当初预留 nonce 的那个账户"
   * 只能由记录提供。Adapter 拿到它才能做链语义校验，Core/Gateway 只负责搬运。
   */
  expectedFrom?: AccountRef;
  /**
   * 记录里保存的**未签名**载荷（真值来源）。
   *
   * 客户端会把 build 返回的 unsigned 一起回传，但那只是回声；Adapter 必须与记录比对，
   * 否则"换参数但复用同一 transactionId"无法被发现（m1-api-contract 第 3 节）。
   */
  expectedUnsignedPayload?: string;
}

export interface ConfirmRequest {
  chain: ChainId;
  ref: TransactionRef;
  /** 最低可接受的最终性，默认由 Chain Registry 决定。有序目标等级（审计修正 A-10）。 */
  minFinality?: FinalityLevel;
  timeoutMs?: number;
}

export interface ConfirmationResult {
  ref: TransactionRef;
  status: TransactionStatus;
  finality: FinalityState;
  /** 实际评估目标；未取得观测（例如 lease 被其他 owner 持有）时可省略。 */
  requiredFinality?: FinalityLevel;
  blockRef?: BlockRef;
  canonicalBlockHash?: string;
  confirmations?: DecimalUint;
  /** true 表示在超时前达到要求；false 表示仍在跟踪。 */
  reached: boolean;
}
