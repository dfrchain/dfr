/**
 * `tx.*` 状态事件出口（M2 余项：事件接线）。
 *
 * transaction-lifecycle 第 6 章："一切状态变化必须发事件"。引擎的 `applyTransition`
 * 是所有状态迁移的单点，挂钩在这里即可覆盖全部路径。
 *
 * 为什么用**注入回调**而不是让引擎依赖 `@dfr/events`：模块边界要求
 * `packages/transaction` 只依赖叶子工具包（types/errors/metrics）。回调与既有的
 * `onStoreCall` 同构——引擎不感知总线，cursor 由 composition root 分配。
 */
import { describe, expect, it } from 'vitest';
import type { ChainId, DecimalUint, Iso8601, RequestId, TransactionId } from '@dfr/types';
import type {
  TransactionRecord,
  TransactionStore,
  TransitionTransactionInput,
} from '../src/stores.js';
import { TransactionEngine, type TransitionEventRecord } from '../src/engine.js';

const CHAIN = 'ethereum-sepolia' as ChainId;
const TX_ID = 'txn_evt_1' as TransactionId;
const REQ = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;

/** 可控 Store：记录的每次 transition 调用，并返回 applied。 */
function makeStore(initial: TransactionRecord): {
  store: TransactionStore;
  transitions: TransitionTransactionInput[];
} {
  let current = initial;
  const transitions: TransitionTransactionInput[] = [];
  const store = {
    get: async () => current,
    create: async () => ({ kind: 'created', record: current }),
    transition: async (input: TransitionTransactionInput) => {
      transitions.push(input);
      current = {
        ...current,
        status: input.toStatus,
        stateVersion: (BigInt(current.stateVersion) + 1n).toString(10) as DecimalUint,
        ...(input.patch?.txHash !== undefined ? { txHash: input.patch.txHash } : {}),
      };
      return { kind: 'applied', record: current };
    },
    listRecoverable: async () => [],
    getByHash: async () => null,
  } as unknown as TransactionStore;
  return { store, transitions };
}

function record(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    transactionId: TX_ID,
    projectId: 'default',
    chain: CHAIN,
    requestFingerprint: 'a'.repeat(64),
    status: 'simulated',
    stateVersion: '1' as DecimalUint,
    from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
    unsignedPayload: '0x02f8',
    nonce: '1' as DecimalUint,
    createdAt: '2026-10-06T00:00:00.000Z' as Iso8601,
    updatedAt: '2026-10-06T00:00:00.000Z' as Iso8601,
    ...overrides,
  };
}

/** 只提供引擎驱动一次 broadcast 所需的最小端口（不触链）。 */
function engine(
  store: TransactionStore,
  onTransition?: (record: TransitionEventRecord) => void,
): TransactionEngine {
  return new TransactionEngine({
    stores: { transaction: store, idempotency: {} as never, nonce: {} as never, tracker: {} as never },
    chain: {
      broadcast: async () => ({
        ref: { kind: 'hash', hash: `0x${'aa'.repeat(32)}` },
        status: 'broadcast',
        accepted: true,
        observedAt: '2026-10-06T00:00:01.000Z' as Iso8601,
      }),
    } as never,
    ...(onTransition !== undefined ? { onTransition } : {}),
  });
}

const SIGNED = {
  schemaVersion: '1',
  chain: CHAIN,
  unsigned: { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: {} },
  signedPayload: `0x${'ab'.repeat(100)}`,
  expectedHash: `0x${'aa'.repeat(32)}`,
} as never;

describe('tx.* 状态事件出口', () => {
  it('每次成功迁移都发出一条事件，内容为"已提交的事实"', async () => {
    const { store } = makeStore(record());
    const events: TransitionEventRecord[] = [];
    await engine(store, (e) => events.push(e)).broadcast({
      transactionId: TX_ID,
      signed: SIGNED,
      requestId: REQ,
    });

    // simulated → signed → broadcast 两跳。
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ fromStatus: 'simulated', toStatus: 'signed', chain: CHAIN });
    expect(events[1]).toMatchObject({ fromStatus: 'signed', toStatus: 'broadcast' });
    // 每跳都带着迁移后的版本号与 requestId（可追踪到具体请求）。
    expect(events[0]!.stateVersion).toBe('2');
    expect(events[1]!.stateVersion).toBe('3');
    expect(events[0]!.requestId).toBe(REQ);
  });

  it('汇点抛错绝不影响状态迁移（事件是尽力而为）', async () => {
    const { store, transitions } = makeStore(record());
    const e = engine(store, () => {
      throw new Error('sink boom');
    });
    // 调用本身必须成功——否则"观测挂了"会变成"业务挂了"。
    await expect(
      e.broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQ }),
    ).resolves.toMatchObject({ status: 'broadcast' });
    // 且状态确实迁移了（不是被吞掉整体）。
    expect(transitions.map((t) => t.toStatus)).toEqual(['signed', 'broadcast']);
  });

  it('未注入汇点时不报错（零开销路径）', async () => {
    const { store } = makeStore(record());
    await expect(
      engine(store).broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQ }),
    ).resolves.toMatchObject({ status: 'broadcast' });
  });
});
