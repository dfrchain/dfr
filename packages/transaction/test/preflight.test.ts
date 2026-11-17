/**
 * TransactionEngine.preflight 契约测试（ADR-037 方案 B）。
 *
 * 权威来源：`docs/adr/ADR-037-abandoned-built-transaction-reclaim.md`。
 *
 * 本测试的核心断言是**零副作用**：preflight 必须
 *   - 不 reserve nonce（`nonce.reserveCalls` 为空）；
 *   - 不创建交易记录（`transactions.created` 为空）；
 *   - 不写幂等表（`idempotency.beginCalls` 为空）；
 *   - 不改 nonce 水位 / 不产生任何可回收状态。
 *
 * 为什么这是重点：ADR-037 的实测成因正是"调用方用 build 做预检"，
 * 每次 build 消耗一个 nonce。若 preflight 也占 nonce，它就毫无意义。
 */
import { describe, expect, it } from 'vitest';
import { dec, harness, REQUEST, REQUEST_ID } from './support/engine-fakes.js';

describe('TransactionEngine.preflight（ADR-037 方案 B）', () => {
  it('零副作用：不 reserve nonce、不建记录、不写幂等表', async () => {
    const h = harness();
    h.chain.allowSimulate = true;

    const result = await h.engine.preflight({ request: REQUEST, requestId: REQUEST_ID });

    // 核心断言：三处副作用**全部为零**。
    expect(h.nonce.reserveCalls).toEqual([]);
    expect(h.transactions.created).toEqual([]);
    expect(h.idempotency.beginCalls).toEqual([]);

    // 但它确实读了口径、构造了载荷、跑了模拟。
    expect(h.chain.pendingNonceCalls).toHaveLength(1);
    expect(h.chain.buildCalls).toHaveLength(1);
    expect(h.chain.simulateCalls).toHaveLength(1);
    expect(result.simulation.success).toBe(true);
    expect(result.requestId).toBe(REQUEST_ID);
  });

  it('反复调用 10 次仍然零副作用（这正是调用方此前用 build 做的事）', async () => {
    const h = harness();
    h.chain.allowSimulate = true;

    for (let i = 0; i < 10; i += 1) {
      await h.engine.preflight({ request: REQUEST });
    }

    expect(h.nonce.reserveCalls).toEqual([]);
    expect(h.transactions.created).toEqual([]);
    expect(h.chain.buildCalls).toHaveLength(10);
  });

  it('只读地取 pending nonce 并回报 observedNonce（不落租约）', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    h.chain.pendingNonce = dec('7');

    const result = await h.engine.preflight({ request: REQUEST });

    expect(result.observedNonce).toBe('7');
    // 传给 Adapter 的请求带上了该 nonce（否则构造不出载荷），但**没有**租约。
    expect(h.chain.buildCalls[0]!.request.nonce).toBe('7');
    expect(h.nonce.reserveCalls).toEqual([]);
  });

  it('模拟回滚不抛错：以 success=false 返回（与 simulate 的 422 语义刻意不同）', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    h.chain.simulateResult = { success: false, revertReason: 'insufficient output amount' };

    const result = await h.engine.preflight({ request: REQUEST });

    expect(result.simulation.success).toBe(false);
    expect(result.simulation.revertReason).toBe('insufficient output amount');
    // 仍然没有副作用——失败也不该留记录。
    expect(h.transactions.created).toEqual([]);
    expect(h.nonce.reserveCalls).toEqual([]);
  });

  it('拒绝自带 nonce（与 build 同一纪律，避免绕过服务端分配）', async () => {
    const h = harness();
    h.chain.allowSimulate = true;

    await expect(
      h.engine.preflight({ request: { ...REQUEST, nonce: dec('5') } }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });

    // 校验先于任何链调用。
    expect(h.chain.pendingNonceCalls).toEqual([]);
    expect(h.chain.buildCalls).toEqual([]);
  });

  it('缺排序前提读取能力 → fail-closed（不静默降级）', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    // `getPendingNonce` 是原型方法，`delete instance.x` 删不掉；
    // 必须用 `Object.defineProperty` 遮蔽（否则本用例会空转通过）。
    Object.defineProperty(h.chain, 'getPendingNonce', { value: undefined, configurable: true });

    await expect(h.engine.preflight({ request: REQUEST })).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_CAPABILITY',
    });
    // 校验先于任何链调用。
    expect(h.chain.buildCalls).toEqual([]);
  });
});

describe('TransactionEngine.preflight：gas 估计阶段回滚（2026-10-07 真实链抓到）', () => {
  it('★ build 阶段回滚 → 返回 200 + success=false，**不抛错**', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    // 真实链上，一笔注定回滚的交易在 `eth_estimateGas` 就会回滚，build 因此抛错。
    h.chain.buildRevert = 'RecomputeMismatch';

    const result = await h.engine.preflight({ request: REQUEST });

    expect(result.simulation.success).toBe(false);
    expect(result.simulation.revertReason).toBe('RecomputeMismatch');
    // 诚实：回滚时**不**返回一个伪造的预览载荷。
    expect(result.unsignedTransaction).toBeUndefined();
    // 仍然零副作用。
    expect(h.transactions.created).toEqual([]);
    expect(h.nonce.reserveCalls).toEqual([]);
  });

  it('非回滚类错误（Provider 不可用等）继续抛出——不降级、不猜测', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    h.chain.buildError = new Error('provider down');

    await expect(h.engine.preflight({ request: REQUEST })).rejects.toThrow('provider down');
  });
});
