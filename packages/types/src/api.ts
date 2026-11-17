/**
 * HTTP 层 DTO（见 docs/api/openapi.yaml、ADR-009）。
 *
 * JSON 字段一律 camelCase；金额与数值一律十进制字符串。
 *
 * 响应封套规则（审计修正 A-16）：**每个**成功响应都必须携带 `requestId`，
 * 便于跨日志与 trace 检索。旧版本只有 balance / block / transaction 三类响应带
 * `requestId`，列表类响应缺失，导致排障时无法把响应关联到请求。
 */
import type { ChainId, Cursor, DecimalUint, Iso8601, RequestId, TransactionId } from './primitives.js';
import type { Chain } from './chain.js';
import type { Balance } from './asset.js';
import type { Block, FinalityLevel } from './block.js';
import type {
  ConfirmationResult,
  SimulationResult,
  SignedTransaction,
  Transaction,
  TransactionStatus,
  UnsignedTransaction,
} from './transaction.js';
import type { DfrError, DfrErrorCode, ErrorCategory } from './errors.js';

export interface Page<T> {
  items: readonly T[];
  /** 不透明游标，客户端不得解析。 */
  nextCursor?: Cursor;
  hasMore: boolean;
}

/** RFC 9457 Problem Details + DFR 扩展字段。 */
export interface DfrErrorResponse {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  dfr_code: DfrErrorCode;
  category: ErrorCategory;
  retryable: boolean;
  safe_to_retry: boolean;
  request_id: string;
  chain?: string;
  provider?: string;
  details?: Record<string, unknown>;
  chain_error?: { code?: string; message?: string };
}

export interface ListChainsResponse {
  items: readonly Chain[];
  requestId: RequestId;
}

export interface GetBalanceResponse {
  balance: Balance;
  requestId: RequestId;
  observedAt: Iso8601;
}

export interface GetBlockResponse {
  block: Block;
  requestId: RequestId;
}

export interface GetTransactionResponse {
  transaction: Transaction;
  requestId: RequestId;
}

/**
 * M1 写端点请求体（见 docs/architecture/m1-api-contract.md 第 2 节）。
 */
export interface ConfirmTransactionRequest {
  /** 与 path 上的 txHash 共同定位交易；chain 只在请求体出现一次。 */
  chain: ChainId;
  /** 最低可接受的最终性；省略时由该 chain 的 Registry 策略决定。 */
  minFinality?: FinalityLevel;
  /** 最长等待毫秒数；省略时取默认值，上界由 Gateway 强制。 */
  timeoutMs?: number;
}

export interface BroadcastTransactionRequest {
  /** build 返回的内部执行标识 txn_<ULID>，用于定位已保存的 unsigned transaction。 */
  transactionId: TransactionId;
  signedTransaction: SignedTransaction;
  /** 默认 false；仅 dropped 状态显式传 true 才重播。 */
  rebroadcast?: boolean;
}

/**
 * M1 写端点成功响应封套（见 docs/architecture/m1-api-contract.md 第 1 节）。
 *
 * 规则：写端点**不得**直接返回裸领域对象。每个成功响应都必须携带 `requestId`，
 * 并用 `transactionId` 暴露 DFR 内部执行标识（build/simulate/broadcast）；
 * confirm 由 path hash 定位，因此封套内不重复携带 transactionId。
 */
export interface BuildTransactionResponse {
  /** DFR 内部执行标识 txn_<ULID>，与链上 txHash 分离。 */
  transactionId: TransactionId;
  unsignedTransaction: UnsignedTransaction;
  requestId: RequestId;
}

/**
 * `POST /v1/transactions/preflight` 的成功响应（ADR-037 方案 B）。
 *
 * `unsignedTransaction` 是**预览**：它建立在只读的 pending nonce 之上，没有租约保护，
 * 因此**不可用于签名与广播**。要真正提交必须另走 build → simulate → 签名 → broadcast。
 *
 * `observedNonce` 是本次预检**未**占用的 pending nonce，仅供展示。
 */
export interface PreflightTransactionResponse {
  unsignedTransaction: UnsignedTransaction;
  /** 只读模拟结果；回滚以 `success=false` 表达，不抛错（与 simulate 一致）。 */
  simulation: SimulationResult;
  observedNonce?: DecimalUint;
  requestId: RequestId;
}

/**
 * `POST /v1/transactions/{transactionId}/abandon` 的成功响应（ADR-037 方案 A）。
 *
 * `leaseReleased` 表示**本次**是否真的释放了 nonce 租约；幂等重放时为 `false`。
 */
export interface AbandonTransactionResponse {
  transactionId: TransactionId;
  status: 'abandoned';
  leaseReleased: boolean;
  nonce?: DecimalUint;
  requestId: RequestId;
}

export interface SimulateTransactionResponse {
  transactionId: TransactionId;
  simulation: SimulationResult;
  requestId: RequestId;
}

/**
 * simulate 的 HTTP 请求体（DFR-M1-B08；见 m1-api-contract 第 2 节）。
 *
 * 必须携带 build 返回的 `transactionId` 与 `UnsignedTransaction`：服务端据此定位
 * 已保存记录并做逐字节绑定校验。**不接受**"另带一个与记录不一致的载荷"。
 */
export interface SimulateTransactionRequest {
  transactionId: TransactionId;
  unsignedTransaction: UnsignedTransaction;
}

export interface BroadcastTransactionResponse {
  transactionId: TransactionId;
  broadcast: BroadcastTransactionOutcome;
  requestId: RequestId;
}

/**
 * broadcast 成功封套内的广播结果（DFR-M1-E03 契约修正）。
 *
 * 为什么不是 `BroadcastResult`：`BroadcastResult` 是 **Adapter 能力**的返回类型
 * （携带 `ref` 与 `providerId`）。HTTP 响应暴露的是 **TransactionEngine 的公开结果**，
 * 它刻意不返回 `providerId`（Provider 身份属内部实现细节），并把 `txHash` 直接放在顶层
 * ——confirm 端点的 path 参数就是 `txHash`，调用方拿到响应即可继续确认，无需再解一层 `ref`。
 *
 * 该类型必须与 `@dfr/transaction` 的 `BroadcastTransactionResult` 一致；Gateway handler
 * 以本类型标注响应体，因此不一致会在 `pnpm typecheck` 直接失败（见 handlers/write.ts）。
 * 修正前 OpenAPI/SDK 声明的是 `BroadcastResult`，与实现漂移且无测试覆盖（E03 发现）。
 */
export interface BroadcastTransactionOutcome {
  transactionId: TransactionId;
  status: TransactionStatus;
  /** 链上交易哈希；即使广播回执异常也回退为签名的 expectedHash。 */
  txHash: string;
  accepted: boolean;
  /** 仅在显式 rebroadcast 时为 true（dropped→broadcast 回边）。 */
  rebroadcast?: boolean;
  observedAt: Iso8601;
}

export interface ConfirmTransactionResponse {
  confirmation: ConfirmationResult;
  requestId: RequestId;
}

/** 内部使用的错误包装，HTTP 层负责转换为 DfrErrorResponse。 */
export interface DfrErrorEnvelope {
  error: DfrError;
  status: number;
  instance?: string;
}
