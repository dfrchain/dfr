/**
 * TransactionEngine.abandon 契约测试（ADR-037 方案 A）。
 *
 * 权威来源：`docs/adr/ADR-037-abandoned-built-transaction-reclaim.md`。
 *
 * 最重要的负对照：**`signed` 及以上永不可作废**——否则会把已签名/已广播交易的 nonce
 * 回收掉，破坏 ADR-018/019 的资金安全约束。
 */
import { describe, expect, it } from 'vitest';
import type { TransitionTransactionInput } from '../src/index.js';
import { harness, REQUEST, REQUEST_ID } from './support/engine-fakes.js';

describe('TransactionEngine.abandon（ADR-037 方案 A）', () => {
  it('B37: a concurrent signer winning after read must not lose its nonce', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    const originalGet = h.transactions.get.bind(h.transactions);
    let injected = false;
    h.transactions.get = async (id) => {
      const old = await originalGet(id);
      if (!injected && id === built.transactionId && old?.status === 'built') {
        injected = true;
        const moved = await h.transactions.transition({
          transactionId: old.transactionId,
          expectedStatus: 'built', expectedVersion: old.stateVersion,
          toStatus: 'signed', reason: 'sign',
        });
        expect(moved.kind).toBe('applied');
      }
      return old;
    };
    await expect(h.engine.abandon({ transactionId: built.transactionId })).rejects.toBeDefined();
    expect(h.nonce.releaseCalls).toEqual([]);
    expect((await originalGet(built.transactionId))?.status).toBe('signed');
  });

  it('B37: manual abandon must commit terminal CAS BEFORE releasing the nonce', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    const operations: string[] = [];
    const oldTransition = h.transactions.transition.bind(h.transactions);
    h.transactions.transition = async (input) => {
      operations.push('CAS');
      return oldTransition(input);
    };
    const oldRelease = h.nonce.releaseIfSafe.bind(h.nonce);
    h.nonce.releaseIfSafe = async (ref) => {
      operations.push('release');
      expect((await h.transactions.get(built.transactionId))?.status).toBe('abandoned');
      return oldRelease(ref);
    };
    expect((await h.engine.abandon({ transactionId: built.transactionId })).leaseReleased).toBe(true);
    expect(operations).toEqual(['CAS', 'release']);
  });

  it('作废 built：先转终态 abandoned，再安全释放租约', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, requestId: REQUEST_ID });
    expect(built.status).toBe('built');

    const result = await h.engine.abandon({
      transactionId: built.transactionId,
      requestId: REQUEST_ID,
    });

    expect(result.status).toBe('abandoned');
    expect(result.leaseReleased).toBe(true);
    expect(result.nonce).toBe('42');
    // 释放必须携带 transactionId（ADR-030 的所有权证明）。
    expect(h.nonce.releaseCalls).toEqual([
      expect.objectContaining({ nonce: '42', transactionId: built.transactionId }),
    ]);
    // 记录确实是终态。
    const record = await h.transactions.get(built.transactionId);
    expect(record?.status).toBe('abandoned');
  });

  it('作废 simulated：同样可作废（两者都是"未签名"）', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    const built = await h.engine.build({ request: REQUEST });
    await h.engine.simulate({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    expect((await h.transactions.get(built.transactionId))?.status).toBe('simulated');

    const result = await h.engine.abandon({ transactionId: built.transactionId });
    expect(result.status).toBe('abandoned');
    expect(result.leaseReleased).toBe(true);
  });

  it('幂等：已 abandoned 再调返回 200，且不重复释放', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    await h.engine.abandon({ transactionId: built.transactionId });
    const releasesAfterFirst = h.nonce.releaseCalls.length;

    const second = await h.engine.abandon({ transactionId: built.transactionId });

    expect(second.status).toBe('abandoned');
    expect(second.leaseReleased).toBe(false);
    expect(h.nonce.releaseCalls).toHaveLength(releasesAfterFirst);
  });

  it('★ 负对照：已 signed 的交易**不可作废**（绝不回收已签名 nonce）', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    // 手工把记录推到 signed（走状态机允许的边），模拟"调用方已经签了名"。
    const record = (await h.transactions.get(built.transactionId))!;
    await h.transactions.transition({
      transactionId: record.transactionId,
      expectedStatus: 'built',
      expectedVersion: record.stateVersion,
      toStatus: 'signed',
      reason: 'sign',
    } as TransitionTransactionInput);

    await expect(
      h.engine.abandon({ transactionId: built.transactionId }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });

    // 关键：**一次释放都没有发生**。
    expect(h.nonce.releaseCalls).toEqual([]);
    // 状态仍是 signed，没有被改成 abandoned。
    expect((await h.transactions.get(built.transactionId))?.status).toBe('signed');
  });

  it('AUTH-03：受限链 API Key 不能按交易 ID 作废另一条链的记录', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, projectId: 'project-A' });
    await expect(h.engine.abandon({
      transactionId: built.transactionId,
      requesterProjectId: 'project-A',
      authorizedChains: ['solana-devnet' as never],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(h.nonce.releaseCalls).toHaveLength(0);
    expect((await h.transactions.get(built.transactionId))?.status).toBe('built');
  });

  it('AUTH-03：不属于请求项目的交易，即使链已授权也不得作废', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, projectId: 'project-A' });
    await expect(h.engine.abandon({
      transactionId: built.transactionId,
      requesterProjectId: 'project-B',
      authorizedChains: ['ethereum-sepolia' as never],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(h.nonce.releaseCalls).toHaveLength(0);
    expect((await h.transactions.get(built.transactionId))?.status).toBe('built');
  });

  it('AUTH-03：在已授权链与项目内，仍允许安全作废，并保持幂等', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, projectId: 'project-A' });
    const allowed = {
      transactionId: built.transactionId,
      requesterProjectId: 'project-A',
      authorizedChains: ['ethereum-sepolia' as never],
    };
    expect((await h.engine.abandon(allowed)).leaseReleased).toBe(true);
    const releases = h.nonce.releaseCalls.length;
    expect((await h.engine.abandon(allowed)).leaseReleased).toBe(false);
    expect(h.nonce.releaseCalls).toHaveLength(releases);
  });

  it('AUTH-03：已作废交易也不向未授权 Key 暴露幂等响应', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, projectId: 'project-A' });
    await h.engine.abandon({ transactionId: built.transactionId });
    await expect(h.engine.abandon({
      transactionId: built.transactionId,
      requesterProjectId: 'project-A',
      authorizedChains: ['solana-devnet' as never],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
  });

  it('未知交易 → DFR_TRANSACTION_NOT_FOUND', async () => {
    const h = harness();
    await expect(
      h.engine.abandon({ transactionId: 'txn_nope' as never }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_NOT_FOUND' });
  });

  it('释放被拒（理论上不可达）时仍推进终态：不留"永远 built"', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    h.nonce.releaseForbidden = true;

    const result = await h.engine.abandon({ transactionId: built.transactionId });

    expect(result.leaseReleased).toBe(false);
    // 记录仍然进入终态——否则会留下一个永远无法被巡检处理的 built 记录。
    expect((await h.transactions.get(built.transactionId))?.status).toBe('abandoned');
  });
});
