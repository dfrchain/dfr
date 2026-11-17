/**
 * M1 写路径离线 E2E 用的**测试替身** Store（DFR-M1-B10）。
 *
 * 为什么存在：`DfrCore` 在 M1 里程碑要求完整的交易 Store，而 DFR 刻意**没有**
 * 提供生产用 in-memory Store（M1 启用广播时必须持久化，见 ADR-014）。为了让
 * "SDK → Gateway → Core → Adapter → TransactionEngine" 这条链路能在离线门禁里
 * 被真实驱动，本文件提供语义对齐的行为替身。
 *
 * 三条边界，务必遵守：
 * 1. **不是生产实现**：不跨重启、不跨进程、无真实并发控制。生产路径必须用
 *    `@dfr/storage-postgres`（`pnpm test:db` 覆盖）；
 * 2. **语义对齐规范**：行为按 `docs/architecture/m1-storage-model.md` 与
 *    Store 端口的判别联合实现；这里不"发明"新的失败分支；
 * 3. **不碰 Secret**：不保存 `signedPayload`，与 `TransactionRecord` 的字段集一致。
 */
import type {
  AdvanceNonceLeaseResult,
  BeginIdempotencyInput,
  BeginIdempotencyResult,
  CompleteIdempotencyInput,
  CompleteIdempotencyResult,
  CreateTransactionInput,
  CreateTransactionResult,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyStore,
  ListRecoverableInput,
  NonceLease,
  NonceLeaseRef,
  NonceStore,
  PruneExpiredIdempotencyInput,
  ReleaseNonceLeaseResult,
  ReserveNonceInput,
  ReserveNonceResult,
  TrackerLeaseStore,
  TransactionRecord,
  TransactionStore,
  TransitionTransactionInput,
  TransitionTransactionResult,
  AcquireTrackerLeaseInput,
  AcquireTrackerLeaseResult,
  ListRecoverableTrackerLeasesInput,
  ReleaseTrackerLeaseInput,
  ReleaseTrackerLeaseResult,
  RenewTrackerLeaseInput,
  RenewTrackerLeaseResult,
  TrackerLease,
} from '@dfr/transaction';
import type { ChainId, DecimalUint, Iso8601 } from '@dfr/types';

const TERMINAL = new Set(['finalized', 'failed', 'reverted', 'dropped', 'replaced']);

export interface InMemoryStores {
  readonly transaction: TransactionStore;
  readonly idempotency: IdempotencyStore;
  readonly nonce: NonceStore;
  readonly tracker: TrackerLeaseStore;
}

/** 注入时钟，保证租约过期等行为在测试里确定。 */
export function createInMemoryTransactionStores(
  now: () => Date = () => new Date(),
): InMemoryStores {
  const iso = (): Iso8601 => now().toISOString() as Iso8601;
  const plusMs = (ms: number): Iso8601 => new Date(now().getTime() + ms).toISOString() as Iso8601;

  /* ------------------------------ transactions ------------------------------ */

  const records = new Map<string, TransactionRecord>();

  const transaction: TransactionStore = {
    async create(input: CreateTransactionInput): Promise<CreateTransactionResult> {
      const existing = records.get(input.record.transactionId);
      if (existing !== undefined) return { kind: 'already_exists', record: existing };
      records.set(input.record.transactionId, input.record);
      return { kind: 'created', record: input.record };
    },

    async get(transactionId) {
      return records.get(transactionId) ?? null;
    },

    async getByHash(chain, txHash) {
      return [...records.values()].find((record) => record.chain === chain &&
        (record.txHash === txHash || record.expectedHash === txHash)) ?? null;
    },

    async transition(input: TransitionTransactionInput): Promise<TransitionTransactionResult> {
      const current = records.get(input.transactionId);
      if (current === undefined) return { kind: 'not_found' };
      if (current.stateVersion !== input.expectedVersion) {
        return { kind: 'version_conflict', current };
      }
      if (current.status !== input.expectedStatus) {
        return { kind: 'status_conflict', current };
      }
      const patch = input.patch ?? {};
      const { blockRef: patchBlockRef, canonicalBlockHash: patchBlockHash, ...otherPatch } = patch;
      const { blockRef: currentBlockRef, canonicalBlockHash: currentBlockHash, ...currentWithoutAnchors } = current;
      const next: TransactionRecord = {
        ...currentWithoutAnchors,
        ...otherPatch,
        ...(patchBlockRef === null ? {} : patchBlockRef !== undefined
          ? { blockRef: patchBlockRef }
          : currentBlockRef !== undefined ? { blockRef: currentBlockRef } : {}),
        ...(patchBlockHash === null ? {} : patchBlockHash !== undefined
          ? { canonicalBlockHash: patchBlockHash }
          : currentBlockHash !== undefined ? { canonicalBlockHash: currentBlockHash } : {}),
        status: input.toStatus,
        stateVersion: (BigInt(current.stateVersion) + 1n).toString(10) as DecimalUint,
        updatedAt: iso(),
      };
      records.set(input.transactionId, next);
      return { kind: 'applied', record: next };
    },

    async listRecoverable(input: ListRecoverableInput) {
      const all = [...records.values()].sort((a, b) =>
        a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0,
      );
      const filtered = all.filter((record) =>
        input.statuses !== undefined
          ? input.statuses.includes(record.status)
          : !TERMINAL.has(record.status),
      );
      const after = input.afterTransactionId;
      // ADR-023：`updatedAfter` 是查询条件（不是取回后再过滤），与 Postgres 实现语义一致。
      const updatedAfter = input.updatedAfter;
      const inWindow =
        updatedAfter === undefined
          ? filtered
          : filtered.filter((r) => r.updatedAt >= updatedAfter);
      const start = after === undefined ? 0 : inWindow.findIndex((r) => r.transactionId > after);
      return (start === -1 ? [] : inWindow.slice(start)).slice(0, input.limit);
    },
  };

  /* ------------------------------ idempotency ------------------------------ */

  const scopes = new Map<string, IdempotencyRecord>();
  const scopeKey = (scope: IdempotencyScope): string =>
    `${scope.projectId}\u0000${scope.chain}\u0000${scope.key}`;

  const idempotency: IdempotencyStore = {
    async begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult> {
      const key = scopeKey(input.scope);
      const existing = scopes.get(key);
      if (existing === undefined) {
        const fresh: IdempotencyRecord = {
          scope: input.scope,
          fingerprint: input.fingerprint,
          state: 'in_flight',
          ownerToken: input.ownerToken,
          leaseExpiresAt: plusMs(input.leaseTtlMs),
          expiresAt: plusMs(24 * 60 * 60 * 1000),
        };
        scopes.set(key, fresh);
        return { kind: 'acquired', record: fresh };
      }
      if (existing.fingerprint !== input.fingerprint) {
        return { kind: 'conflict', record: existing };
      }
      if (existing.state === 'completed') {
        return { kind: 'replayed', record: existing };
      }
      if (new Date(existing.leaseExpiresAt).getTime() <= now().getTime()) {
        // 进程崩溃后的接管：换 owner token，旧执行者无法回写。
        const taken: IdempotencyRecord = {
          ...existing,
          ownerToken: input.ownerToken,
          leaseExpiresAt: plusMs(input.leaseTtlMs),
        };
        scopes.set(key, taken);
        return { kind: 'acquired', record: taken };
      }
      return {
        kind: 'in_flight',
        record: existing,
        retryAfterMs: new Date(existing.leaseExpiresAt).getTime() - now().getTime(),
      };
    },

    async complete(input: CompleteIdempotencyInput): Promise<CompleteIdempotencyResult> {
      const key = scopeKey(input.scope);
      const existing = scopes.get(key);
      if (existing === undefined) return { kind: 'not_found' };
      if (existing.ownerToken !== input.ownerToken) return { kind: 'lost_ownership' };
      const completed: IdempotencyRecord = {
        ...existing,
        state: 'completed',
        statusCode: input.statusCode,
        ...(input.responseBody !== undefined ? { responseBody: input.responseBody } : {}),
        ...(input.transactionId !== undefined ? { transactionId: input.transactionId } : {}),
      };
      scopes.set(key, completed);
      return { kind: 'completed', record: completed };
    },

    async get(scope: IdempotencyScope) {
      return scopes.get(scopeKey(scope)) ?? null;
    },

    async pruneExpired(input: PruneExpiredIdempotencyInput) {
      const cutoff = new Date(input.now ?? iso()).getTime();
      let removed = 0;
      for (const [key, record] of scopes) {
        if (new Date(record.expiresAt).getTime() <= cutoff && removed < input.limit) {
          scopes.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };

  /* ------------------------------ nonce ------------------------------ */

  const accountKey = (chain: ChainId, address: string): string => `${chain}\u0000${address}`;
  const leaseKey = (chain: ChainId, address: string, nonce: DecimalUint): string =>
    `${chain}\u0000${address}\u0000${nonce}`;
  const nextNonce = new Map<string, DecimalUint>();
  const leases = new Map<string, NonceLease>();

  function activeLease(ref: NonceLeaseRef): NonceLease | undefined {
    const lease = leases.get(leaseKey(ref.chain, ref.account.address, ref.nonce));
    if (lease === undefined) return undefined;
    if (lease.status === 'released' || lease.status === 'expired') return undefined;
    if (new Date(lease.expiresAt).getTime() <= now().getTime()) return undefined;
    return lease;
  }

  const nonce: NonceStore = {
    async reserve(input: ReserveNonceInput): Promise<ReserveNonceResult> {
      const aKey = accountKey(input.chain, input.account.address);

      // 规范（storage model §4）把 nonce account 行当作同一账户的串行化点。
      // 交易行在 build 成功后才创建，因此这里**不**要求交易行存在。
      const existingForTx = [...leases.values()].find(
        (lease) => lease.transactionId === input.transactionId,
      );
      if (existingForTx !== undefined) return { kind: 'reused', lease: existingForTx };

      const local = nextNonce.get(aKey) ?? ('0' as DecimalUint);
      const candidate =
        BigInt(input.chainPendingNonce) > BigInt(local)
          ? input.chainPendingNonce
          : local;

      const taken = activeLease({
        chain: input.chain,
        account: input.account,
        nonce: candidate,
        transactionId: input.transactionId,
      });
      if (taken !== undefined) return { kind: 'conflict', lease: taken };

      const lease: NonceLease = {
        chain: input.chain,
        account: input.account,
        nonce: candidate,
        transactionId: input.transactionId,
        status: 'reserved',
        expiresAt: plusMs(input.leaseTtlMs),
      };
      leases.set(leaseKey(input.chain, input.account.address, candidate), lease);
      nextNonce.set(aKey, (BigInt(candidate) + 1n).toString(10) as DecimalUint);
      return { kind: 'reserved', lease };
    },

    async markBroadcast(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult> {
      return advance(ref, 'broadcast');
    },

    async markConsumed(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult> {
      return advance(ref, 'consumed');
    },

    async releaseIfSafe(ref: NonceLeaseRef): Promise<ReleaseNonceLeaseResult> {
      const lease = leases.get(leaseKey(ref.chain, ref.account.address, ref.nonce));
      if (lease === undefined) return { kind: 'not_found' };
      if (ref.transactionId !== lease.transactionId) return { kind: 'forbidden', lease, reason: 'not_owner' };
      if (lease.status === 'broadcast' || lease.status === 'consumed') {
        return { kind: 'forbidden', lease, reason: 'signed_or_broadcast' };
      }
      const released: NonceLease = { ...lease, status: 'released' };
      leases.set(leaseKey(ref.chain, ref.account.address, ref.nonce), released);
      return { kind: 'released', lease: released };
    },

    async releaseExpiredOrphaned(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
        throw new RangeError('limit must be 1..500');
      }
      let released = 0;
      for (const [key, lease] of leases) {
        if (released >= input.limit) break;
        if (
          lease.status === 'reserved' &&
          new Date(lease.expiresAt).getTime() <= now().getTime() &&
          !records.has(lease.transactionId)
        ) {
          leases.set(key, { ...lease, status: 'released' });
          released += 1;
        }
      }
      return released;
    },
  };

  function advance(ref: NonceLeaseRef, status: 'broadcast' | 'consumed'): AdvanceNonceLeaseResult {
    const key = leaseKey(ref.chain, ref.account.address, ref.nonce);
    const lease = leases.get(key);
    if (lease === undefined || ref.transactionId !== lease.transactionId) return { kind: 'not_found' };
    // consumed 是终态，迟到的 broadcast 不得把它降级。
    if (lease.status === 'consumed' && status === 'broadcast') {
      return { kind: 'updated', lease };
    }
    const next: NonceLease = { ...lease, status };
    leases.set(key, next);
    return { kind: 'updated', lease: next };
  }

  /* ------------------------------ tracker ------------------------------ */

  const trackerLeases = new Map<string, TrackerLease>();

  const tracker: TrackerLeaseStore = {
    async acquire(input: AcquireTrackerLeaseInput): Promise<AcquireTrackerLeaseResult> {
      const key = `${input.chain}\u0000${input.txHash}`;
      const existing = trackerLeases.get(key);
      if (existing !== undefined && new Date(existing.leaseExpiresAt).getTime() > now().getTime()) {
        return { kind: 'held_by_other', lease: existing };
      }
      const lease: TrackerLease = {
        chain: input.chain,
        txHash: input.txHash,
        ownerToken: input.ownerToken,
        leaseExpiresAt: plusMs(input.leaseTtlMs),
        heartbeatAt: iso(),
      };
      trackerLeases.set(key, lease);
      return { kind: 'acquired', lease };
    },

    async renew(input: RenewTrackerLeaseInput): Promise<RenewTrackerLeaseResult> {
      const key = `${input.chain}\u0000${input.txHash}`;
      const existing = trackerLeases.get(key);
      if (existing === undefined || existing.ownerToken !== input.ownerToken) {
        return { kind: 'lost' };
      }
      const renewed: TrackerLease = {
        ...existing,
        leaseExpiresAt: plusMs(input.leaseTtlMs),
        heartbeatAt: iso(),
      };
      trackerLeases.set(key, renewed);
      return { kind: 'renewed', lease: renewed };
    },

    async release(input: ReleaseTrackerLeaseInput): Promise<ReleaseTrackerLeaseResult> {
      const key = `${input.chain}\u0000${input.txHash}`;
      const existing = trackerLeases.get(key);
      if (existing === undefined || existing.ownerToken !== input.ownerToken) {
        return { kind: 'lost' };
      }
      trackerLeases.delete(key);
      return { kind: 'released' };
    },

    async listRecoverable(input: ListRecoverableTrackerLeasesInput) {
      return [...trackerLeases.values()]
        .filter(
          (lease) =>
            lease.chain === input.chain &&
            (input.afterTxHash === undefined || lease.txHash > input.afterTxHash),
        )
        .slice(0, input.limit);
    },
  };

  return { transaction, idempotency, nonce, tracker };
}
