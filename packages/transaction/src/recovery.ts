import { newRequestId } from '@dfr/errors';
import type { Iso8601, TransactionId } from '@dfr/types';
import type {
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLeaseStore,
  TransactionRecord,
  TransactionStore,
} from './stores.js';

/** ADR-023：判 dropped 后仍继续观测、允许纠正的默认宽限窗。 */
const DEFAULT_DROPPED_GRACE_MS = 6 * 60 * 60_000;

/** ADR-037 方案 C 的默认作废窗口（30 分钟）。 */
export const DEFAULT_ABANDON_BUILT_AFTER_MS = 30 * 60_000;

/** `reconcileStrandedSigned` 的结构性结论（ADR-040）。 */
export type StrandedSignedReconcileOutcome =
  /** CAS 已落库：记录进入 `unknown`，并已做一次尽力而为的只读观测。 */
  | 'transitioned'
  /** 记录不存在。 */
  | 'not_found'
  /** 记录存在但不在 `signed`（已推进或已终态）：通道不做任何事。 */
  | 'not_signed'
  /** 带 nonce 的 EVM 记录：归 `recoverStaleSigned` 巡检所有，本通道拒绝代劳。 */
  | 'not_applicable'
  /** 缺 `expectedHash` 或 `sequencingRef`：不可验证的记录绝不转换（TX-02 同口径）。 */
  | 'unverifiable'
  /** `updatedAt` 仍在陈旧窗口内：可能有正常在途流程，拒绝迁移。 */
  | 'not_stale'
  /** `expectedHash` 的 tracker 租约被其他 owner 持有：并发恢复/观测进行中。 */
  | 'lease_held'
  /** 租约内复查或 CAS 发现记录已被并发推进：运维应重新对账。 */
  | 'conflict';

type StrandedSignedClass =
  | 'eligible'
  | 'not_signed'
  | 'not_applicable'
  | 'unverifiable'
  | 'not_stale';

/**
 * `reconcileStrandedSigned` 的资格分类（纯函数，迁移前后各跑一次）。
 *
 * 顺序即口径：先状态、再领域（EVM 归巡检）、再可验证性、最后陈旧——
 * 保证"新鲜"不会掩盖"根本不归本通道管"，反之亦然。
 */
function classifyStrandedSigned(
  record: TransactionRecord,
  staleBeforeMs: number,
): StrandedSignedClass {
  if (record.status !== 'signed') return 'not_signed';
  if (record.nonce !== undefined) return 'not_applicable';
  if (record.expectedHash === undefined || record.expectedHash === '' ||
      record.sequencingRef === undefined) {
    return 'unverifiable';
  }
  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt > staleBeforeMs) return 'not_stale';
  return 'eligible';
}

export interface RecoveryDeps {
  readonly transactions: TransactionStore;
  readonly idempotency: IdempotencyStore;
  readonly nonce: NonceStore;
  /**
   * M3-A01/C03：Solana blockhash 排序租约；可选。
   *
   * 只在装配了它的部署里回收过期 `reserved` 租约（进程在 reserve 后崩溃）。
   * 未装配时跳过——EVM-only 部署不需要它。
   */
  readonly sequencing?: SequencingStore;
  readonly trackerLeases: TrackerLeaseStore;
  readonly resolveUnknown: (transactionId: TransactionId) => Promise<void>;
  /** 每个 Gateway 进程的一次性 token；不得复用已失效 worker 的所有权。 */
  readonly ownerToken: () => string;
  readonly leaseTtlMs?: number;
  /**
   * `dropped` 记录继续被观测、允许纠正的宽限窗（ADR-023）。默认 6 小时。
   *
   * 为什么有界：`dropped` 是**判断**，误判需要可纠正；但若永久观测，扫描集合会重新
   * 只增不减、每轮白跑 RPC（这正是 TODO-011 要修的问题）。窗口外的残余风险显式接受。
   */
  readonly droppedGraceMs?: number;
  /** 判定窗口用的时钟；默认 `Date.now`。 */
  readonly clock?: () => number;
  /**
   * `built` / `simulated` 记录在多久**没有推进**之后被自动作废（ADR-037 方案 C）。
   *
   * 为什么需要：方案 A 的显式 `abandon` 只在**调用方记得**时有效；进程崩溃、
   * 网络中断、调用方忘记清理都会留下永久空洞。本巡检是兜底。
   *
   * 默认 30 分钟：明显长于正常 build→签名→广播的人工在环耗时（分钟级），
   * 又短于"卡住一整天"的运维感知阈值。`undefined` 表示**关闭**本巡检
   * （EVM-only 之外或测试场景可显式关掉）。
   */
  readonly abandonBuiltAfterMs?: number;
}

/**
 * 启动恢复：严格分页、每批有限；只解析 unknown，绝不广播。
 *
 * `unknown` 的链上解析可能由多个重启中的进程同时触发。以记录中的
 * expectedHash/txHash 为租约键，只有当前 owner 才能调用解析端口；有效租约被其他
 * owner 持有时立即跳过。回调结束后释放租约，因此这里不是后台跟踪器，也不遗留续租。
 */
export class RecoveryCoordinator {
  constructor(private readonly deps: RecoveryDeps) {}

  async run(input: { limit: number }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }
    let afterTransactionId: TransactionId | undefined;
    let recovered = 0;
    // 三者都是本轮有限清理；任何剩余记录会留给下一次启动/巡检，绝不无界扫描。
    await this.deps.idempotency.pruneExpired({ limit: input.limit });
    await this.deps.nonce.releaseExpiredOrphaned({ limit: input.limit });
    // Solana：回收租约 TTL 已过、仍为 `reserved` 的 blockhash 租约（consumed 永不回收）。
    await this.deps.sequencing?.releaseExpiredOrphaned({ limit: input.limit });
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      if (records.length === 0) return recovered;
      for (const record of records) {
        if (record.status !== 'unknown') continue;
        try {
          if (await this.resolveUnknownWithLease(record)) recovered += 1;
        } catch {
          // A broken RPC observation or tracker-lease operation on one
          // transaction must not block later unknown records and pages.
          // No transaction status is changed by this catch; retry next sweep.
        }
      }
      if (records.length < input.limit) return recovered;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
  }

  /**
   * TX-02 / DB-01: repair stale signed transactions after a process crash.
   *
   * The raw signed payload is deliberately never stored; a signed record
   * therefore MUST NOT be automatically rebroadcast. This sweep only moves
   * an old, verifiable signed EVM record to indeterminate/unknown and then
   * performs the existing chain-side read-only observation.
   *
   * Locking by expectedHash prevents two recovery workers from racing.
   * TransactionStore.transition CAS prevents overwriting a concurrent
   * successful broadcast. The caller chooses the minimum stale interval.
   */
  async recoverStaleSigned(input: {
    readonly limit: number;
    readonly staleAfterMs: number;
    readonly now?: number;
  }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }
    if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 60_000) {
      throw new RangeError('staleAfterMs must be >= 60000');
    }
    const now = input.now ?? this.deps.clock?.() ?? Date.now();
    const updatedBefore = new Date(now - input.staleAfterMs).toISOString() as Iso8601;
    let afterTransactionId: TransactionId | undefined;
    let repaired = 0;
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        statuses: ['signed'],
        updatedBefore,
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      if (records.length === 0) return repaired;
      for (const record of records) {
        const hash = record.expectedHash;
        // Never convert an unverifiable record to dropped. Solana sequencing
        // needs its own blockhash-aware recovery policy; this is EVM-only.
        // That policy is reconcileStrandedSigned below (operator-invoked,
        // ADR-040); this sweep must never auto-transition a Solana record.
        if (record.nonce === undefined || hash === undefined || hash === '') continue;
        const ownerToken = this.deps.ownerToken();
        try {
          const acquired = await this.deps.trackerLeases.acquire({
            chain: record.chain, txHash: hash, ownerToken,
            leaseTtlMs: this.deps.leaseTtlMs ?? 30_000,
          });
          if (acquired.kind === 'held_by_other') continue;
          try {
            const fresh = await this.deps.transactions.get(record.transactionId);
            if (fresh === null || fresh.status !== 'signed' ||
                fresh.expectedHash !== hash || fresh.nonce === undefined) continue;
            const updatedAt = Date.parse(fresh.updatedAt);
            if (!Number.isFinite(updatedAt) || updatedAt > Date.parse(updatedBefore)) continue;
            const transitioned = await this.deps.transactions.transition({
              transactionId: fresh.transactionId,
              expectedStatus: 'signed',
              expectedVersion: fresh.stateVersion,
              toStatus: 'unknown',
              reason: 'broadcast.indeterminate',
              requestId: newRequestId(),
            });
            if (transitioned.kind !== 'applied') continue;
            repaired += 1;
            // A failed RPC observation does not undo the durable unknown
            // transition. The ordinary recovery pass handles it next time.
            try { await this.deps.resolveUnknown(record.transactionId); } catch { /* retry later */ }
          } finally {
            await this.deps.trackerLeases.release({ chain: record.chain, txHash: hash, ownerToken });
          }
        } catch {
          // One bad record does not stop the recovery sweep.
        }
      }
      if (records.length < input.limit) return repaired;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
  }

  /**
   * 运维通道：人工对账后，把一笔**滞留在 `signed` 的 Solana 交易**送入既有
   * `unknown` 对账状态（issue #22 门禁 4 残留项，ADR-040）。
   *
   * 为什么单独存在、而不并入 `recoverStaleSigned`：
   *   - `recoverStaleSigned` 是**定时巡检**，且刻意 EVM-only（见其内注释）。
   *     Solana 的 blockhash 按区块高度过期而非时间，"陈旧"只说明进程大概率
   *     已死，不说明载荷是否曾传播；让巡检自动迁移 Solana 的 `signed` 记录
   *     等于替运维做"放弃这笔已签名交易"的决定。本通道因此**只接受人工
   *     点名**（单个 `transactionId`），不进任何调度器，也没有批量入口。
   *   - 调用前置（人工对账，见 gate-4 对账程序）：运维先以只读方式按签名
   *     查链上状态，确认未上链或 blockhash 已过期后才调用。本方法不复判
   *     链上事实，只执行带门限的持久化迁移。
   *
   * 安全性（与 TX-02 同源）：
   *   - 目标状态只有 `unknown`（既有边 `signed + broadcast.indeterminate`，
   *     与 EVM 巡检同一条边、同一 reason）：之后由既有只读观测/调用方
   *     confirm 解析，本方法不判 `dropped` / `failed`；
   *   - 签名载荷从未落库，本方法没有任何广播入口，也不存在重播路径；
   *   - 陈旧门限（≥ 60 s，与巡检同下限）排除"签名流程其实还活着"；
   *     tracker 租约（按 expectedHash）+ 租约内复查 + CAS 排除并发推进。
   *
   * 结构性拒绝用判别联合返回（运维需要逐项看到结论），不抛错；
   * 存储等基础设施错误照常抛出，不伪装成业务结论。
   */
  async reconcileStrandedSigned(input: {
    readonly transactionId: TransactionId;
    readonly staleAfterMs: number;
    readonly now?: number;
  }): Promise<StrandedSignedReconcileOutcome> {
    if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 60_000) {
      throw new RangeError('staleAfterMs must be >= 60000');
    }
    const now = input.now ?? this.deps.clock?.() ?? Date.now();
    const staleBeforeMs = now - input.staleAfterMs;

    const record = await this.deps.transactions.get(input.transactionId);
    if (record === null) return 'not_found';
    const classified = classifyStrandedSigned(record, staleBeforeMs);
    if (classified !== 'eligible') return classified;

    // classify 已保证 expectedHash 非空（'unverifiable' 已在上方返回）。
    const hash = record.expectedHash as string;
    const ownerToken = this.deps.ownerToken();
    const acquired = await this.deps.trackerLeases.acquire({
      chain: record.chain, txHash: hash, ownerToken,
      leaseTtlMs: this.deps.leaseTtlMs ?? 30_000,
    });
    if (acquired.kind === 'held_by_other') return 'lease_held';
    try {
      const fresh = await this.deps.transactions.get(input.transactionId);
      if (fresh === null) return 'not_found';
      // 租约内复查：分类变化或身份（expectedHash）变化都按冲突收手——
      // 并发签名/广播可能刚推进了这笔记录，运维应重新对账而不是重试到底。
      if (classifyStrandedSigned(fresh, staleBeforeMs) !== 'eligible' ||
          fresh.expectedHash !== hash) {
        return 'conflict';
      }
      const transitioned = await this.deps.transactions.transition({
        transactionId: fresh.transactionId,
        expectedStatus: 'signed',
        expectedVersion: fresh.stateVersion,
        toStatus: 'unknown',
        reason: 'broadcast.indeterminate',
        requestId: newRequestId(),
      });
      if (transitioned.kind !== 'applied') return 'conflict';
      // 与巡检同口径：观测失败不撤销已落库的 unknown 迁移，
      // 常规恢复轮次会继续处理。观测本身只读，绝不广播。
      try { await this.deps.resolveUnknown(fresh.transactionId); } catch { /* retry later */ }
      return 'transitioned';
    } finally {
      await this.deps.trackerLeases.release({ chain: record.chain, txHash: hash, ownerToken });
    }
  }

  /**
   * 自动作废**长期没有推进**的 `built` / `simulated` 记录（ADR-037 方案 C）。
   *
   * 与方案 A 的关系：A 是调用方**显式**作废（正确动作），C 是**兜底**——
   * 进程崩溃/网络中断/调用方忘记时的自愈。两者走同一套语义（释放租约 + 转 `abandoned`）。
   *
   * 严格边界（缺一不可）：
   *   - 只扫 `built` / `simulated`（`signed` 及以上**永不**被本方法触碰——
   *     那会回收已签名交易的 nonce，破坏资金安全）；
   *   - 只处理 `updatedAt` 早于窗口的记录（窗口内可能有正常的在途流程）；
   *   - 有界分页（`limit` 复用调用方的批次上限），不会无界扫描。
   *
   * 返回本轮实际作废的记录数。**失败不抛出**：单条失败留下给下一轮，不因一条坏记录
   * 拖垮整轮巡检（与 `run` 的收尾口径一致）。
   */
  async abandonStaleUnbroadcast(input: {
    readonly limit: number;
    readonly now?: number;
  }): Promise<number> {
    const afterMs = this.deps.abandonBuiltAfterMs;
    // 未配置 = 关闭（显式，而不是静默用某个默认值）。
    if (afterMs === undefined) return 0;
    // Invalid or extremely short windows may abandon transactions while a
    // legitimate user is still signing. Config 0 is converted to undefined
    // (disabled) by the Gateway composition root; direct callers must not
    // interpret 0 as immediate lease reclamation.
    if (!Number.isSafeInteger(afterMs) || afterMs < 60_000 || afterMs > 7 * 24 * 60 * 60_000) {
      throw new RangeError('abandonBuiltAfterMs must be 60000..604800000 or omitted to disable');
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }

    const nowMs = input.now ?? this.deps.clock?.() ?? Date.now();
    const updatedBefore = new Date(nowMs - afterMs).toISOString() as Iso8601;

    let afterTransactionId: TransactionId | undefined;
    let abandoned = 0;
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        statuses: ['built', 'simulated'],
        // 只取**早于**窗口的记录。把它做进查询（而不是取回后过滤）才能让游标推进。
        updatedBefore,
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      if (records.length === 0) break;

      for (const record of records) {
        try {
          // CAS FIRST. A concurrent signer can advance built/simulated to
          // signed after the stale query. Releasing its nonce before checking
          // the status/version would free a LIVE signed transaction's lease,
          // even if our later CAS correctly reports a conflict.
          //
          // The narrow alternative is a temporary reserved-lease leak if
          // cleanup fails after the durable abandoned transition; the normal
          // releaseExpiredOrphaned sweep can safely reclaim that stale lease.
          const moved = await this.deps.transactions.transition({
            transactionId: record.transactionId,
            expectedStatus: record.status,
            expectedVersion: record.stateVersion,
            toStatus: 'abandoned',
            reason: 'abandon.stale',
            requestId: newRequestId(),
          });
          if (moved.kind !== 'applied') continue;
          abandoned += 1;
          try {
            if (record.nonce !== undefined) {
              await this.deps.nonce.releaseIfSafe({
                chain: record.chain,
                account: record.from,
                nonce: record.nonce,
                transactionId: record.transactionId,
              });
            } else if (record.sequencingRef !== undefined && this.deps.sequencing !== undefined) {
              await this.deps.sequencing.releaseIfSafe({
                chain: record.chain,
                account: record.from,
                transactionId: record.transactionId,
                tokenValue: record.sequencingRef.value,
              });
            }
          } catch {
            // The abandoned CAS already committed. Do not hide that fact;
            // the periodic orphan-lease sweep will retry lease cleanup.
          }
        } catch {
          // 单条失败（例如并发下 CAS 冲突）不拖垮整轮；下一轮再处理。
        }
      }

      if (records.length < input.limit) break;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
    return abandoned;
  }

  /**
   * 观测宽限窗内的 `dropped` 记录并尝试纠正（ADR-023）。
   *
   * 与 `unknown` 分开一次扫描，因为两者集合不同、且 `dropped` 需要 `updatedAfter` 时间下界：
   * 把时间条件放进查询（而不是取回后过滤）才能让分页游标正常推进。
   *
   * 返回本轮实际发生收敛（状态被纠正）的记录数。
   */
  async reconcileDropped(input: { limit: number }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }
    const graceMs = this.deps.droppedGraceMs ?? DEFAULT_DROPPED_GRACE_MS;
    const now = this.deps.clock?.() ?? Date.now();
    const updatedAfter = new Date(now - graceMs).toISOString() as Iso8601;

    let afterTransactionId: TransactionId | undefined;
    let corrected = 0;
    for (;;) {
      const records = await this.deps.transactions.listRecoverable({
        limit: input.limit,
        statuses: ['dropped'],
        updatedAfter,
        ...(afterTransactionId !== undefined ? { afterTransactionId } : {}),
      });
      if (records.length === 0) return corrected;
      for (const record of records) {
        // 只有观测能把 dropped 改成别的状态；`resolveUnknown` 内部对 dropped 只做收敛。
        // 计数必须是"状态真的被纠正"，而不是"发生过一次观测"——否则 absent 也会被算成收敛，
        // 指标会虚高且无法反映真实纠正量。
        try {
          const observed = await this.resolveUnknownWithLease(record);
          if (!observed) continue;
          const after = await this.deps.transactions.get(record.transactionId);
          if (after !== null && after.status !== record.status) corrected += 1;
        } catch {
          // A single failed observation, tracker lease or follow-up lookup
          // must not abort dropped correction for other records in this page.
          // Count only a successfully verified transition, never an attempt.
        }
      }
      if (records.length < input.limit) return corrected;
      afterTransactionId = records[records.length - 1]!.transactionId;
    }
  }

  private async resolveUnknownWithLease(record: TransactionRecord): Promise<boolean> {
    const txHash = record.expectedHash ?? record.txHash;
    // 未记录可验证 hash 的 unknown 不可安全地交给 tracker；保留原状态等待人工排查。
    if (txHash === undefined || txHash === '') return false;

    const ownerToken = this.deps.ownerToken();
    const acquired = await this.deps.trackerLeases.acquire({
      chain: record.chain,
      txHash,
      ownerToken,
      leaseTtlMs: this.deps.leaseTtlMs ?? 30_000,
    });
    if (acquired.kind === 'held_by_other') return false;

    try {
      await this.deps.resolveUnknown(record.transactionId);
      return true;
    } finally {
      // 若租约已丢失，Store 会返回 lost；无论如何不得以旧 owner 继续写状态。
      await this.deps.trackerLeases.release({ chain: record.chain, txHash, ownerToken });
    }
  }
}
