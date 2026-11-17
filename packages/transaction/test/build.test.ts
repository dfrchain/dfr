/**
 * TransactionEngine build 契约测试（DFR-M1-B04）。
 *
 * 权威来源：development-plan 第 4.3/4.4 节、transaction-lifecycle 第 8 节、
 * m1-api-contract 第 2 节。
 *
 * 全部用内存替身：本任务只验证**编排顺序与失败补偿**，不验证 SQL（那由 A10/A11 的
 * 数据库门禁覆盖）。替身必须记录调用，才能证明"没有第二次执行""没有 release 泄漏"。
 *
 * ADR-037 起替身抽到 `./support/engine-fakes.js`，与 preflight 测试共用同一套
 * （否则两处会立刻漂移）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import type { TransactionRequest } from '@dfr/types';
import { fingerprintBuildRequest } from '../src/index.js';
import {
  CHAIN,
  FROM,
  REQUEST,
  REQUEST_ID,
  TO,
  dec,
  harness,
} from './support/engine-fakes.js';

/* ------------------------------------------------------------------ */
/* 测试                                                               */
/* ------------------------------------------------------------------ */

describe('TransactionEngine.build（DFR-M1-B04）', () => {
  it('首次 build：先幂等 → 再 nonce 租约 → 再链构造 → 落库 built → 幂等 complete', async () => {
    const h = harness();
    const result = await h.engine.build({
      request: REQUEST,
      idempotencyKey: 'key-1',
      requestId: REQUEST_ID,
    });

    expect(result.replayed).toBe(false);
    expect(result.replayable).toBe(true);
    expect(result.status).toBe('built');
    expect(result.nonce).toBe('42');
    // Adapter 必须收到引擎分配的显式 nonce（不得自己再查一次）。
    expect(h.chain.buildCalls).toHaveLength(1);
    expect(h.chain.buildCalls[0]?.request.nonce).toBe('42');

    const record = await h.transactions.get(result.transactionId);
    expect(record?.status).toBe('built');
    expect(record?.stateVersion).toBe('0');
    expect(record?.nonce).toBe('42');
    expect(record?.unsignedPayload).toBe(result.unsignedTransaction.payload);
    expect(record?.requestFingerprint).toBe(fingerprintBuildRequest(REQUEST));
    expect(record?.projectId).toBe('default');
    // 幂等记录必须绑定同一个 transactionId，重放才有据可依。
    const idem = await h.idempotency.get({ projectId: 'default', chain: CHAIN, key: 'key-1' });
    expect(idem?.transactionId).toBe(result.transactionId);
  });

  it('相同幂等键重放：返回原结果，不重新执行、不消耗新 nonce', async () => {
    const h = harness();
    const first = await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });
    const second = await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });

    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.nonce).toBe(first.nonce);
    expect(second.unsignedTransaction.payload).toBe(first.unsignedTransaction.payload);
    // 关键：第二次既没有重新构造交易，也没有再次分配 nonce。
    expect(h.chain.buildCalls).toHaveLength(1);
    expect(h.nonce.reserveCalls).toHaveLength(1);
  });

  it('同键不同请求体 → DFR_IDEMPOTENCY_CONFLICT（不覆盖原记录）', async () => {
    const h = harness();
    await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });
    const changed: TransactionRequest = {
      ...REQUEST,
      value: { asset: { kind: 'native', chain: CHAIN }, amount: dec('2') },
    };
    await expect(
      h.engine.build({ request: changed, idempotencyKey: 'key-1', requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_IDEMPOTENCY_CONFLICT' });
    expect(h.chain.buildCalls).toHaveLength(1);
  });

  it('同键请求仍在处理中 → 409（带 retryAfterMs），不并发执行', async () => {
    const h = harness();
    // 先占住 in-flight：直接构造一条未完成的幂等记录。
    await h.idempotency.begin({
      scope: { projectId: 'default', chain: CHAIN, key: 'key-1' },
      fingerprint: fingerprintBuildRequest(REQUEST),
      ownerToken: 'other-owner',
      leaseTtlMs: 30_000,
    });

    await expect(
      h.engine.build({ request: REQUEST, idempotencyKey: 'key-1', requestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      code: 'DFR_IDEMPOTENCY_CONFLICT',
      details: { retryAfterMs: 30_000 },
    });
    expect(h.chain.buildCalls).toHaveLength(0);
    expect(h.nonce.reserveCalls).toHaveLength(0);
  });

  it('未提供幂等键：仍然构造，但显式标记不可重放', async () => {
    const h = harness();
    const result = await h.engine.build({ request: REQUEST });
    expect(result.replayable).toBe(false);
    expect(h.idempotency.beginCalls).toHaveLength(0);
  });

  it('nonce 冲突 → DFR_NONCE_CONFLICT，且不构造、不落库', async () => {
    const h = harness();
    h.nonce.conflict = true;
    await expect(
      h.engine.build({ request: REQUEST, idempotencyKey: 'key-1', requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_NONCE_CONFLICT' });
    expect(h.chain.buildCalls).toHaveLength(0);
    expect(h.transactions.created).toHaveLength(0);
  });

  it('链构造失败：安全释放未签名 nonce 租约，原错误上抛，不落库', async () => {
    const h = harness();
    h.chain.buildError = createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId: REQUEST_ID,
      chain: CHAIN,
      message: 'endpoint down',
    });

    await expect(
      h.engine.build({ request: REQUEST, idempotencyKey: 'key-1', requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_PROVIDER_UNAVAILABLE' });

    // ADR-030：释放必须携带 transactionId 作为所有权证明（nonce 可被回收复用，
    // 没有它会误释放已绑定到新交易的租约）。
    expect(h.nonce.releaseCalls).toEqual([
      { chain: CHAIN, account: FROM, nonce: '42', transactionId: 'txn_test_1' },
    ]);
    expect(h.transactions.created).toHaveLength(0);
  });

  it('释放被拒（同 nonce 已签名/广播）不掩盖原始错误', async () => {
    const h = harness();
    h.chain.buildError = createDfrError('DFR_TRANSACTION_REVERTED', {
      requestId: REQUEST_ID,
      chain: CHAIN,
      message: 'build 阶段回滚',
    });
    h.nonce.releaseForbidden = true;

    await expect(
      h.engine.build({ request: REQUEST, requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REVERTED' });
    expect(h.nonce.releaseCalls).toHaveLength(1);
  });

  it('请求自带 nonce → DFR_VALIDATION_FAILED，且完全不接触链与 Store', async () => {
    const h = harness();
    await expect(
      h.engine.build({
        request: { ...REQUEST, nonce: dec('7') },
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED', details: { fields: ['nonce'] } });
    expect(h.chain.pendingNonceCalls).toHaveLength(0);
    expect(h.nonce.reserveCalls).toHaveLength(0);
  });

  it('落库记录不含 signedPayload（安全负对照）', async () => {
    const h = harness();
    await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });
    const record = h.transactions.created[0] as unknown as Record<string, unknown>;
    expect(Object.keys(record)).not.toContain('signedPayload');
    // 注意：`"unsignedPayload"` 的尾部正好是 `signedPayload`，所以必须带引号匹配，
    // 否则这条负对照会被字段名本身"骗过"。
    expect(JSON.stringify(record)).not.toContain('"signedPayload"');
  });

  it('失去幂等写入权：结果真实但标记为不可重放', async () => {
    const h = harness();
    h.idempotency.loseOwnership = true;
    const result = await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });
    expect(result.replayable).toBe(false);
    expect(result.status).toBe('built');
    expect((await h.transactions.get(result.transactionId))?.status).toBe('built');
  });

  it('数字样键必须按 UTF16 规范排序而非 JS 对象重排', () => {
    const request = { chain: CHAIN, extra: { '2': 2, '10': 10 } };
    const expected = createHash('sha256')
      .update('{"chain":"' + CHAIN + '","extra":{"10":10,"2":2}}')
      .digest('hex');
    expect(fingerprintBuildRequest(request as unknown as TransactionRequest)).toBe(expected);
  });

  it('指纹稳定：key 顺序无关、字段变化敏感', () => {
    const a = fingerprintBuildRequest({ chain: CHAIN, from: FROM, to: TO });
    const b = fingerprintBuildRequest({ to: TO, chain: CHAIN, from: FROM });
    const c = fingerprintBuildRequest({ chain: CHAIN, from: FROM, to: TO, data: '0xdeadbeef' });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // 不含 requestId / header 类字段：换个 requestId 不得判成冲突。
    expect(fingerprintBuildRequest({ ...REQUEST })).toBe(fingerprintBuildRequest(REQUEST));
  });
});
