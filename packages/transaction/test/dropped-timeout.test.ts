/**
 * `unknown` 超时判 `dropped` 与 `dropped` 收敛（ADR-023 / TODO-011）。
 *
 * 背景：ADR-019 把 `unknown → dropped` 指派给 D03，但 D03 未实现，导致这条边
 * **没有任何代码路径触发**。后果是广播结果不确定且链上始终查不到的交易永远停在
 * `unknown`：一直在恢复扫描集合里被反复查询，nonce 租约也永不释放。
 *
 * 本文件锁定 ADR-023 的四条规则：
 *   1. 观测为 `absent` 且静默未达 `dropTimeoutMs` → **保持 `unknown`**（不得提前判丢弃）；
 *   2. 观测为 `absent` 且已超时 → 转 `dropped`；
 *   3. 观测为 `included`/`pending`/`replaced` → **观测优先**，即使已超时也不判丢弃；
 *   4. `dropped` 记录在宽限窗内可被后续观测纠正回 `included`/`pending`/`replaced`。
 */
import { describe, expect, it } from 'vitest';
import { TransactionEngine, type ChainBroadcastObservation } from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia' as never;
const TX_ID = 'txn_drop_test' as never;
const EXPECTED_HASH = `0x${'aa'.repeat(32)}`;

/** 可控时钟：`dropClock` 决定"现在"，从而决定是否跨过 dropTimeoutMs。 */
function harness(options: { nowMs: number; dropTimeoutMs?: number; observation: ChainBroadcastObservation | (() => ChainBroadcastObservation) }) {
  const stores = createInMemoryTransactionStores();
  let clockMs = options.nowMs;
  const engine = new TransactionEngine({
    stores,
    chain: {
      getPendingNonce: async () => '7' as never,
      build: async () => ({
        schemaVersion: '1',
        chain: CHAIN,
        payload: '0x02f8',
        meta: { encoding: 'hex', requiresNonce: '7' },
      }),
      broadcast: async () => ({ accepted: true, ref: { kind: 'hash', hash: EXPECTED_HASH }, observedAt: new Date(clockMs).toISOString() }),
      observe: async () =>
        typeof options.observation === 'function' ? options.observation() : options.observation,
    } as never,
    newTransactionId: () => TX_ID,
    dropClock: () => clockMs,
    ...(options.dropTimeoutMs !== undefined ? { dropTimeoutMs: options.dropTimeoutMs } : {}),
  });
  return { engine, stores, setClock: (ms: number) => { clockMs = ms; } };
}

/** 直接构造一条 `unknown` 记录：避免依赖广播路径，聚焦超时语义本身。 */
async function seedUnknown(stores: ReturnType<typeof createInMemoryTransactionStores>, updatedAt: string) {
  await stores.transaction.create({
    record: {
      transactionId: TX_ID,
      projectId: 'default',
      chain: CHAIN,
      requestFingerprint: 'f'.repeat(64),
      status: 'unknown',
      stateVersion: '0',
      from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
      expectedHash: EXPECTED_HASH,
      nonce: '7',
      createdAt: updatedAt,
      updatedAt,
    } as never,
  });
}

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const ABSENT: ChainBroadcastObservation = { kind: 'absent' };

describe('unknown 超时判 dropped（ADR-023）', () => {
  it('观测 absent 但未达 dropTimeoutMs → 保持 unknown（不得提前判丢弃）', async () => {
    const h = harness({ nowMs: T0 + 60_000, dropTimeoutMs: 1_800_000, observation: ABSENT });
    await seedUnknown(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('unknown');
  });

  it('观测 absent 且已超时 → 转 dropped', async () => {
    const h = harness({ nowMs: T0 + 1_800_000, dropTimeoutMs: 1_800_000, observation: ABSENT });
    await seedUnknown(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('dropped');
  });

  it('观测 included 优先于超时：即使已超时也判 included，绝不判 dropped', async () => {
    const h = harness({
      nowMs: T0 + 10_000_000,
      dropTimeoutMs: 1_800_000,
      observation: {
        kind: 'included',
        txHash: EXPECTED_HASH,
        blockRef: { kind: 'number', number: '100' } as never,
      },
    });
    await seedUnknown(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('included');
  });

  it('观测 pending 优先于超时 → pending', async () => {
    const h = harness({
      nowMs: T0 + 10_000_000,
      dropTimeoutMs: 1_800_000,
      observation: { kind: 'pending', txHash: EXPECTED_HASH },
    });
    await seedUnknown(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('pending');
  });

  it('观测不可用（observe 抛错）→ 保持 unknown，不误判 dropped', async () => {
    const stores = createInMemoryTransactionStores();
    const engine = new TransactionEngine({
      stores,
      chain: {
        observe: async () => {
          throw new Error('rpc down');
        },
      } as never,
      newTransactionId: () => TX_ID,
      dropClock: () => T0 + 10_000_000,
      dropTimeoutMs: 1_800_000,
    });
    await seedUnknown(stores, new Date(T0).toISOString());

    const record = await engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('unknown');
  });
});

describe('dropped 收敛（ADR-023，修正误判）', () => {
  async function seedDropped(stores: ReturnType<typeof createInMemoryTransactionStores>, updatedAt: string) {
    await seedUnknown(stores, updatedAt);
    await stores.transaction.transition({
      transactionId: TX_ID,
      expectedStatus: 'unknown' as never,
      expectedVersion: '0' as never,
      toStatus: 'dropped' as never,
      reason: 'dropped' as never,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    });
  }

  it('dropped + 观测 included → 纠正为 included（否则会对已确认交易报告"已丢弃"）', async () => {
    const h = harness({
      nowMs: T0 + 3_600_000,
      observation: {
        kind: 'included',
        txHash: EXPECTED_HASH,
        blockRef: { kind: 'number', number: '100' } as never,
      },
    });
    await seedDropped(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('included');
  });

  it('dropped + 观测 pending → 纠正为 pending', async () => {
    const h = harness({
      nowMs: T0 + 3_600_000,
      observation: { kind: 'pending', txHash: EXPECTED_HASH },
    });
    await seedDropped(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('pending');
  });

  it('dropped + 观测 replaced → 纠正为 replaced', async () => {
    const h = harness({
      nowMs: T0 + 3_600_000,
      observation: { kind: 'replaced', nonce: '7' },
    });
    await seedDropped(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('replaced');
  });

  it('dropped + 观测 absent → 保持 dropped（不重复写状态）', async () => {
    const h = harness({ nowMs: T0 + 3_600_000, observation: ABSENT });
    await seedDropped(h.stores, new Date(T0).toISOString());

    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });

    expect(record?.status).toBe('dropped');
  });

  it('终态不受影响：非 unknown/dropped 记录原样返回', async () => {
    const h = harness({ nowMs: T0, observation: ABSENT });
    await h.stores.transaction.create({
      record: {
        transactionId: TX_ID,
        projectId: 'default',
        chain: CHAIN,
        requestFingerprint: 'f'.repeat(64),
        status: 'finalized',
        stateVersion: '0',
        from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
        createdAt: new Date(T0).toISOString(),
        updatedAt: new Date(T0).toISOString(),
      } as never,
    });
    const record = await h.engine.resolveIndeterminate({ transactionId: TX_ID });
    expect(record?.status).toBe('finalized');
  });
});
