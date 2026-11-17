/**
 * TransactionEngine simulate 契约测试（DFR-M1-B05）。
 *
 * 权威来源：transaction-lifecycle 第 4.2/3.1 节、m1-api-contract 第 2 节。
 *
 * 本任务的两个交付点：
 *   1. 绑定：simulate 的 UnsignedTransaction 必须与 build 落库的载荷逐字节一致；
 *   2. 封锁：模拟失败把交易落到 reverted（终态），此后广播在状态机层面不可达。
 *
 * 全部用内存替身：只验证编排与状态事实，不验证 SQL。
 */
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import type {
  AccountRef,
  ChainId,
  DecimalUint,
  Iso8601,
  RequestId,
  SimulationResult,
  TransactionId,
  UnsignedTransaction,
} from '@dfr/types';
import {
  TransactionEngine,
  canTransition,
  transition,
  type ChainSimulateInput,
  type TransactionChainPort,
  type TransactionRecord,
  type TransactionStore,
  type TransitionTransactionInput,
  type TransitionTransactionResult,
} from '../src/index.js';

const CHAIN = 'ethereum-sepolia' as ChainId;
const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };
const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };
const REQUEST_ID = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;
const TX_ID = 'txn_test_1' as TransactionId;

const dec = (value: string): DecimalUint => value as DecimalUint;
const iso = (ms: number): Iso8601 => new Date(ms).toISOString() as Iso8601;

const UNSIGNED: UnsignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN,
  payload: '0x02f8',
  meta: { encoding: 'hex', requiresNonce: dec('42'), chainIdForSigning: '11155111' },
};

/* ------------------------------------------------------------------ */
/* 替身：TransactionStore（支持注入 CAS 冲突）                        */
/* ------------------------------------------------------------------ */

class FakeTransactionStore implements TransactionStore {
  records = new Map<TransactionId, TransactionRecord>();
  readonly transitionCalls: TransitionTransactionInput[] = [];
  /** 让接下来 N 次 transition 先返回一次 version_conflict（模拟并发写入）。 */
  conflictsBeforeApply = 0;

  seed(status: TransactionRecord['status']): TransactionRecord {
    const record: TransactionRecord = {
      transactionId: TX_ID,
      projectId: 'default',
      chain: CHAIN,
      requestFingerprint: 'f'.repeat(64),
      status,
      stateVersion: dec('0'),
      from: FROM,
      to: TO,
      nonce: dec('42'),
      unsignedPayload: UNSIGNED.payload,
      payloadEncoding: 'hex',
      createdAt: iso(1_700_000_000_000),
      updatedAt: iso(1_700_000_000_000),
    };
    this.records.set(TX_ID, record);
    return record;
  }

  async create({ record }: { record: TransactionRecord }) {
    this.records.set(record.transactionId, record);
    return { kind: 'created' as const, record };
  }

  async get(transactionId: TransactionId): Promise<TransactionRecord | null> {
    return this.records.get(transactionId) ?? null;
  }

  async getByHash(chain: ChainId, txHash: string): Promise<TransactionRecord | null> {
    return [...this.records.values()].find((record) => record.chain === chain &&
      (record.txHash === txHash || record.expectedHash === txHash)) ?? null;
  }

  async transition(input: TransitionTransactionInput): Promise<TransitionTransactionResult> {
    this.transitionCalls.push(input);
    const current = this.records.get(input.transactionId);
    if (current === undefined) return { kind: 'not_found' };

    if (this.conflictsBeforeApply > 0) {
      this.conflictsBeforeApply -= 1;
      // 模拟"另一个执行者先写入了一版"：版本已前进。
      const bumped: TransactionRecord = {
        ...current,
        stateVersion: dec((BigInt(current.stateVersion) + 1n).toString(10)),
      };
      this.records.set(input.transactionId, bumped);
      return { kind: 'version_conflict', current: bumped };
    }

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
      stateVersion: dec((BigInt(current.stateVersion) + 1n).toString(10)),
      updatedAt: iso(1_700_000_001_000),
    };
    this.records.set(input.transactionId, next);
    return { kind: 'applied', record: next };
  }

  async listRecoverable(): Promise<readonly TransactionRecord[]> {
    return [...this.records.values()];
  }
}

/* ------------------------------------------------------------------ */
/* 替身：链端口                                                       */
/* ------------------------------------------------------------------ */

class FakeChainPort implements TransactionChainPort {
  readonly simulateCalls: ChainSimulateInput[] = [];
  result: SimulationResult = { success: true, estimatedCost: dec('21000') };
  error?: Error;

  async getPendingNonce(): Promise<never> {
    throw new Error('B05 不应读取 pending nonce');
  }

  async build(): Promise<never> {
    throw new Error('B05 不应重新构造交易');
  }

  async simulate(input: ChainSimulateInput): Promise<SimulationResult> {
    this.simulateCalls.push(input);
    if (this.error !== undefined) throw this.error;
    return this.result;
  }
}

/* ------------------------------------------------------------------ */
/* 组装                                                               */
/* ------------------------------------------------------------------ */

interface Harness {
  engine: TransactionEngine;
  store: FakeTransactionStore;
  chain: FakeChainPort;
  releasedNonces: string[];
}

function harness(): Harness {
  const store = new FakeTransactionStore();
  const chain = new FakeChainPort();
  const releasedNonces: string[] = [];
  const engine = new TransactionEngine({
    stores: {
      transaction: store,
      // B05 不涉及幂等与 nonce；一旦被调用就让测试立刻失败。
      idempotency: {
        begin: async () => {
          throw new Error('B05 不应触碰幂等');
        },
        complete: async () => {
          throw new Error('B05 不应触碰幂等');
        },
        get: async () => null,
        pruneExpired: async () => 0,
      },
      nonce: {
        reserve: async () => {
          throw new Error('B05 不应触碰 nonce 租约');
        },
        markBroadcast: async () => {
          throw new Error('B05 不应触碰 nonce 租约');
        },
        markConsumed: async () => {
          throw new Error('B05 不应触碰 nonce 租约');
        },
        releaseIfSafe: async (ref) => {
          releasedNonces.push(ref.nonce);
          return { kind: 'not_found' as const };
        },
        releaseExpiredOrphaned: async () => {
          throw new Error('B05 不应触碰 nonce 租约');
        },
      },
    },
    chain,
  });
  return { engine, store, chain, releasedNonces };
}

/* ------------------------------------------------------------------ */
/* 测试                                                               */
/* ------------------------------------------------------------------ */

describe('AUTH-04 simulation owner isolation', () => {
  it('denies another project before RPC and state writes', async () => {
    const h = harness();
    h.store.seed('built');
    await expect(h.engine.simulate({
      transactionId: TX_ID, unsignedTransaction: UNSIGNED,
      requesterProjectId: 'another-project', authorizedChains: [CHAIN],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
    expect(h.store.transitionCalls).toHaveLength(0);
  });

  it('denies the correct project on a foreign chain', async () => {
    const h = harness();
    h.store.seed('built');
    await expect(h.engine.simulate({
      transactionId: TX_ID, unsignedTransaction: UNSIGNED,
      requesterProjectId: 'default', authorizedChains: ['solana-devnet' as ChainId],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('accepts correct project and chain', async () => {
    const h = harness(); h.store.seed('built');
    const ok = await h.engine.simulate({
      transactionId: TX_ID, unsignedTransaction: UNSIGNED,
      requesterProjectId: 'default', authorizedChains: [CHAIN],
    });
    expect(ok.status).toBe('simulated');
    expect(h.chain.simulateCalls).toHaveLength(1);
  });
});

describe('TransactionEngine.simulate（DFR-M1-B05）', () => {
  it('模拟成功：built 转 simulated，落库状态与观测结果都更新', async () => {
    const h = harness();
    h.store.seed('built');

    const result = await h.engine.simulate({
      transactionId: TX_ID,
      unsignedTransaction: UNSIGNED,
      requestId: REQUEST_ID,
    });

    expect(result.transactionId).toBe(TX_ID);
    expect(result.status).toBe('simulated');
    expect(result.simulation.success).toBe(true);
    expect(result.simulation.estimatedCost).toBe('21000');
    expect((await h.store.get(TX_ID))?.status).toBe('simulated');
    // 端口必须拿到发送方（载荷本身不含 from，EVM 需要它覆盖余额/授权检查）。
    expect(h.chain.simulateCalls[0]?.from).toEqual(FROM);
    expect(h.chain.simulateCalls[0]?.unsigned).toEqual(UNSIGNED);
  });

  it('模拟失败：built 转 reverted，抛 DFR_TRANSACTION_REVERTED 且带 revertReason', async () => {
    const h = harness();
    h.store.seed('built');
    h.chain.result = {
      success: false,
      revertReason: 'execution reverted: insufficient allowance',
      estimatedCost: dec('21000'),
    };

    await expect(
      h.engine.simulate({
        transactionId: TX_ID,
        unsignedTransaction: UNSIGNED,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'DFR_TRANSACTION_REVERTED',
      details: { transactionId: TX_ID, revertReason: 'execution reverted: insufficient allowance' },
    });

    const record = await h.store.get(TX_ID);
    expect(record?.status).toBe('reverted');
    expect(record?.errorCode).toBe('DFR_TRANSACTION_REVERTED');
    expect(h.releasedNonces).toEqual(['42']);
  });

  it('TX-01: simulated-state failure also attempts owned nonce release', async () => {
    const h = harness();
    h.store.seed('simulated');
    h.chain.result = { success: false, revertReason: 'preflight reverted' };
    await expect(h.engine.simulate({
      transactionId: TX_ID,
      unsignedTransaction: UNSIGNED,
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REVERTED' });
    expect((await h.store.get(TX_ID))?.status).toBe('reverted');
    expect(h.releasedNonces).toEqual(['42']);
  });

  it('reverted 之后广播在状态机层面不可达（封锁广播）', async () => {
    const h = harness();
    h.store.seed('built');
    h.chain.result = { success: false, revertReason: 'execution reverted' };

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REVERTED' });

    // 这是"模拟失败不得广播"的机制性证据：终态没有出边。
    expect(canTransition({ from: 'reverted', event: 'sign' })).toBe(false);
    expect(canTransition({ from: 'reverted', event: 'broadcast.accepted' })).toBe(false);
    expect(transition({ from: 'reverted', event: 'broadcast.accepted' }).ok).toBe(false);
  });

  it('对已 reverted 的交易再次 simulate 返回 DFR_VALIDATION_FAILED（不调用链）', async () => {
    const h = harness();
    h.store.seed('reverted');

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED, requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('载荷与 build 落库记录不一致时拒绝，且完全不调用链', async () => {
    const h = harness();
    h.store.seed('built');
    const tampered: UnsignedTransaction = { ...UNSIGNED, payload: '0x02f9deadbeef' };

    await expect(
      h.engine.simulate({
        transactionId: TX_ID,
        unsignedTransaction: tampered,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'DFR_VALIDATION_FAILED',
      details: { fields: ['unsignedTransaction.payload'] },
    });
    expect(h.chain.simulateCalls).toHaveLength(0);
    expect((await h.store.get(TX_ID))?.status).toBe('built');
  });

  it('载荷 chain 与记录不一致时拒绝', async () => {
    const h = harness();
    h.store.seed('built');
    const foreign: UnsignedTransaction = { ...UNSIGNED, chain: 'base-sepolia' as ChainId };

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: foreign }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('载荷 meta.requiresNonce 与记录 nonce 不一致时拒绝', async () => {
    const h = harness();
    h.store.seed('built');
    const wrongNonce: UnsignedTransaction = {
      ...UNSIGNED,
      meta: { ...UNSIGNED.meta, requiresNonce: dec('43') },
    };

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: wrongNonce }),
    ).rejects.toMatchObject({
      code: 'DFR_VALIDATION_FAILED',
      details: { fields: ['unsignedTransaction.meta.requiresNonce'] },
    });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('未知 transactionId 返回 DFR_TRANSACTION_NOT_FOUND', async () => {
    const h = harness();
    await expect(
      h.engine.simulate({ transactionId: 'txn_missing' as TransactionId, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_NOT_FOUND' });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('已进入签名/广播的交易不允许再 simulate', async () => {
    const h = harness();
    h.store.seed('signed');
    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
    expect((await h.store.get(TX_ID))?.status).toBe('signed');
  });

  it('重复 simulate（已 simulated）成功不改变状态，只更新观测', async () => {
    const h = harness();
    h.store.seed('simulated');
    h.chain.result = { success: true, estimatedCost: dec('21500') };

    const result = await h.engine.simulate({
      transactionId: TX_ID,
      unsignedTransaction: UNSIGNED,
    });

    expect(result.status).toBe('simulated');
    expect(result.simulation.estimatedCost).toBe('21500');
    const record = await h.store.get(TX_ID);
    expect(record?.status).toBe('simulated');
    // 没有状态迁移：不应产生任何 transition 调用。
    expect(h.store.transitionCalls).toHaveLength(0);
  });

  it('重复 simulate（已 simulated）失败转为 reverted，同样封锁广播', async () => {
    const h = harness();
    h.store.seed('simulated');
    h.chain.result = { success: false, revertReason: 'execution reverted: state changed' };

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REVERTED' });

    expect((await h.store.get(TX_ID))?.status).toBe('reverted');
    expect(canTransition({ from: 'reverted', event: 'broadcast.accepted' })).toBe(false);
  });

  it('CAS 版本冲突时自动重读并重试，最终成功', async () => {
    const h = harness();
    h.store.seed('built');
    h.store.conflictsBeforeApply = 1;

    const result = await h.engine.simulate({
      transactionId: TX_ID,
      unsignedTransaction: UNSIGNED,
    });

    expect(result.status).toBe('simulated');
    expect(h.store.transitionCalls).toHaveLength(2);
    expect((await h.store.get(TX_ID))?.status).toBe('simulated');
  });

  it('链端口抛非回滚错误时状态保持 built，错误原样上抛', async () => {
    const h = harness();
    h.store.seed('built');
    h.chain.error = createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId: REQUEST_ID,
      chain: CHAIN,
      message: 'endpoint down',
    });

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_PROVIDER_UNAVAILABLE' });

    expect((await h.store.get(TX_ID))?.status).toBe('built');
    expect(h.store.transitionCalls).toHaveLength(0);
  });

  it('simulate 不触碰幂等与 nonce，也不写入 signedPayload', async () => {
    const h = harness();
    h.store.seed('built');
    await h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED });

    const record = (await h.store.get(TX_ID)) as unknown as Record<string, unknown>;
    expect(Object.keys(record)).not.toContain('signedPayload');
    expect(JSON.stringify(record)).not.toContain('"signedPayload"');
  });
});
