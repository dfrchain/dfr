/**
 * TransactionEngine 广播超时与 `unknown` 解析（DFR-M1-C03b）。
 *
 * 权威来源：ADR-019（Accepted）、transaction-lifecycle §3.1/§3.2、m1-api-contract §5。
 *
 * 本任务关闭 TODO-006：广播结果不确定时**不得**判成功也不得判失败，
 * 先落 `unknown`，再按链上观测解析到 `pending / included / replaced`；
 * 查不到且 nonce 未被占用时**保持 `unknown`**（mempool 传播是异步的，
 * "此刻查不到"不等于"已丢弃"——`unknown → dropped` 留给 M1-D03 的 dropTimeoutMs 窗口）。
 *
 * 全部用内存替身：只验证编排、分类与状态事实，不验证 SQL。
 */
import { describe, expect, it } from 'vitest';
import { createDfrError, isDfrError } from '@dfr/errors';
import type {
  AccountRef,
  BlockRef,
  BroadcastResult,
  ChainId,
  DecimalUint,
  Iso8601,
  RequestId,
  SignedTransaction,
  TransactionId,
  TransactionStatus,
  UnsignedTransaction,
} from '@dfr/types';
import {
  TransactionEngine,
  classifyBroadcastFailure,
  resolveUnknownOutcome,
  type ChainBroadcastInput,
  type ChainBroadcastObservation,
  type ChainObserveInput,
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
const TX_ID = 'txn_test_c03b' as TransactionId;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;

const dec = (value: string): DecimalUint => value as DecimalUint;
const iso = (ms: number): Iso8601 => new Date(ms).toISOString() as Iso8601;

const UNSIGNED: UnsignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN,
  payload: '0x02f8c0',
  meta: { encoding: 'hex', requiresNonce: dec('42'), chainIdForSigning: '11155111' },
};

const SIGNED: SignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN,
  unsigned: UNSIGNED,
  signedPayload: '0x02f8c1de' + 'ad'.repeat(40),
  expectedHash: TX_HASH,
  signerRef: 'external:test',
};

/* ------------------------------ 替身 ------------------------------ */

class FakeTransactionStore implements TransactionStore {
  records = new Map<TransactionId, TransactionRecord>();
  readonly transitionCalls: TransitionTransactionInput[] = [];
  failOnTransitionReason?: string;

  seed(status: TransactionStatus): TransactionRecord {
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

  async create(): Promise<never> {
    throw new Error('not used');
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
    if (this.failOnTransitionReason === input.reason) throw new Error('DB connection interrupted');
    const current = this.records.get(input.transactionId);
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
      stateVersion: dec((BigInt(current.stateVersion) + 1n).toString(10)),
      updatedAt: iso(1_700_000_001_000),
    };
    this.records.set(input.transactionId, next);
    return { kind: 'applied', record: next };
  }

  async listRecoverable(): Promise<readonly TransactionRecord[]> {
    return [];
  }
}

interface PortOptions {
  broadcastError?: unknown;
  broadcastResult?: BroadcastResult;
  observation?: ChainBroadcastObservation;
  observeError?: unknown;
  /** true 表示完全不装配 observe（模拟老部署）。 */
  withoutObserve?: boolean;
}

class FakeChainPort implements TransactionChainPort {
  readonly broadcastCalls: ChainBroadcastInput[] = [];
  readonly observeCalls: ChainObserveInput[] = [];
  private readonly options: PortOptions;

  constructor(options: PortOptions = {}) {
    this.options = options;
    if (options.withoutObserve) {
      delete (this as { observe?: unknown }).observe;
    }
  }

  async getPendingNonce(): Promise<DecimalUint> {
    return dec('42');
  }

  async build(): Promise<UnsignedTransaction> {
    return UNSIGNED;
  }

  async simulate(): Promise<never> {
    throw new Error('not used');
  }

  async broadcast(input: ChainBroadcastInput): Promise<BroadcastResult> {
    this.broadcastCalls.push(input);
    if (this.options.broadcastError !== undefined) throw this.options.broadcastError;
    return (
      this.options.broadcastResult ?? {
        ref: { kind: 'hash', hash: TX_HASH },
        status: 'broadcast',
        accepted: true,
        observedAt: iso(1_700_000_002_000),
      }
    );
  }

  async observe(input: ChainObserveInput): Promise<ChainBroadcastObservation> {
    this.observeCalls.push(input);
    if (this.options.observeError !== undefined) throw this.options.observeError;
    return this.options.observation ?? { kind: 'absent' };
  }
}

function makeEngine(port: TransactionChainPort, stores: FakeTransactionStore): TransactionEngine {
  return new TransactionEngine({
    stores: {
      transaction: stores,
      idempotency: { begin: async () => ({ kind: 'acquired', ownerToken: 't' }), complete: async () => ({ kind: 'completed' }) } as never,
      nonce: {} as never,
    },
    chain: port,
  });
}

const TIMEOUT = () =>
  createDfrError('DFR_PROVIDER_TIMEOUT', {
    requestId: REQUEST_ID,
    message: '广播请求超时',
    chain: CHAIN,
    details: { method: 'eth_sendRawTransaction' },
  });

async function run(port: PortOptions, status: TransactionStatus = 'simulated') {
  const stores = new FakeTransactionStore();
  stores.seed(status);
  const fake = new FakeChainPort(port);
  const error = await makeEngine(fake, stores)
    .broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID })
    .then(() => undefined, (err: unknown) => err);
  return { stores, port: fake, error, record: stores.records.get(TX_ID)! };
}

/* ------------------------------ 测试 ------------------------------ */

describe('广播失败分类（ADR-019 第 3 节，纯函数）', () => {
  it('TX-02: peer rejection cannot prove an already-signed transaction never propagated', () => {
    const classify = (code: never) => {
      const err = createDfrError(code, { requestId: REQUEST_ID, message: 'x', chain: CHAIN });
      return classifyBroadcastFailure(err);
    };
    expect(classify('DFR_TRANSACTION_REJECTED' as never)).toBe('indeterminate');
    expect(classify('DFR_INSUFFICIENT_FUNDS' as never)).toBe('indeterminate');
    expect(classify('DFR_VALIDATION_FAILED' as never)).toBe('indeterminate');
    // A locally verified, expired Solana blockhash is the only exception.
    expect(classify('DFR_BLOCKHASH_EXPIRED' as never)).toBe('rejected');
  });

  it('Provider 超时 / 不可用 / 熔断 / nonce 冲突都是不确定，不是拒绝', () => {
    for (const code of [
      'DFR_PROVIDER_TIMEOUT',
      'DFR_PROVIDER_UNAVAILABLE',
      'DFR_PROVIDER_CIRCUIT_OPEN',
      'DFR_NONCE_CONFLICT',
    ] as const) {
      const err = createDfrError(code, { requestId: REQUEST_ID, message: 'x', chain: CHAIN });
      expect(classifyBroadcastFailure(err), code).toBe('indeterminate');
    }
  });

  it('非 DfrError 一律按不确定处理（不猜测，也不当成可证明的拒绝）', () => {
    expect(classifyBroadcastFailure(new Error('boom'))).toBe('indeterminate');
  });

  it.each([
    ['already known', 'DFR_TRANSACTION_REJECTED', 'indeterminate'],
    ['underpriced', 'DFR_PROVIDER_UNAVAILABLE', 'indeterminate'],
    ['replacement transaction underpriced', 'DFR_PROVIDER_UNAVAILABLE', 'indeterminate'],
  ] as const)('%s 失败按矩阵分类为 %s', (_label, code, expected) => {
    const err = createDfrError(code, { requestId: REQUEST_ID, message: 'provider response', chain: CHAIN });
    expect(classifyBroadcastFailure(err)).toBe(expected);
  });
});

describe('链上观测 → unknown 解析（ADR-019 第 2 节，纯函数）', () => {
  it.each([
    ['pending', 'mempool.entered'],
    ['included', 'included'],
    ['replaced', 'replaced'],
  ] as const)('%s 观测解析为 %s 事件', (kind, event) => {
    expect(resolveUnknownOutcome({ kind } as ChainBroadcastObservation)).toBe(event);
  });

  it('absent 观测不解析为任何事件（保持 unknown，等 D03 的 dropTimeoutMs 窗口）', () => {
    expect(resolveUnknownOutcome({ kind: 'absent' })).toBeNull();
  });
});

describe('TransactionEngine 广播超时（DFR-M1-C03b）', () => {
  it('超时且查不到 → 落 unknown，并上抛原始错误（既非成功也非失败）', async () => {
    const { record, error, port, stores } = await run({ broadcastError: TIMEOUT() });

    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(record.status).toBe('unknown');
    // 状态边：sign → broadcast.indeterminate（不含 rejected）。
    expect(stores.transitionCalls.map((c) => c.reason)).toEqual([
      'sign',
      'broadcast.indeterminate',
    ]);
    // 查询用的是 expectedHash 与记录里的 from/nonce。
    expect(port.observeCalls).toHaveLength(1);
    expect(port.observeCalls[0]).toMatchObject({
      txHash: TX_HASH,
      from: FROM,
      nonce: '42',
    });
    // 只广播一次：超时后绝不自动重发。
    expect(port.broadcastCalls).toHaveLength(1);
  });

  it('超时但查询发现已进 mempool → 解析为 pending', async () => {
    const { record, error } = await run({
      broadcastError: TIMEOUT(),
      observation: { kind: 'pending', txHash: TX_HASH },
    });
    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(record.status).toBe('pending');
  });

  it('超时但查询发现已上链 → 解析为 included 并持久化区块高度/hash 锚点', async () => {
    const blockRef: BlockRef = { kind: 'number', number: dec('18000000') };
    const { record } = await run({
      broadcastError: TIMEOUT(),
      observation: {
        kind: 'included',
        txHash: TX_HASH,
        blockRef,
        canonicalBlockHash: '0x' + '12'.repeat(32),
      },
    });
    expect(record.status).toBe('included');
    expect(record.txHash).toBe(TX_HASH);
    expect(record.blockRef).toEqual(blockRef);
    expect(record.canonicalBlockHash).toBe('0x' + '12'.repeat(32));
  });

  it('超时且该 nonce 已被别人消耗 → 解析为 replaced（终态）', async () => {
    const { record } = await run({
      broadcastError: TIMEOUT(),
      observation: { kind: 'replaced', nonce: dec('42'), byTxHash: OTHER_HASH },
    });
    expect(record.status).toBe('replaced');
  });

  it('查询本身失败时保持 unknown，不让查询故障改变分类', async () => {
    const { record, error } = await run({
      broadcastError: TIMEOUT(),
      observeError: createDfrError('DFR_PROVIDER_UNAVAILABLE', {
        requestId: REQUEST_ID,
        message: '查询不可用',
        chain: CHAIN,
      }),
    });
    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(record.status).toBe('unknown');
  });

  it('部署未装配 observe → 停在 unknown（不假装 dropped，也不假装失败）', async () => {
    const { record, error } = await run({ broadcastError: TIMEOUT(), withoutObserve: true });
    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(record.status).toBe('unknown');
  });

  it('TX-02: peer may reject signed hash but another peer already included it; never terminal-fail', async () => {
    const { record, port, stores, error } = await run({
      broadcastError: createDfrError('DFR_INSUFFICIENT_FUNDS', {
        requestId: REQUEST_ID,
        message: '余额不足',
        chain: CHAIN,
      }),
      observation: { kind: 'included', txHash: TX_HASH },
    });
    expect(isDfrError(error) && error.code).toBe('DFR_INSUFFICIENT_FUNDS');
    expect(record.status).toBe('included');
    expect(record.expectedHash).toBe(TX_HASH);
    expect(record.txHash).toBe(TX_HASH);
    expect(port.observeCalls).toHaveLength(1);
    expect(port.broadcastCalls).toHaveLength(1);
    expect(stores.transitionCalls.map((t) => t.reason)).toEqual([
      'sign', 'broadcast.indeterminate', 'included',
    ]);
  });

  it.each(['DFR_TRANSACTION_REJECTED', 'DFR_VALIDATION_FAILED', 'DFR_INSUFFICIENT_FUNDS'] as const)(
    'TX-02: signed %s error with absent chain read remains unknown and retains expectedHash',
    async (code) => {
      const { record, error, port } = await run({
        broadcastError: createDfrError(code, {
          requestId: REQUEST_ID,
          message: 'peer rejected',
          chain: CHAIN,
        }),
        observation: { kind: 'absent' },
      });
      expect(isDfrError(error) && error.code).toBe(code);
      expect(record.status).toBe('unknown');
      expect(record.expectedHash).toBe(TX_HASH);
      expect(port.observeCalls).toHaveLength(1);
      expect(port.broadcastCalls).toHaveLength(1);
    },
  );

  it('TX-02: generic EVM record may not use a forged Solana blockhash-expired error to terminal-fail', async () => {
    const { record, port } = await run({
      broadcastError: createDfrError('DFR_BLOCKHASH_EXPIRED', {
        requestId: REQUEST_ID,
        message: 'invalid exception on EVM',
        chain: CHAIN,
      }),
      observation: { kind: 'absent' },
    });
    expect(record.status).toBe('unknown');
    expect(record.expectedHash).toBe(TX_HASH);
    expect(port.observeCalls).toHaveLength(1);
  });

  it('nonce too low（DFR_NONCE_CONFLICT）走不确定路径，不直接判 failed', async () => {
    const { record, port } = await run({
      broadcastError: createDfrError('DFR_NONCE_CONFLICT', {
        requestId: REQUEST_ID,
        message: 'nonce 冲突',
        chain: CHAIN,
      }),
      observation: { kind: 'replaced', nonce: dec('42') },
    });
    expect(record.status).toBe('replaced');
    expect(port.observeCalls).toHaveLength(1);
  });

  it('unknown 不是终态：可被后续观测继续解析（D03 恢复扫描的前提）', async () => {
    const first = await run({ broadcastError: TIMEOUT() });
    expect(first.record.status).toBe('unknown');
    expect(first.stores.transitionCalls.some((c) => c.toStatus === 'pending')).toBe(false);

    // 同一记录被"再次观测"（模拟恢复扫描）时，仍能沿 unknown → included 推进。
    const engine = makeEngine(
      new FakeChainPort({
        observation: { kind: 'included', txHash: `0x${'aa'.repeat(32)}` },
      }),
      first.stores,
    );
    const resolved = await engine.resolveIndeterminate({
      transactionId: TX_ID,
      requestId: REQUEST_ID,
    });
    expect(resolved?.status).toBe('included');
  });

  it('恢复路径再观测为 absent 且已超时 → dropped（ADR-023 补上这条无触发路径的边）', async () => {
    const first = await run({ broadcastError: TIMEOUT() });
    expect(first.record.status).toBe('unknown');

    // 默认观测即 absent；`dropClock` 未注入时用真实时钟，而记录 updatedAt 是固定的
    // 测试时间 → 静默远超 dropTimeoutMs，因此应判 dropped。
    const engine = makeEngine(new FakeChainPort({}), first.stores);
    const resolved = await engine.resolveIndeterminate({
      transactionId: TX_ID,
      requestId: REQUEST_ID,
    });
    expect(resolved?.status).toBe('dropped');
  });

  it('同一次广播请求内的 absent 观测绝不判 dropped（ADR-019 第 142 行约束不得被 ADR-023 破坏）', async () => {
    // 这是最容易被"顺手实现超时"破坏的约束：mempool 传播是异步的，
    // 请求内此刻查不到不代表已丢弃。
    const { record } = await run({ broadcastError: TIMEOUT(), observation: { kind: 'absent' } });
    expect(record.status).toBe('unknown');
  });

  it('TX-02: broadcast RPC timeout is preserved if DB cannot persist indeterminate state', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    stores.failOnTransitionReason = 'broadcast.indeterminate';
    const port = new FakeChainPort({ broadcastError: TIMEOUT() });
    const engine = makeEngine(port, stores);

    const error = await engine.broadcast({
      transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID,
    }).then(() => undefined, (failure: unknown) => failure);
    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(stores.records.get(TX_ID)).toMatchObject({
      status: 'signed', expectedHash: TX_HASH,
    });
    expect(port.broadcastCalls).toHaveLength(1);
  });

  it('广播成功路径不受影响（回归）：accepted → broadcast，且不做观测查询', async () => {
    const { record, port } = await run({});
    expect(record.status).toBe('broadcast');
    expect(port.observeCalls).toHaveLength(0);
  });
});
