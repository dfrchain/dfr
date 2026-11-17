/**
 * Store 端口契约测试（DFR-M1-A06）。
 *
 * 权威来源：docs/architecture/m1-storage-model.md 第 8 节。
 *
 * 本文件做两件事：
 *   1. 用 `implements` 写出一组**最小内存实现**，证明四个端口可被实现、签名可用
 *      ——如果端口不可实现，`pnpm typecheck` 会直接失败；
 *   2. 断言失败路径一律通过 `kind` 判别，不以 `undefined` 表达多种失败原因
 *      （m1-storage-model 第 8 节的明文要求）。
 */
import { describe, expect, it } from 'vitest';
import type {
  AccountRef,
  ChainId,
  DecimalUint,
  Iso8601,
  TransactionId,
} from '@dfr/types';
import {
  InMemoryTransactionObservationStore,
  type AcquireTrackerLeaseInput,
  type AcquireTrackerLeaseResult,
  type AdvanceNonceLeaseResult,
  type BeginIdempotencyInput,
  type BeginIdempotencyResult,
  type CompleteIdempotencyInput,
  type CompleteIdempotencyResult,
  type CreateTransactionInput,
  type CreateTransactionResult,
  type IdempotencyRecord,
  type IdempotencyScope,
  type IdempotencyStore,
  type ListRecoverableInput,
  type ListRecoverableTrackerLeasesInput,
  type NonceLease,
  type NonceLeaseRef,
  type NonceStore,
  type PruneExpiredIdempotencyInput,
  type ReleaseNonceLeaseResult,
  type ReleaseTrackerLeaseInput,
  type ReleaseTrackerLeaseResult,
  type RenewTrackerLeaseInput,
  type RenewTrackerLeaseResult,
  type AdvanceSequencingResult,
  type ReleaseSequencingResult,
  type ReserveNonceInput,
  type ReserveNonceResult,
  type ReserveSequencingInput,
  type ReserveSequencingResult,
  type SequencingLease,
  type SequencingLeaseRef,
  type SequencingStore,
  type TrackerLease,
  type TrackerLeaseStore,
  type TransactionObservationStore,
  type TransactionRecord,
  type TransactionStore,
  type TransitionTransactionInput,
  type TransitionTransactionResult,
} from '../src/stores.js';

const chain = 'ethereum-sepolia' as ChainId;
const txnId = 'txn_01J0000000000000000000000' as TransactionId;
const account: AccountRef = { chain, address: '0x1111111111111111111111111111111111111111' };

const num = (value: string): DecimalUint => value as DecimalUint;
const iso = '2026-10-04T00:00:00Z' as Iso8601;

function record(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    transactionId: txnId,
    projectId: 'default',
    chain,
    requestFingerprint: 'a'.repeat(64),
    status: 'built',
    stateVersion: num('1'),
    from: account,
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 最小内存实现：`implements` 就是端口可实现性的编译期证明            */
/* ------------------------------------------------------------------ */

class FakeTransactionStore implements TransactionStore {
  private readonly rows = new Map<string, TransactionRecord>();

  async create(input: CreateTransactionInput): Promise<CreateTransactionResult> {
    const existing = this.rows.get(input.record.transactionId);
    if (existing !== undefined) return { kind: 'already_exists', record: existing };
    this.rows.set(input.record.transactionId, input.record);
    return { kind: 'created', record: input.record };
  }

  async get(transactionId: TransactionId): Promise<TransactionRecord | null> {
    return this.rows.get(transactionId) ?? null;
  }

  async getByHash(chain: ChainId, txHash: string): Promise<TransactionRecord | null> {
    return [...this.rows.values()].find((record) => record.chain === chain &&
      (record.txHash === txHash || record.expectedHash === txHash)) ?? null;
  }

  async transition(input: TransitionTransactionInput): Promise<TransitionTransactionResult> {
    const current = this.rows.get(input.transactionId);
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
      stateVersion: num(String(Number(current.stateVersion) + 1)),
    };
    this.rows.set(next.transactionId, next);
    return { kind: 'applied', record: next };
  }

  async listRecoverable(input: ListRecoverableInput): Promise<readonly TransactionRecord[]> {
    return [...this.rows.values()].slice(0, input.limit);
  }
}

class FakeIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, IdempotencyRecord>();

  private key(scope: IdempotencyScope): string {
    return `${scope.projectId}|${scope.chain}|${scope.key}`;
  }

  async begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult> {
    const k = this.key(input.scope);
    const existing = this.rows.get(k);
    if (existing === undefined) {
      const created: IdempotencyRecord = {
        scope: input.scope,
        fingerprint: input.fingerprint,
        state: 'in_flight',
        ownerToken: input.ownerToken,
        leaseExpiresAt: iso,
        expiresAt: iso,
      };
      this.rows.set(k, created);
      return { kind: 'acquired', record: created };
    }
    // 不同指纹永不覆盖原记录。
    if (existing.fingerprint !== input.fingerprint) {
      return { kind: 'conflict', record: existing };
    }
    if (existing.state === 'completed') return { kind: 'replayed', record: existing };
    return { kind: 'in_flight', record: existing, retryAfterMs: 1000 };
  }

  async complete(input: CompleteIdempotencyInput): Promise<CompleteIdempotencyResult> {
    const k = this.key(input.scope);
    const existing = this.rows.get(k);
    if (existing === undefined) return { kind: 'not_found' };
    if (existing.ownerToken !== input.ownerToken) return { kind: 'lost_ownership' };
    const done: IdempotencyRecord = {
      ...existing,
      state: 'completed',
      statusCode: input.statusCode,
    };
    this.rows.set(k, done);
    return { kind: 'completed', record: done };
  }

  async get(scope: IdempotencyScope): Promise<IdempotencyRecord | null> {
    return this.rows.get(this.key(scope)) ?? null;
  }

  async pruneExpired(_input: PruneExpiredIdempotencyInput): Promise<number> {
    return 0;
  }
}

class FakeNonceStore implements NonceStore {
  private readonly leases = new Map<string, NonceLease>();

  private key(ref: NonceLeaseRef): string {
    return `${ref.chain}|${ref.account.address}|${ref.nonce}`;
  }

  async reserve(input: ReserveNonceInput): Promise<ReserveNonceResult> {
    const ref: NonceLeaseRef = {
      chain: input.chain,
      account: input.account,
      nonce: input.chainPendingNonce,
      transactionId: input.transactionId,
    };
    const existing = this.leases.get(this.key(ref));
    if (existing !== undefined) {
      return existing.transactionId === input.transactionId
        ? { kind: 'reused', lease: existing }
        : { kind: 'conflict', lease: existing };
    }
    const lease: NonceLease = {
      chain: input.chain,
      account: input.account,
      nonce: input.chainPendingNonce,
      transactionId: input.transactionId,
      status: 'reserved',
      expiresAt: iso,
    };
    this.leases.set(this.key(ref), lease);
    return { kind: 'reserved', lease };
  }

  private advance(ref: NonceLeaseRef, status: NonceLease['status']): AdvanceNonceLeaseResult {
    const k = this.key(ref);
    const lease = this.leases.get(k);
    if (lease === undefined || lease.transactionId !== ref.transactionId) return { kind: 'not_found' };
    const next: NonceLease = { ...lease, status };
    this.leases.set(k, next);
    return { kind: 'updated', lease: next };
  }

  async markBroadcast(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult> {
    return Promise.resolve(this.advance(ref, 'broadcast'));
  }

  async markConsumed(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult> {
    return Promise.resolve(this.advance(ref, 'consumed'));
  }

  async releaseIfSafe(ref: NonceLeaseRef): Promise<ReleaseNonceLeaseResult> {
    const k = this.key(ref);
    const lease = this.leases.get(k);
    if (lease === undefined) return { kind: 'not_found' };
    if (lease.transactionId !== ref.transactionId) return { kind: 'forbidden', lease, reason: 'not_owner' };
    // 已签名或已广播的 nonce 不允许自动释放复用（m1-storage-model §3.4）。
    if (lease.status !== 'reserved') {
      return { kind: 'forbidden', lease, reason: 'signed_or_broadcast' };
    }
    const next: NonceLease = { ...lease, status: 'released' };
    this.leases.set(k, next);
    return { kind: 'released', lease: next };
  }

  async releaseExpiredOrphaned(): Promise<number> {
    return 0;
  }
}

class FakeTrackerLeaseStore implements TrackerLeaseStore {
  private readonly leases = new Map<string, TrackerLease>();

  private key(chainId: ChainId, txHash: string): string {
    return `${chainId}:${txHash}`;
  }

  async acquire(input: AcquireTrackerLeaseInput): Promise<AcquireTrackerLeaseResult> {
    const key = this.key(input.chain, input.txHash);
    const existing = this.leases.get(key);
    if (existing !== undefined && existing.ownerToken !== input.ownerToken) {
      return { kind: 'held_by_other', lease: existing };
    }
    const lease: TrackerLease = {
      chain: input.chain,
      txHash: input.txHash,
      ownerToken: input.ownerToken,
      leaseExpiresAt: iso,
      heartbeatAt: iso,
    };
    this.leases.set(key, lease);
    return { kind: 'acquired', lease };
  }

  async renew(input: RenewTrackerLeaseInput): Promise<RenewTrackerLeaseResult> {
    const existing = this.leases.get(this.key(input.chain, input.txHash));
    if (existing === undefined || existing.ownerToken !== input.ownerToken) {
      return { kind: 'lost' };
    }
    return { kind: 'renewed', lease: existing };
  }

  async release(input: ReleaseTrackerLeaseInput): Promise<ReleaseTrackerLeaseResult> {
    const key = this.key(input.chain, input.txHash);
    const existing = this.leases.get(key);
    if (existing === undefined || existing.ownerToken !== input.ownerToken) {
      return { kind: 'lost' };
    }
    this.leases.delete(key);
    return { kind: 'released' };
  }

  async listRecoverable(
    input: ListRecoverableTrackerLeasesInput,
  ): Promise<readonly TrackerLease[]> {
    return [...this.leases.values()]
      .filter(
        (lease) =>
          lease.chain === input.chain &&
          (input.afterTxHash === undefined || lease.txHash > input.afterTxHash),
      )
      .sort((a, b) => a.txHash.localeCompare(b.txHash))
      .slice(0, input.limit);
  }
}

describe('端口可实现性（编译期由 implements 保证）', () => {
  const stores = {
    transaction: new FakeTransactionStore(),
    idempotency: new FakeIdempotencyStore(),
    nonce: new FakeNonceStore(),
    tracker: new FakeTrackerLeaseStore(),
  };

  it('四个端口都能被最小内存实现实例化', () => {
    for (const [name, impl] of Object.entries(stores)) {
      expect(impl, `${name} 端口未实现`).toBeTruthy();
    }
  });
});

describe('TransactionStore 端口', () => {
  it('create → get 往返；未找到返回 null 而不是 undefined', async () => {
    const store = new FakeTransactionStore();
    expect((await store.create({ record: record() })).kind).toBe('created');
    expect(await store.get(txnId)).toEqual(record());
    expect(await store.get('txn_missing' as TransactionId)).toBeNull();
  });

  it('重复 create 返回 already_exists 且不覆盖既有记录', async () => {
    const store = new FakeTransactionStore();
    await store.create({ record: record({ status: 'built' }) });
    const again = await store.create({ record: record({ status: 'finalized' }) });
    expect(again.kind).toBe('already_exists');
    if (again.kind === 'already_exists') expect(again.record.status).toBe('built');
  });

  it('版本不匹配时返回 version_conflict 并回带当前记录（禁止 last-write-wins）', async () => {
    const store = new FakeTransactionStore();
    await store.create({ record: record({ stateVersion: num('7') }) });
    const result = await store.transition({
      transactionId: txnId,
      expectedStatus: 'built',
      expectedVersion: num('3'),
      toStatus: 'simulated',
      reason: 'simulate.succeeded',
    });
    expect(result.kind).toBe('version_conflict');
    if (result.kind === 'version_conflict') expect(result.current.stateVersion).toBe(num('7'));
  });

  it('状态不匹配时返回 status_conflict（旧快照上的状态边已失效）', async () => {
    const store = new FakeTransactionStore();
    await store.create({ record: record({ status: 'built', stateVersion: num('7') }) });
    const result = await store.transition({
      transactionId: txnId,
      expectedStatus: 'signed',
      expectedVersion: num('7'),
      toStatus: 'broadcast',
      reason: 'broadcast.accepted',
    });
    expect(result.kind).toBe('status_conflict');
  });

  it('版本与状态都匹配时推进状态并把 stateVersion +1', async () => {
    const store = new FakeTransactionStore();
    await store.create({ record: record({ stateVersion: num('7') }) });
    const result = await store.transition({
      transactionId: txnId,
      expectedStatus: 'built',
      expectedVersion: num('7'),
      toStatus: 'simulated',
      reason: 'simulate.succeeded',
    });
    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.record.status).toBe('simulated');
      expect(result.record.stateVersion).toBe(num('8'));
    }
  });

  it('未知交易返回 not_found，与冲突类失败可区分', async () => {
    const store = new FakeTransactionStore();
    const result = await store.transition({
      transactionId: 'txn_nope' as TransactionId,
      expectedStatus: 'built',
      expectedVersion: num('1'),
      toStatus: 'simulated',
      reason: 'simulate.succeeded',
    });
    expect(result.kind).toBe('not_found');
  });

  it('listRecoverable 遵守每批上限（规范要求分页，禁止无界扫描）', async () => {
    const store = new FakeTransactionStore();
    for (let i = 0; i < 10; i += 1) {
      await store.create({ record: record({ transactionId: `txn_${i}` as TransactionId }) });
    }
    expect(await store.listRecoverable({ limit: 3 })).toHaveLength(3);
  });
});

describe('IdempotencyStore 端口', () => {
  const scope: IdempotencyScope = { projectId: 'default', chain, key: 'idem-key-0001' };

  it('首次 begin 为 acquired；并发同键同体为 in_flight；完成后重放；异体冲突', async () => {
    const store = new FakeIdempotencyStore();
    expect((await store.begin({ scope, fingerprint: 'f1', ownerToken: 'o1', leaseTtlMs: 30_000 })).kind).toBe(
      'acquired',
    );

    const concurrent = await store.begin({
      scope,
      fingerprint: 'f1',
      ownerToken: 'o2',
      leaseTtlMs: 30_000,
    });
    expect(concurrent.kind).toBe('in_flight');
    if (concurrent.kind === 'in_flight') expect(concurrent.retryAfterMs).toBeGreaterThan(0);

    await store.complete({ scope, ownerToken: 'o1', statusCode: 202 });
    const replay = await store.begin({
      scope,
      fingerprint: 'f1',
      ownerToken: 'o3',
      leaseTtlMs: 30_000,
    });
    expect(replay.kind).toBe('replayed');

    const conflicting = await store.begin({
      scope,
      fingerprint: 'f2',
      ownerToken: 'o4',
      leaseTtlMs: 30_000,
    });
    expect(conflicting.kind).toBe('conflict');
    // 不同指纹永不覆盖原记录。
    expect((await store.get(scope))?.fingerprint).toBe('f1');
  });

  it('complete 校验 owner token，失去所有权时返回 lost_ownership', async () => {
    const store = new FakeIdempotencyStore();
    await store.begin({ scope, fingerprint: 'f1', ownerToken: 'o1', leaseTtlMs: 30_000 });
    const result = await store.complete({ scope, ownerToken: 'stale', statusCode: 202 });
    expect(result.kind).toBe('lost_ownership');
  });

  it('未找到记录返回 null', async () => {
    const store = new FakeIdempotencyStore();
    expect(await store.get(scope)).toBeNull();
  });
});

describe('NonceStore 端口', () => {
  const ref = (nonce: string): NonceLeaseRef => ({ chain, account, nonce: num(nonce), transactionId: txnId });

  it('同一 transactionId 重放返回 reused，不递增 nonce', async () => {
    const store = new FakeNonceStore();
    const input: ReserveNonceInput = {
      chain,
      account,
      transactionId: txnId,
      chainPendingNonce: num('5'),
      leaseTtlMs: 60_000,
    };
    expect((await store.reserve(input)).kind).toBe('reserved');
    expect((await store.reserve(input)).kind).toBe('reused');
  });

  it('同一 nonce 被其他交易占用时返回 conflict', async () => {
    const store = new FakeNonceStore();
    await store.reserve({
      chain,
      account,
      transactionId: txnId,
      chainPendingNonce: num('5'),
      leaseTtlMs: 60_000,
    });
    const other = await store.reserve({
      chain,
      account,
      transactionId: 'txn_other' as TransactionId,
      chainPendingNonce: num('5'),
      leaseTtlMs: 60_000,
    });
    expect(other.kind).toBe('conflict');
  });

  it('已广播的 nonce 不允许自动释放复用（forbidden，而非静默复用）', async () => {
    const store = new FakeNonceStore();
    await store.reserve({
      chain,
      account,
      transactionId: txnId,
      chainPendingNonce: num('5'),
      leaseTtlMs: 60_000,
    });
    await store.markBroadcast(ref('5'));
    const released = await store.releaseIfSafe(ref('5'));
    expect(released.kind).toBe('forbidden');
    if (released.kind === 'forbidden') expect(released.reason).toBe('signed_or_broadcast');
  });

  it('仅 reserved 的 nonce 可安全释放', async () => {
    const store = new FakeNonceStore();
    await store.reserve({
      chain,
      account,
      transactionId: txnId,
      chainPendingNonce: num('9'),
      leaseTtlMs: 60_000,
    });
    const released = await store.releaseIfSafe(ref('9'));
    expect(released.kind).toBe('released');
    if (released.kind === 'released') expect(released.lease.status).toBe('released');
  });

  it('markConsumed 对未知 nonce 返回 not_found', async () => {
    const store = new FakeNonceStore();
    expect((await store.markConsumed(ref('404'))).kind).toBe('not_found');
  });
});

/* ------------------------------------------------------------------ */
/* SequencingStore：ADR-032 的核心语义——token 不是身份              */
/* ------------------------------------------------------------------ */

/**
 * 最小内存实现。刻意体现 A01 的关键不变式：
 *   - 行身份是 `(transactionId)`；一个 blockhash 可被多笔交易共用；
 *   - `consumed` 是审计事实、幂等，且**不**影响别的共享同一 token 的租约；
 *   - 过期回收按租约 TTL，只碰 `reserved`。
 */
class FakeSequencingStore implements SequencingStore {
  private readonly rows = new Map<string, SequencingLease>();

  async reserve(input: ReserveSequencingInput): Promise<ReserveSequencingResult> {
    const existing = this.rows.get(input.transactionId);
    if (existing !== undefined) {
      if (existing.status !== 'reserved'
        || existing.chain !== input.chain
        || existing.account.address !== input.account.address
        || existing.token.kind !== 'blockhash'
        || input.token.kind !== 'blockhash'
        || existing.token.value !== input.token.value
        || existing.token.lastValidBlockHeight !== input.token.lastValidBlockHeight) {
        throw new Error('sequencing lease replay is inactive or token/owner differs');
      }
      // This simplified in-memory port does not simulate a DB-clock TTL;
      // live TTL boundaries are verified in real Postgres tests.
      return { kind: 'reused', lease: existing };
    }
    const lease: SequencingLease = {
      chain: input.chain,
      account: input.account,
      token: input.token,
      transactionId: input.transactionId,
      status: 'reserved',
      expiresAt: iso,
    };
    this.rows.set(input.transactionId, lease);
    return { kind: 'reserved', lease };
  }

  private owned(ref: SequencingLeaseRef): SequencingLease | undefined {
    const row = this.rows.get(ref.transactionId);
    if (row === undefined) return undefined;
    if (row.token.kind === 'blockhash' && row.token.value !== ref.tokenValue) return undefined;
    return row;
  }

  async markConsumed(ref: SequencingLeaseRef): Promise<AdvanceSequencingResult> {
    const row = this.owned(ref);
    if (row === undefined || (row.status !== 'reserved' && row.status !== 'consumed')) {
      return { kind: 'not_found' };
    }
    const next: SequencingLease = { ...row, status: 'consumed' };
    this.rows.set(ref.transactionId, next);
    return { kind: 'updated', lease: next };
  }

  async releaseIfSafe(ref: SequencingLeaseRef): Promise<ReleaseSequencingResult> {
    const row = this.rows.get(ref.transactionId);
    if (row === undefined) return { kind: 'not_found' };
    if (row.token.kind === 'blockhash' && row.token.value !== ref.tokenValue) {
      return { kind: 'forbidden', lease: row, reason: 'not_owner' };
    }
    if (row.status === 'consumed') {
      return { kind: 'forbidden', lease: row, reason: 'already_consumed' };
    }
    const next: SequencingLease = { ...row, status: 'released' };
    this.rows.set(ref.transactionId, next);
    return { kind: 'released', lease: next };
  }

  async releaseExpiredOrphaned(): Promise<number> {
    return 0;
  }
}

describe('SequencingStore 端口（ADR-032）', () => {
  const blockhash = {
    kind: 'blockhash' as const,
    value: '1'.repeat(48) + '2345', // secret-scan:allow public-blockhash-placeholder
    lastValidBlockHeight: num('495317734'),
  };

  function seq(transactionId: string): ReserveSequencingInput {
    return {
      chain,
      account,
      transactionId: transactionId as TransactionId,
      token: blockhash,
      leaseTtlMs: 60_000,
    };
  }

  it('同一 blockhash 可被多笔交易各自 reserve（token 不是互斥量）', async () => {
    const store = new FakeSequencingStore();
    const first = await store.reserve(seq('txn_seq_a'));
    const second = await store.reserve(seq('txn_seq_b'));
    expect(first.kind).toBe('reserved');
    expect(second.kind).toBe('reserved');
    expect(first.lease.token).toEqual(second.lease.token);
    expect(first.lease.transactionId).not.toBe(second.lease.transactionId);
  });

  it('同一 transactionId 重放返回 reused，不产生第二行', async () => {
    const store = new FakeSequencingStore();
    await store.reserve(seq('txn_seq_replay'));
    expect((await store.reserve(seq('txn_seq_replay'))).kind).toBe('reused');
  });

  it('B40：测试存储同样拒绝释放后重放、终态复活以及不同 blockhash 重放', async () => {
    const store = new FakeSequencingStore();
    const input = seq('txn_seq_b40_fake');
    await store.reserve(input);
    await expect(store.reserve({
      ...input,
      token: { ...blockhash, value: '2'.repeat(48) + '3456' },
    })).rejects.toThrow(/sequencing lease replay/u);
    const ref = { chain, account, transactionId: input.transactionId, tokenValue: blockhash.value };
    expect((await store.releaseIfSafe(ref)).kind).toBe('released');
    await expect(store.reserve(input)).rejects.toThrow(/sequencing lease replay/u);
    expect((await store.markConsumed(ref)).kind).toBe('not_found');
  });

  it('markConsumed 幂等，且不影响共享同一 token 的其它租约', async () => {
    const store = new FakeSequencingStore();
    await store.reserve(seq('txn_seq_consume'));
    await store.reserve(seq('txn_seq_other'));
    const ref = { chain, account, transactionId: 'txn_seq_consume' as TransactionId, tokenValue: blockhash.value };

    expect((await store.markConsumed(ref)).kind).toBe('updated');
    expect((await store.markConsumed(ref)).kind).toBe('updated');

    const otherRef = { chain, account, transactionId: 'txn_seq_other' as TransactionId, tokenValue: blockhash.value };
    const released = await store.releaseIfSafe(otherRef);
    expect(released.kind).toBe('released');
  });

  it('consumed 租约拒绝释放（already_consumed）', async () => {
    const store = new FakeSequencingStore();
    await store.reserve(seq('txn_seq_consumed'));
    const ref = { chain, account, transactionId: 'txn_seq_consumed' as TransactionId, tokenValue: blockhash.value };
    await store.markConsumed(ref);
    const denied = await store.releaseIfSafe(ref);
    expect(denied.kind).toBe('forbidden');
    if (denied.kind === 'forbidden') expect(denied.reason).toBe('already_consumed');
  });

  it('引用 token 与行不符时 fail-closed（not_owner / not_found）', async () => {
    const store = new FakeSequencingStore();
    await store.reserve(seq('txn_seq_mismatch'));
    const bad = { chain, account, transactionId: 'txn_seq_mismatch' as TransactionId, tokenValue: 'x'.repeat(64) };
    const released = await store.releaseIfSafe(bad);
    expect(released.kind).toBe('forbidden');
    if (released.kind === 'forbidden') expect(released.reason).toBe('not_owner');
    expect((await store.markConsumed(bad)).kind).toBe('not_found');
  });

  it('未知 transactionId 一律 not_found', async () => {
    const store = new FakeSequencingStore();
    const ref = { chain, account, transactionId: 'txn_seq_missing' as TransactionId, tokenValue: blockhash.value };
    expect((await store.markConsumed(ref)).kind).toBe('not_found');
    expect((await store.releaseIfSafe(ref)).kind).toBe('not_found');
  });
});

describe('TrackerLeaseStore 端口', () => {
  const base = { chain, txHash: '0xabc', leaseTtlMs: 30_000 };

  it('有效期内第二 owner 无法接管，返回 held_by_other（single-flight）', async () => {
    const store = new FakeTrackerLeaseStore();
    expect((await store.acquire({ ...base, ownerToken: 'a' })).kind).toBe('acquired');
    const second = await store.acquire({ ...base, ownerToken: 'b' });
    expect(second.kind).toBe('held_by_other');
  });

  it('同一 owner 重复 acquire 视为已持有', async () => {
    const store = new FakeTrackerLeaseStore();
    await store.acquire({ ...base, ownerToken: 'a' });
    expect((await store.acquire({ ...base, ownerToken: 'a' })).kind).toBe('acquired');
  });

  it('旧 owner 续租失败（lost），不得继续写状态', async () => {
    const store = new FakeTrackerLeaseStore();
    await store.acquire({ ...base, ownerToken: 'a' });
    await store.release({ chain, txHash: '0xabc', ownerToken: 'a' });
    await store.acquire({ ...base, ownerToken: 'b' });
    expect((await store.renew({ ...base, ownerToken: 'a' })).kind).toBe('lost');
  });

  it('释放后 listRecoverable 不再返回该租约', async () => {
    const store = new FakeTrackerLeaseStore();
    await store.acquire({ ...base, ownerToken: 'a' });
    expect(await store.listRecoverable({ chain, limit: 10 })).toHaveLength(1);
    await store.release({ chain, txHash: '0xabc', ownerToken: 'a' });
    expect(await store.listRecoverable({ chain, limit: 10 })).toHaveLength(0);
  });
});

describe('M0 只读观测缓存（兼容保留，语义未变）', () => {
  function observed() {
    return {
      schemaVersion: '1' as const,
      ref: { kind: 'hash' as const, hash: '0xdead' },
      chain,
      status: 'included' as const,
    };
  }

  it('InMemoryTransactionObservationStore 仍实现 TransactionObservationStore', () => {
    const store = new InMemoryTransactionObservationStore() satisfies TransactionObservationStore;
    expect(store).toBeTruthy();
  });

  it('按 hash 与按 id 分别索引，list 返回该链全部观测', async () => {
    const store = new InMemoryTransactionObservationStore();
    await store.put(chain, observed());
    await store.put(chain, { ...observed(), ref: { kind: 'id', id: 'txn_1' } });
    expect(await store.get(chain, { kind: 'hash', hash: '0xdead' })).toBeTruthy();
    expect(await store.get(chain, { kind: 'id', id: 'txn_1' })).toBeTruthy();
    expect(await store.get(chain, { kind: 'hash', hash: '0xbeef' })).toBeUndefined();
    expect(await store.list(chain)).toHaveLength(2);
  });
});
