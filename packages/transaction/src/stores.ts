/**
 * M1 Store 端口（DFR-M1-A06）。
 *
 * 权威来源：docs/architecture/m1-storage-model.md 第 8 节、ADR-015。
 *
 * 本文件是 Store 接口的**唯一权威位置**。`packages/core/src/stores.ts` 只是
 * 兼容 re-export；`packages/storage-postgres` 提供实现。
 *
 * 三条硬约束：
 *
 * 1. **端口表达行为，不表达表**。方法名来自存储模型第 8 节
 *    （`create / get / transition / listRecoverable` 等），不是 SQL 的映射。
 * 2. **不泄漏驱动类型**。本文件不得出现 `pg`、连接池、SQL 片段或事务句柄；
 *    否则 Core 与测试会被迫依赖具体数据库。实现方负责把驱动细节留在
 *    `packages/storage-postgres` 内。
 * 3. **失败用判别联合表达，不用 `undefined`**。同一个 `undefined` 无法区分
 *    "不存在" / "版本冲突" / "所有权已丢失"，调用方只能猜。
 *
 * 端口方法一律异步：实现是远端的（PostgreSQL），同步签名会掩盖这一事实。
 */

import type { AccountRef, BlockRef, ChainId, DecimalUint, DfrErrorCode, FinalityLevel, Iso8601, RequestId, SequencingLeaseStatus, SequencingToken, Transaction, TransactionId, TransactionRef, TransactionStatus } from '@dfr/types';

/* ================================================================== */
/* TransactionStore                                                   */
/* ================================================================== */

/**
 * 交易记录（存储层事实）。
 *
 * 与领域模型 `Transaction`（链上观测结果）是**两个不同的东西**：
 * 本记录由 DFR 在执行过程中创建与推进，带内部 `transactionId`、请求指纹与
 * 乐观并发版本；`Transaction` 描述链上已经发生的事实。
 * 二者不得互相替代，也不共用一个 Store。
 *
 * 禁止出现 `signedPayload`：M1 明确不持久化签名原文（ADR-015 第 9 条）。
 */
export interface TransactionRecord {
  readonly transactionId: TransactionId;
  /** M1 固定为 `default`，多租户控制面属 M5。 */
  readonly projectId: string;
  readonly chain: ChainId;
  /** 规范化请求体的 SHA-256。 */
  readonly requestFingerprint: string;
  readonly status: TransactionStatus;
  /** 乐观并发令牌；十进制字符串（避免 JS number 精度问题）。每次 CAS +1。 */
  readonly stateVersion: DecimalUint;
  /** 规范化后的发送方地址。 */
  readonly from: AccountRef;
  readonly to?: AccountRef;
  readonly nonce?: DecimalUint;
  /**
   * 链无关的排序前提引用（ADR-033）：EVM 是 nonce，Solana 是 blockhash。
   *
   * 与 `nonce` 的关系：`nonce` 列保留（EVM 现有代码/索引不动）；对 EVM 记录，
   * `sequencingRef.value` 必须等于 `nonce`（由 `TransactionStore.create` 校验）。
   */
  readonly sequencingRef?: SequencingToken;
  /** 未签名载荷。不是 Secret，但禁止写入日志。 */
  readonly unsignedPayload?: string;
  readonly payloadEncoding?: 'hex' | 'base64';
  readonly expectedHash?: string;
  readonly txHash?: string;
  /** included 区块的规范哈希；与 blockRef 中的高度配对用于检测重组。 */
  readonly canonicalBlockHash?: string;
  readonly minFinality?: FinalityLevel;
  readonly blockRef?: BlockRef;
  /** 只存稳定的 DFR 错误码，不存原始错误文本。 */
  readonly errorCode?: DfrErrorCode;
  readonly createdAt: Iso8601;
  readonly updatedAt: Iso8601;
}

export interface CreateTransactionInput {
  readonly record: TransactionRecord;
  /** TX-05: when build uses an idempotency key, creation and claim binding
   * must be a single durable transaction. DB implementations fail closed
   * if the original owner has been taken over or its lease has expired. */
  readonly idempotencyClaim?: {
    readonly scope: IdempotencyScope;
    readonly ownerToken: string;
  };
}

export type CreateTransactionResult =
  | { readonly kind: 'created'; readonly record: TransactionRecord }
  /** 同一 `transactionId` 已存在：返回既有记录，不覆盖。 */
  | { readonly kind: 'already_exists'; readonly record: TransactionRecord };

export interface TransitionTransactionInput {
  readonly transactionId: TransactionId;
  /** 调用方读取到的旧状态与旧版本，同时作为写入条件（禁止 last-write-wins）。 */
  readonly expectedStatus: TransactionStatus;
  readonly expectedVersion: DecimalUint;
  readonly toStatus: TransactionStatus;
  /** 稳定原因码，写入 transition 审计行。 */
  readonly reason: string;
  readonly requestId?: RequestId;
  /** 允许更新的非状态字段。 */
  readonly patch?: TransitionPatch;
}

/** 允许随状态迁移一起更新的字段（白名单，防止顺手写入任意列）。 */
export interface TransitionPatch {
  readonly txHash?: string;
  readonly expectedHash?: string;
  readonly nonce?: DecimalUint;
  readonly blockRef?: BlockRef | null;
  readonly canonicalBlockHash?: string | null;
  readonly minFinality?: FinalityLevel;
  readonly errorCode?: DfrErrorCode;
}

export type TransitionTransactionResult =
  | { readonly kind: 'applied'; readonly record: TransactionRecord }
  | { readonly kind: 'not_found' }
  /** 版本不匹配：调用方基于旧快照写入。必须重新读取，不允许覆盖。 */
  | { readonly kind: 'version_conflict'; readonly current: TransactionRecord }
  /** 状态不匹配：状态机上的边已不适用。 */
  | { readonly kind: 'status_conflict'; readonly current: TransactionRecord };

export interface ListRecoverableInput {
  /** 每批上限。规范要求分页且每批 ≤ 500，禁止无界扫描。 */
  readonly limit: number;
  /** 键集分页游标：上一批最后一条的 transactionId。 */
  readonly afterTransactionId?: TransactionId;
  /** 默认由实现取非终态集合；显式传入用于定向巡检。 */
  readonly statuses?: readonly TransactionStatus[];
  /**
   * 只返回 `updatedAt >= updatedAfter` 的记录（ADR-023）。
   *
   * 用途：`dropped` 只在有界宽限窗内继续被观测（否则会重新制造"扫描集合只增不减"）。
   * 之所以做成**查询条件**而不是取回后再过滤：后者会让分页游标卡在一整页过期记录上，
   * 每一轮都返回同一批、永远推进不下去。
   */
  readonly updatedAfter?: Iso8601;
  /**
   * 只返回 `updatedAt <= updatedBefore` 的记录（ADR-037 方案 C）。
   *
   * 用途：自动作废**长期没有推进**的 `built`/`simulated` 记录。与 `updatedAfter`
   * 同样必须做进查询——取回后再过滤会让分页游标卡住、每轮返回同一批。
   */
  readonly updatedBefore?: Iso8601;
}

export interface TransactionStore {
  create(input: CreateTransactionInput): Promise<CreateTransactionResult>;
  get(transactionId: TransactionId): Promise<TransactionRecord | null>;
  /** 按链内已广播/预期哈希定位 DFR 交易记录；外部交易返回 null。 */
  getByHash(chain: ChainId, txHash: string): Promise<TransactionRecord | null>;
  transition(input: TransitionTransactionInput): Promise<TransitionTransactionResult>;
  listRecoverable(input: ListRecoverableInput): Promise<readonly TransactionRecord[]>;
}

/* ================================================================== */
/* IdempotencyStore                                                   */
/* ================================================================== */

/** 幂等作用域：同一 `(projectId, chain, key)` 视为同一次逻辑请求。 */
export interface IdempotencyScope {
  readonly projectId: string;
  readonly chain: ChainId;
  readonly key: string;
}

export type IdempotencyState = 'in_flight' | 'completed';

export interface IdempotencyRecord {
  readonly scope: IdempotencyScope;
  /** 请求规范化体的 SHA-256。 */
  readonly fingerprint: string;
  readonly state: IdempotencyState;
  /** 当前执行者随机 token；接管必须换 token，防止旧执行者回写。 */
  readonly ownerToken: string;
  /** 由数据库时钟判断，不用进程时钟。 */
  readonly leaseExpiresAt: Iso8601;
  readonly transactionId?: TransactionId;
  readonly statusCode?: number;
  /** 脱敏后的首次响应体。 */
  readonly responseBody?: unknown;
  /** 记录整体过期时间（默认创建后 24h）。 */
  readonly expiresAt: Iso8601;
}

export interface BeginIdempotencyInput {
  readonly scope: IdempotencyScope;
  readonly fingerprint: string;
  readonly ownerToken: string;
  /** 处理中租约时长；过期后允许别的执行者接管。 */
  readonly leaseTtlMs: number;
}

export type BeginIdempotencyResult =
  /** 首次请求，调用方获得执行权。 */
  | { readonly kind: 'acquired'; readonly record: IdempotencyRecord }
  /** 同键同指纹且已完成：原样重放首次响应，不得重新执行。 */
  | { readonly kind: 'replayed'; readonly record: IdempotencyRecord }
  /** 同键同指纹但仍在处理中：返回 409 + Retry-After，不重复执行。 */
  | { readonly kind: 'in_flight'; readonly record: IdempotencyRecord; readonly retryAfterMs: number }
  /** 同键不同指纹：永久冲突，原记录不得被覆盖。 */
  | { readonly kind: 'conflict'; readonly record: IdempotencyRecord };

export interface CompleteIdempotencyInput {
  readonly scope: IdempotencyScope;
  readonly ownerToken: string;
  readonly statusCode: number;
  readonly responseBody?: unknown;
  readonly transactionId?: TransactionId;
}

export type CompleteIdempotencyResult =
  | { readonly kind: 'completed'; readonly record: IdempotencyRecord }
  /** token 不匹配：执行权已被接管，本次结果必须丢弃。 */
  | { readonly kind: 'lost_ownership' }
  | { readonly kind: 'not_found' };

export interface PruneExpiredIdempotencyInput {
  readonly limit: number;
  /** 注入时钟用于测试；实现默认使用数据库时钟。 */
  readonly now?: Iso8601;
}

export interface IdempotencyStore {
  begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult>;
  complete(input: CompleteIdempotencyInput): Promise<CompleteIdempotencyResult>;
  get(scope: IdempotencyScope): Promise<IdempotencyRecord | null>;
  /** 分批清理过期记录，返回删除条数。 */
  pruneExpired(input: PruneExpiredIdempotencyInput): Promise<number>;
}

/* ================================================================== */
/* NonceStore                                                         */
/* ================================================================== */

export type NonceLeaseStatus = 'reserved' | 'broadcast' | 'consumed' | 'released' | 'expired';

export interface NonceLease {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly nonce: DecimalUint;
  readonly transactionId: TransactionId;
  readonly status: NonceLeaseStatus;
  readonly expiresAt: Iso8601;
}

export interface ReserveNonceInput {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly transactionId: TransactionId;
  /** 链上 pending nonce，由 Adapter 读取；实现取 max(该值, 本地 next_nonce)。 */
  readonly chainPendingNonce: DecimalUint;
  readonly leaseTtlMs: number;
}

export type ReserveNonceResult =
  | { readonly kind: 'reserved'; readonly lease: NonceLease }
  /** 同一 transactionId 重放：返回原租约，不递增 nonce。 */
  | { readonly kind: 'reused'; readonly lease: NonceLease }
  /** nonce 已被其他交易占用。 */
  | { readonly kind: 'conflict'; readonly lease: NonceLease };

export interface NonceLeaseRef {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly nonce: DecimalUint;
  /**
   * B39 安全约束：必须明确绑定交易所有权。
   *
   * `released` 或严格过期的租约可能被安全地重新分配，原有
   * `(chain, account, nonce)` 已不足以证明当前调用者拥有租约（ABA）。
   * Store 必须将 transactionId 与数据库当前持有者匹配才能修改租约。
   * 不匹配时返回 not_found（advance）或 forbidden/not_owner（release）；
   * 缺失或空字符串时一律 fail-closed 返回 not_found（保护旧 JS 调用端）。
   */
  readonly transactionId: TransactionId;
}

export type AdvanceNonceLeaseResult =
  | { readonly kind: 'updated'; readonly lease: NonceLease }
  | { readonly kind: 'not_found' };

export type ReleaseNonceLeaseResult =
  | { readonly kind: 'released'; readonly lease: NonceLease }
  | { readonly kind: 'not_found' }
  /**
   * 拒绝释放。已签名 / 已广播的 nonce 不允许自动释放复用
   * （m1-storage-model §3.4），否则会出现同 nonce 双花式重复广播。
   */
  | { readonly kind: 'forbidden'; readonly lease: NonceLease; readonly reason: NonceReleaseForbiddenReason };

export type NonceReleaseForbiddenReason = 'signed_or_broadcast' | 'not_owner';

export interface ReleaseExpiredOrphanedNonceLeasesInput {
  /** 单轮上限；恢复任务不得执行无界反连接扫描。 */
  readonly limit: number;
}

export interface NonceStore {
  reserve(input: ReserveNonceInput): Promise<ReserveNonceResult>;
  markBroadcast(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult>;
  markConsumed(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult>;
  releaseIfSafe(ref: NonceLeaseRef): Promise<ReleaseNonceLeaseResult>;
  /**
   * 有界清理过期的 reserved 租约：只允许无交易行的孤儿，或从未签名/广播的
   * 终态 reverted 交易（expectedHash/txHash 均未记录）。不触碰未过期租约、
   * signed 或链上执行失败的已签名交易。水位 `next_nonce` 不回退，
   * 后续 reserve 仅通过严格状态/所有权与链上 pending 检查复用已释放空洞。
   */
  releaseExpiredOrphaned(input: ReleaseExpiredOrphanedNonceLeasesInput): Promise<number>;
}

/* ================================================================== */
/* SequencingStore（ADR-032，M3-A01）                                 */
/* ================================================================== */

/**
 * 排序租约（相对于"序号"语义的 NonceLease，这里承载链无关的排序前提）。
 *
 * `token` 是不透明的判别联合：EVM 是 nonce，Solana 是 blockhash。
 * Store **不解释** token 内容，也不做过期判断——过期语义属于链，属于 Adapter。
 *
 * **租约身份是 `transactionId`，不是 token 取值**（ADR-032 与 NonceLease 的关键差异）：
 * 一个 Solana blockhash 合法地服务无数笔交易，因此 `token_value` **不能**唯一标识一条租约。
 * 与之对应，`(chain, account, transactionId)` 唯一确定一行；行一旦建立就**永不改绑**
 * 到别的交易，所以"迟到调用者误更新已复用租约"（ADR-030 的 ABA 场景）在结构上不存在。
 * `tokenValue` 仍然保留在引用里，作为调用方自洽性的防御性断言（不一致即 fail-closed）。
 *
 * `expiresAt` 是**租约 TTL**（本地簿记：这条预约记录保留多久），与 blockhash 的
 * 链上有效期（`lastValidBlockHeight`，按区块高度判定）是两件不同的事。
 */
export interface SequencingLease {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly token: SequencingToken;
  readonly transactionId: TransactionId;
  readonly status: SequencingLeaseStatus;
  readonly expiresAt: Iso8601;
}

export interface SequencingLeaseRef {
  readonly chain: ChainId;
  readonly account: AccountRef;
  /** 租约真身份（行键）。必填：token 取值可被多笔交易共用，不能当身份用。 */
  readonly transactionId: TransactionId;
  /** 调用方声明的 token 取值；与行内不一致时 fail-closed（防御性断言，不作身份）。 */
  readonly tokenValue: string;
}

export interface ReleaseExpiredOrphanedSequencingLeasesInput {
  /** 单轮上限；恢复任务不得执行无界反连接扫描。 */
  readonly limit: number;
}

export interface ReserveSequencingInput {
  readonly chain: ChainId;
  readonly account: AccountRef;
  readonly transactionId: TransactionId;
  /**
   * Adapter 提供的候选 token（它知道本链该取什么：nonce 还是 blockhash）。
   * Store 只负责"同一 (chain, account) 串行化"与持久化。
   */
  readonly token: SequencingToken;
  readonly leaseTtlMs: number;
}

export type ReserveSequencingResult =
  | { readonly kind: 'reserved'; readonly lease: SequencingLease }
  /** 同一 transactionId 已有租约（并发重放）——返回原租约，不重复分配。 */
  | { readonly kind: 'reused'; readonly lease: SequencingLease };

export type ReleaseSequencingResult =
  | { readonly kind: 'released'; readonly lease: SequencingLease }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'forbidden'; readonly lease: SequencingLease; readonly reason: ReleaseSequencingForbiddenReason };

export type ReleaseSequencingForbiddenReason = 'already_consumed' | 'not_owner';

export type AdvanceSequencingResult =
  | { readonly kind: 'updated'; readonly lease: SequencingLease }
  | { readonly kind: 'not_found' };

/**
 * 排序租约 Store（ADR-032 方案 A）。
 *
 * 与 `NonceStore` **并存**：EVM 继续用 NonceStore（已验证、受 ADR-018/030 保护），
 * 本端口先只服务 Solana。统一两者是后续重构，需单独 ADR。
 */
export interface SequencingStore {
  reserve(input: ReserveSequencingInput): Promise<ReserveSequencingResult>;
  /**
   * 标记 token 已被用于一笔已签名/已广播的交易。
   *
   * 这是审计事实（"这个引用真的被用掉了"），不是互斥量：blockhash 可被多笔交易共用，
   * 所以它**不**阻止别的交易继续使用同一个 token。幂等（已是 consumed 再调用返回 `updated`）。
   */
  markConsumed(ref: SequencingLeaseRef): Promise<AdvanceSequencingResult>;
  /**
   * 释放一条**未签名**租约（build 失败/中止的补偿动作），并提交给会话记录。
   *
   * 已 `consumed` 的租约拒绝释放（`forbidden` + `already_consumed`）：一旦被签名/广播，
   * 释放就是掩盖事实。引用与行不匹配时 `forbidden` + `not_owner`（fail-closed）。
   */
  releaseIfSafe(ref: SequencingLeaseRef): Promise<ReleaseSequencingResult>;
  /**
   * 按**租约 TTL** 回收过期且仍为 `reserved` 的租约（进程在 reserve 后崩溃的情形）。
   *
   * 注意这不是"blockhash 过期回收"：blockhash 是否还可用由 Adapter 按链高判定
   * （`isSequencingExpired`）。本方法只清理本地预约记录，`consumed` 永不回收。
   */
  releaseExpiredOrphaned(input: ReleaseExpiredOrphanedSequencingLeasesInput): Promise<number>;
}

/* ================================================================== */
/* TrackerLeaseStore                                                  */
/* ================================================================== */

/** 确认跟踪租约：唯一键 `(chain, txHash)`。 */
export interface TrackerLease {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly ownerToken: string;
  readonly leaseExpiresAt: Iso8601;
  readonly heartbeatAt: Iso8601;
}

export interface AcquireTrackerLeaseInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly ownerToken: string;
  readonly leaseTtlMs: number;
}

export type AcquireTrackerLeaseResult =
  | { readonly kind: 'acquired'; readonly lease: TrackerLease }
  /** 租约有效期内已被其他 owner 持有：single-flight，不得并发跟踪。 */
  | { readonly kind: 'held_by_other'; readonly lease: TrackerLease };

export interface RenewTrackerLeaseInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly ownerToken: string;
  readonly leaseTtlMs: number;
}

export type RenewTrackerLeaseResult =
  | { readonly kind: 'renewed'; readonly lease: TrackerLease }
  /** 已失去所有权（被接管或已释放）：必须立即停止写状态。 */
  | { readonly kind: 'lost' };

export interface ReleaseTrackerLeaseInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly ownerToken: string;
}

export type ReleaseTrackerLeaseResult =
  | { readonly kind: 'released' }
  | { readonly kind: 'lost' };

export interface ListRecoverableTrackerLeasesInput {
  /** 恢复扫描按链分页；txHash 只在链内唯一。 */
  readonly chain: ChainId;
  readonly limit: number;
  readonly afterTxHash?: string;
}

export interface TrackerLeaseStore {
  acquire(input: AcquireTrackerLeaseInput): Promise<AcquireTrackerLeaseResult>;
  renew(input: RenewTrackerLeaseInput): Promise<RenewTrackerLeaseResult>;
  release(input: ReleaseTrackerLeaseInput): Promise<ReleaseTrackerLeaseResult>;
  listRecoverable(
    input: ListRecoverableTrackerLeasesInput,
  ): Promise<readonly TrackerLease[]>;
}

/* ================================================================== */
/* M0 兼容：只读观测缓存                                              */
/* ================================================================== */

/**
 * M0 只读观测缓存。
 *
 * **这不是 M1 的 `TransactionStore`。** M0 的 Core 在只读查询（`getTransaction`）
 * 后把链上观测到的 `Transaction` 放进这个缓存；它没有请求指纹、没有状态机、
 * 没有乐观并发版本，也不参与广播写路径。
 *
 * 迁移时保留原名语义、仅重命名类型（旧名 `TransactionStore` 已被 M1 端口占用），
 * 以避免"M0 缓存"与"M1 引擎记录"被误当成同一个东西。
 *
 * 进程内实现只用于 M0、单元测试与本地演示；M1 一旦启用广播，必须使用
 * 可跨重启恢复的持久化实现（ADR-014）。
 */
export interface TransactionObservationStore {
  put(chain: ChainId, transaction: Transaction): Promise<void>;
  get(chain: ChainId, ref: TransactionRef): Promise<Transaction | undefined>;
  list(chain: ChainId): Promise<readonly Transaction[]>;
}

export class InMemoryTransactionObservationStore implements TransactionObservationStore {
  private readonly byChain = new Map<string, Map<string, Transaction>>();

  private keyOf(ref: TransactionRef): string {
    return ref.kind === 'hash' ? `hash:${ref.hash}` : `id:${ref.id}`;
  }

  async put(chain: ChainId, transaction: Transaction): Promise<void> {
    let bucket = this.byChain.get(chain);
    if (bucket === undefined) {
      bucket = new Map<string, Transaction>();
      this.byChain.set(chain, bucket);
    }
    bucket.set(this.keyOf(transaction.ref), transaction);
  }

  async get(chain: ChainId, ref: TransactionRef): Promise<Transaction | undefined> {
    return this.byChain.get(chain)?.get(this.keyOf(ref));
  }

  async list(chain: ChainId): Promise<readonly Transaction[]> {
    return [...(this.byChain.get(chain)?.values() ?? [])];
  }
}
