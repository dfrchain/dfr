/**
 * 重播路径契约测试（TODO-012）。
 *
 * 预复审发现：`rebroadcast: true` 在引擎中**不可达**——四处文档宣称可用，但
 * `assertBroadcastable` 只放行 `simulated`，且后续用 `sign` 事件而 `dropped`
 * 没有 `sign` 入边。可执行探针曾实测 `broadcastCalls=0`。
 *
 * 本文件把重播路径锁成可用，并加负对照防止它被误放宽：
 *   1. `dropped` + 显式 `rebroadcast: true` → 走 `rebroadcast` 事件、单次广播、状态回 `broadcast`；
 *   2. `dropped` + 未显式给 `rebroadcast` → 拒绝（状态机要求显式标记，防隐式第二次广播）；
 *   3. **非 `dropped`** 状态传 `rebroadcast: true` → 拒绝（不能借重播绕过状态闸门）；
 *   4. 重播仍只调用一次 Adapter 广播（non-idempotent-write 不重试）。
 */
import { describe, expect, it } from 'vitest';
import { TransactionEngine } from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia' as never;
const TX = 'txn_rebroadcast_probe' as never;
const HASH = `0x${'aa'.repeat(32)}`;
const UNSIGNED = { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: {} };

function signed() {
  return {
    schemaVersion: '1',
    chain: CHAIN,
    unsigned: UNSIGNED,
    signedPayload: '0x02f8signed',
    expectedHash: HASH,
  } as never;
}

async function harness(status: string, withExpectedHash = true, failBroadcast?: Error) {
  const stores = createInMemoryTransactionStores();
  await stores.transaction.create({
    record: {
      transactionId: TX,
      projectId: 'default',
      chain: CHAIN,
      requestFingerprint: 'f'.repeat(64),
      status,
      stateVersion: '0',
      from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
      unsignedPayload: UNSIGNED.payload,
      ...(withExpectedHash ? { expectedHash: HASH } : {}),
      nonce: '7',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  });
  let broadcastCalls = 0;
  const engine = new TransactionEngine({
    stores,
    chain: {
      broadcast: async () => {
        broadcastCalls += 1;
        if (failBroadcast !== undefined) throw failBroadcast;
        return { accepted: true, ref: { kind: 'hash', hash: HASH }, observedAt: new Date().toISOString() };
      },
    } as never,
    newTransactionId: () => TX,
  });
  return { engine, stores, calls: () => broadcastCalls };
}

describe('重播路径（TODO-012）', () => {
  it('dropped + 显式 rebroadcast:true → 单次广播、状态回 broadcast、结果标记 rebroadcast', async () => {
    const h = await harness('dropped');

    const result = await h.engine.broadcast({
      transactionId: TX,
      signed: signed(),
      options: { rebroadcast: true } as never,
    });

    expect(result.rebroadcast).toBe(true);
    expect(result.status).toBe('broadcast');
    expect(h.calls()).toBe(1);
  });

  it('TX-04: an uncertain rebroadcast error persists unknown; original error survives; no duplicate network send', async () => {
    const networkError = new Error('TX-04 simulated after-send timeout');
    const h = await harness('dropped', true, networkError);
    const attempt = h.engine.broadcast({
      transactionId: TX, signed: signed(), options: { rebroadcast: true } as never,
    });
    await expect(attempt).rejects.toBe(networkError);
    expect(h.calls()).toBe(1);
    const persisted = await h.stores.transaction.get(TX);
    expect(persisted?.status).toBe('unknown');
    expect(persisted?.expectedHash).toBe(HASH);
    expect(persisted?.nonce).toBe('7');
    await expect(h.engine.broadcast({
      transactionId: TX, signed: signed(), options: { rebroadcast: true } as never,
    })).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect(h.calls()).toBe(1);
  });

  it('TX-04: rebroadcast failure CAS transition should never mark failed or dropped', async () => {
    const h = await harness('dropped', true, new Error('rejected by provider after uncertain network delivery'));
    await expect(h.engine.broadcast({
      transactionId: TX, signed: signed(), options: { rebroadcast: true } as never,
    })).rejects.toThrow('rejected by provider');
    expect((await h.stores.transaction.get(TX))?.status).toBe('unknown');
    expect(h.calls()).toBe(1);
  });

  it('dropped 但未显式给 rebroadcast → 拒绝（防隐式第二次广播）', async () => {
    const h = await harness('dropped');

    await expect(
      h.engine.broadcast({ transactionId: TX, signed: signed() }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    // 关键：拒绝时**不得**发出广播。
    expect(h.calls()).toBe(0);
  });

  it.each(['simulated', 'built', 'signed', 'broadcast', 'pending', 'included', 'confirmed'])(
    '非 dropped 状态 %s 传 rebroadcast:true → 拒绝（不得借重播绕过状态闸门）',
    async (status) => {
      const h = await harness(status);

      const error = await h.engine
        .broadcast({
          transactionId: TX,
          signed: signed(),
          options: { rebroadcast: true } as never,
        })
        .then(() => undefined, (e: unknown) => e);

      expect(error).toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
      expect(h.calls()).toBe(0);
    },
  );

  it('重播的 expectedHash 与记录不一致 → 拒绝且零广播（不得借重播换一笔交易）', async () => {
    const h = await harness('dropped');

    const error = await h.engine
      .broadcast({
        transactionId: TX,
        signed: { ...(signed() as object), expectedHash: `0x${'cc'.repeat(32)}` } as never,
        options: { rebroadcast: true } as never,
      })
      .then(() => undefined, (e: unknown) => e);

    expect(error).toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect((error as { details?: { reason?: string } }).details?.reason).toBe(
      'expected_hash_mismatch',
    );
    expect(h.calls()).toBe(0);
  });

  it('dropped 缺失原始 expectedHash 时必须拒绝重播且零广播', async () => {
    const h = await harness('dropped', false);
    expect((await h.stores.transaction.get(TX))?.expectedHash).toBeUndefined();

    const err = await h.engine.broadcast({
      transactionId: TX,
      signed: signed(),
      options: { rebroadcast: true } as never,
    }).then(() => undefined, (e: unknown) => e);

    expect(err).toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect(h.calls()).toBe(0);
  });

  it('dropped 重播不能替换已落库的 unsigned payload，拒绝且零广播', async () => {
    const h = await harness('dropped');
    const altered = signed() as { unsigned: { payload: string } };
    const error = await h.engine.broadcast({
      transactionId: TX,
      signed: {
        ...altered,
        unsigned: { ...altered.unsigned, payload: `${altered.unsigned.payload}tampered` },
      } as never,
      options: { rebroadcast: true } as never,
    }).then(() => undefined, (e: unknown) => e);

    expect(error).toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect((error as { details?: { reason?: string } }).details?.reason).toBe('unsigned_payload_mismatch');
    expect(h.calls()).toBe(0);
    expect((await h.stores.transaction.get(TX))?.status).toBe('dropped');
  });

  it('同一 dropped 交易的并发显式重播最多一次广播（CAS 不允许双重发送）', async () => {
    const h = await harness('dropped');
    const attempt = () => h.engine.broadcast({
      transactionId: TX,
      signed: signed(),
      options: { rebroadcast: true } as never,
    });
    const outcomes = await Promise.allSettled([attempt(), attempt()]);

    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(h.calls()).toBe(1);
    expect((await h.stores.transaction.get(TX))?.status).toBe('broadcast');
  });

  it('simulated + 不传 rebroadcast → 仍走首次广播路径（不因新增分支而回归）', async () => {
    const h = await harness('simulated');

    const result = await h.engine.broadcast({ transactionId: TX, signed: signed() });

    expect(result.status).toBe('broadcast');
    expect(h.calls()).toBe(1);
    // 首次广播不得被标记为重播。
    expect(result.rebroadcast).toBeUndefined();
  });
});
