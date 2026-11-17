/**
 * Store 调用观测契约测试（observability-spec 第 4 章剩余的 store.read / store.write span）。
 *
 * 权威来源：docs/architecture/observability-spec-v0.1.md 第 4 章的 span 层级——
 * `core.operation` 之下除 `adapter.call` 外还有 `store.read` / `store.write`。
 * Gateway 与 Provider/Adapter 三层已落日志，事务引擎的 Store 调用此前完全没有观测。
 *
 * 本测试断言：
 *   1. build 编排中的每次 Store 调用都产出记录，且 store/operation/kind 正确；
 *   2. 失败调用带稳定 `DFR_*` 错误码（或固定兜底码），不带原始异常；
 *   3. 记录中**不含**地址、载荷、nonce 等业务值（观测不得成为泄漏面）；
 *   4. 观测出口抛错不影响业务结果。
 */
import { describe, expect, it } from 'vitest';
import {
  READ_OPERATIONS,
  TransactionEngine,
  WRITE_OPERATIONS,
  storeCallKind,
  type StoreCallRecord,
} from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia' as never;

const REQUEST = {
  chain: CHAIN,
  from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
  to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
  value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' },
} as never;

function makeEngine(records: StoreCallRecord[], overrides: { failCreate?: boolean } = {}) {
  const stores = createInMemoryTransactionStores();
  if (overrides.failCreate === true) {
    stores.transaction.create = async () => {
      const error = new Error('insert failed: relation "transactions" does not exist');
      throw error;
    };
  }
  const engine = new TransactionEngine({
    stores,
    chain: {
      getPendingNonce: async () => '7' as never,
      build: async ({ request }: never) => ({
        schemaVersion: '1',
        chain: (request as { chain: unknown }).chain,
        payload: '0x02f8',
        meta: { encoding: 'hex', requiresNonce: '7' },
      }),
    } as never,
    newTransactionId: () => 'txn_store_call' as never,
    onStoreCall: (record) => records.push(record),
  });
  return engine;
}

describe('TransactionEngine Store 调用观测（observability-spec §4）', () => {
  it('build 编排逐次产出 store 调用记录，且区分 read / write', async () => {
    const records: StoreCallRecord[] = [];
    const engine = makeEngine(records);

    await engine.build({ request: REQUEST, idempotencyKey: 'store-call-0001' });

    // build 的顺序：幂等 begin(write) → nonce reserve(write) → 交易 create(write) → 幂等 complete(write)
    const pairs = records.map((r) => `${r.store}.${r.operation}:${r.kind}`);
    expect(pairs).toEqual([
      'idempotency.begin:write',
      'nonce.reserve:write',
      'transaction.create:write',
      'idempotency.complete:write',
    ]);
    for (const record of records) {
      expect(record.status).toBe('success');
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(record.latencyMs)).toBe(true);
    }
  });

  it('失败调用带稳定错误码，且不含原始异常文本', async () => {
    const records: StoreCallRecord[] = [];
    const engine = makeEngine(records, { failCreate: true });

    await expect(
      engine.build({ request: REQUEST, idempotencyKey: 'store-call-0002' }),
    ).rejects.toBeDefined();

    const failed = records.filter((r) => r.status === 'error');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.store).toBe('transaction');
    expect(failed[0]?.operation).toBe('create');
    // 非 DFR 异常归一为固定兜底码，不回显驱动原文。
    expect(failed[0]?.errorCode).toBe('DFR_INTERNAL_ERROR');
    expect(JSON.stringify(records)).not.toContain('relation "transactions" does not exist');
  });

  it('记录不含地址 / 载荷 / nonce 等业务值（观测不是泄漏面）', async () => {
    const records: StoreCallRecord[] = [];
    const engine = makeEngine(records);
    await engine.build({ request: REQUEST, idempotencyKey: 'store-call-0003' });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('0x1111111111111111111111111111111111111111');
    expect(serialized).not.toContain('0x2222222222222222222222222222222222222222');
    expect(serialized).not.toContain('0x02f8');
    // 键名层面也不应有这些字段。
    for (const record of records) {
      expect(Object.keys(record)).not.toContain('address');
      expect(Object.keys(record)).not.toContain('payload');
      expect(Object.keys(record)).not.toContain('nonce');
    }
  });

  it('观测出口抛错不影响业务结果', async () => {
    const stores = createInMemoryTransactionStores();
    const engine = new TransactionEngine({
      stores,
      chain: {
        getPendingNonce: async () => '7' as never,
        build: async ({ request }: never) => ({
          schemaVersion: '1',
          chain: (request as { chain: unknown }).chain,
          payload: '0x02f8',
          meta: { encoding: 'hex', requiresNonce: '7' },
        }),
      } as never,
      newTransactionId: () => 'txn_store_call_err' as never,
      onStoreCall: () => {
        throw new Error('sink exploded');
      },
    });

    await expect(
      engine.build({ request: REQUEST, idempotencyKey: 'store-call-0004' }),
    ).resolves.toMatchObject({ status: 'built' });
  });

  it('未注入出口时零开销且不报错', async () => {
    const stores = createInMemoryTransactionStores();
    const engine = new TransactionEngine({
      stores,
      chain: {
        getPendingNonce: async () => '7' as never,
        build: async ({ request }: never) => ({
          schemaVersion: '1',
          chain: (request as { chain: unknown }).chain,
          payload: '0x02f8',
          meta: { encoding: 'hex', requiresNonce: '7' },
        }),
      } as never,
      newTransactionId: () => 'txn_store_call_noop' as never,
    });
    await expect(
      engine.build({ request: REQUEST, idempotencyKey: 'store-call-0005' }),
    ).resolves.toBeDefined();
  });
});

/** 最小 SequencingStore 替身：只为"方法都被登记"这条护栏提供真实方法名。 */
function sequencingPort(): object {
  return {
    reserve: async () => ({ kind: 'reserved', lease: {} }),
    markConsumed: async () => ({ kind: 'not_found' }),
    releaseIfSafe: async () => ({ kind: 'not_found' }),
    releaseExpiredOrphaned: async () => 0,
  };
}

describe('Store 读/写分类覆盖护栏', () => {
  it('每个端口的每个方法都被显式分类（新增方法会让本测试失败）', () => {
    // 分类集合是手工维护的；若新增端口方法却不登记，它会落入"未登记即按写处理"的兜底，
    // 从而静默把读报成写。这条断言把"忘登记"变成红灯。
    const stores = createInMemoryTransactionStores();
    const ports: [string, object][] = [
      ['transaction', stores.transaction],
      ['idempotency', stores.idempotency],
      ['nonce', stores.nonce],
      // M3：Solana blockhash 排序租约端口（reserve/markConsumed/releaseIfSafe 已在
      // WRITE_OPERATIONS 中登记，与 nonce 同分类）。
      ['sequencing', sequencingPort()],
      ['tracker', stores.tracker],
    ];
    const unclassified: string[] = [];
    for (const [portName, port] of ports) {
      for (const key of Object.keys(port)) {
        const value = (port as Record<string, unknown>)[key];
        if (typeof value !== 'function') continue;
        if (!READ_OPERATIONS.has(key) && !WRITE_OPERATIONS.has(key)) {
          unclassified.push(`${portName}.${key}`);
        }
      }
    }
    expect(
      unclassified,
      'Store 端口出现未登记的读写分类：请把它加入 READ_OPERATIONS 或 WRITE_OPERATIONS',
    ).toEqual([]);
  });

  it('两个分类集合不重叠（同一方法不能既读又写）', () => {
    const both = [...READ_OPERATIONS].filter((op) => WRITE_OPERATIONS.has(op));
    expect(both).toEqual([]);
  });

  it('未登记方法保守按写处理，而不是默认读', () => {
    // 直接验证兜底方向：把真实写入报成读会低估写压力，更危险。
    expect(storeCallKind('transaction', 'someBrandNewMethod')).toBe('write');
    expect(storeCallKind('transaction', 'get')).toBe('read');
    expect(storeCallKind('transaction', 'transition')).toBe('write');
  });
});
