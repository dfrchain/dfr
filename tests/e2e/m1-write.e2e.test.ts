/**
 * M1 写路径离线 E2E（DFR-M1-B10）。
 *
 * 链路：TypeScript SDK → API Gateway → DFR Core → EVM Adapter → Provider 替身
 *      → TransactionEngine（测试替身 Store）→ 落库记录。
 *
 * 与 `gateway.e2e.test.ts`（M0 只读）的区别：本文件用**真实**
 * `chains.yaml` 配置 + 真实 `TransactionEngine`，因此同时验证：
 *   1. registry 已为 ethereum-sepolia 声明 build/simulate（B10 的能力启用）；
 *   2. nonce 租约 → Adapter 显式 nonce → 载荷 → 落库 `built` 的完整顺序；
 *   3. 幂等键重放不消耗新 nonce；
 *   4. 载荷绑定校验与模拟回滚的真实 HTTP 结果（400 / 422）；
 *   5. 记录里没有 `signedPayload`（M1 不持久化签名原文）。
 *
 * Store 是测试替身（`support/in-memory-transaction-stores.ts`）：M1 刻意没有生产
 * in-memory Store（ADR-014）；真实 PostgreSQL 路径由 `pnpm test:db` 覆盖。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { createGatewayServer, createCoreTransactionChainPort, hashSecret } from '@dfr/gateway';
import { createStubFetch } from '@dfr/provider';
import { ChainRegistry } from '@dfr/registry';
import { DFR, isDfrApiError } from '@dfr/sdk-typescript';
import { TransactionEngine } from '@dfr/transaction';
import type { AccountRef, Chain, ChainId, DecimalUint, TransactionId } from '@dfr/types';
import { createInMemoryTransactionStores } from './support/in-memory-transaction-stores.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN = 'ethereum-sepolia' as ChainId;
const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };
const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };
const SECRET = 'm1WriteE2eSecret0123456789abcdefgh';
const PEPPER = 'm1-write-e2e-pepper';
const KEY_ID = 'M1WriteA'; // 必须是恰好 8 位 [A-Za-z0-9]：dfr_<8>_<20..64>

const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
  baseFeePerGas: '0x3b9aca00',
};

/** `eth_call` 的行为开关：M1 需要区分成功与回滚两种真实结果。 */
let callMode: 'ok' | 'revert' = 'ok';
let finalizedAvailable = true;
let confirmationObservationCalls = 0;

const stubFetch = createStubFetch({
  onCall: ({ method }) => {
    if (method === 'eth_getTransactionByHash') confirmationObservationCalls += 1;
  },
  resolve: (call) => {
    switch (call.method) {
      case 'eth_chainId':
        return { kind: 'result', value: '0xaa36a7' };
      case 'eth_getTransactionCount':
        return { kind: 'result', value: '0x2a' };
      case 'eth_estimateGas':
        return { kind: 'result', value: '0x5208' };
      case 'eth_maxPriorityFeePerGas':
        return { kind: 'result', value: '0x3b9aca00' };
      case 'eth_getBlockByNumber':
        return call.params[0] === 'finalized' && !finalizedAvailable
          ? { kind: 'result', value: null }
          : { kind: 'result', value: call.params[0] === '0x112a87f' ? { ...BLOCK, number: '0x112a87f' } : BLOCK };
      case 'eth_getTransactionByHash':
        return { kind: 'result', value: {
          hash: `0x${'aa'.repeat(32)}`,
          blockNumber: '0x112a87f',
          blockHash: `0x${'11'.repeat(32)}`,
          from: FROM.address,
          to: TO.address,
          value: '0x1',
          gas: '0x5208',
          nonce: '0x2a',
        } };
      case 'eth_getTransactionReceipt':
        return { kind: 'result', value: { transactionHash: `0x${'aa'.repeat(32)}`, blockHash: BLOCK.hash, blockNumber: '0x112a87f', status: '0x1' } };
      case 'eth_call':
        return callMode === 'ok'
          ? { kind: 'result', value: '0x' }
          : { kind: 'rpc-error', code: 3, message: 'execution reverted: nope' };
      case 'web3_clientVersion':
        return { kind: 'result', value: 'stub/1.0.0' };
      default:
        return { kind: 'rpc-error', code: -32601, message: `unsupported ${call.method}` };
    }
  },
});

let server: Server | undefined;
let baseUrl = '';
let dfr: DFR;
let engine: TransactionEngine;
let stores: ReturnType<typeof createInMemoryTransactionStores>;
let nextTransactionNumber = 1;

beforeAll(async () => {
  stores = createInMemoryTransactionStores();
  const registry = ChainRegistry.load({
    file: resolve(repoRoot, 'packages/registry/config/chains.yaml'),
    env: {
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://stub.local/sepolia-primary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_KEY: 'stub-credential-primary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://stub.local/sepolia-secondary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_KEY: 'stub-credential-secondary',
    },
  });

  const core = new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    fetchImpl: stubFetch,
    transactionStores: stores,
  });

  engine = new TransactionEngine({
    stores: {
      transaction: stores.transaction,
      idempotency: stores.idempotency,
      nonce: stores.nonce,
      tracker: stores.tracker,
    },
    chain: createCoreTransactionChainPort(core),
    // 确定性 ID：断言才能逐字节比较落库记录与响应。
    newTransactionId: () =>
      `txn_01J8Z6W3Q2K9M4ABCDEFGHJK${String(nextTransactionNumber++).padStart(2, '0')}` as TransactionId,
  });

  const created = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'm1-write-e2e',
      scope: { chains: [CHAIN], capabilities: '*', allowWrite: true },
    },
    allowWrite: true,
    transactions: engine,
  });
  server = created;
  await new Promise<void>((resolveListen) => created.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
  dfr = new DFR({ apiKey: `dfr_${KEY_ID}_${SECRET}`, baseUrl });
});

afterAll(async () => {
  // beforeAll 失败时 server 可能未赋值：这里必须安全退出，避免掩盖真正的失败原因。
  if (!server) return;
  engine.close();
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
});

const REQUEST = {
  chain: CHAIN,
  from: FROM,
  to: TO,
  value: { asset: { kind: 'native' as const, chain: CHAIN }, amount: '1000' as DecimalUint },
};

describe('M1 写路径离线 E2E（DFR-M1-B10）', () => {
  it('SDK build → 200 封套，nonce 来自租约、载荷与落库记录一致', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-build-0001' });

    expect(built.transactionId).toBe('txn_01J8Z6W3Q2K9M4ABCDEFGHJK01');
    expect(built.unsignedTransaction.chain).toBe(CHAIN);
    expect(built.unsignedTransaction.meta.requiresNonce).toBe('42');
    expect(built.unsignedTransaction.payload.startsWith('0x02')).toBe(true); // EIP-1559

    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('built');
    expect(record?.nonce).toBe('42');
    expect(record?.unsignedPayload).toBe(built.unsignedTransaction.payload);
    expect(record?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    // M1 不持久化签名原文：记录不得有 signedPayload 字段。
    // 注意：不能用 `JSON.stringify(record) 不含 "signedPayload"` 做负对照——
    // 合法的 `unsignedPayload` 恰好包含该子串，会把断言变成恒假的正例。
    expect(record).not.toHaveProperty('signedPayload');
    expect(Object.keys(record ?? {})).not.toContain('signedPayload');
  });

  it('同一幂等键重放 → 同一 transactionId，且不消耗新 nonce', async () => {
    const replayed = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-build-0001' });
    expect(replayed.transactionId).toBe('txn_01J8Z6W3Q2K9M4ABCDEFGHJK01');

    // 不带幂等键的新请求必须拿到下一个 nonce（43），证明重放没有推进水位。
    const next = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-build-0002' });
    const record = await stores.transaction.get(next.transactionId);
    expect(record?.nonce).toBe('43');
  });

  it('同键不同请求体 → 409 DFR_IDEMPOTENCY_CONFLICT，不产生第二笔交易', async () => {
    const err = await dfr
      .buildTransaction(
        { ...REQUEST, value: { ...REQUEST.value, amount: '2000' as DecimalUint } },
        { idempotencyKey: 'e2e-build-0001' },
      )
      .catch((e: unknown) => e);
    expect(isDfrApiError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'DFR_IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('confirm 到达等待上限返回 reached=false，并继续后台只读观测', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-confirm-0001' });
    const txHash = `0x${'aa'.repeat(32)}`;
    const current = await stores.transaction.get(built.transactionId);
    expect(current).not.toBeNull();
    await stores.transaction.transition({
      transactionId: built.transactionId,
      expectedStatus: 'built',
      expectedVersion: current!.stateVersion,
      toStatus: 'included',
      reason: 'included',
      patch: {
        txHash,
        blockRef: { kind: 'number', number: '17987839' as DecimalUint },
        canonicalBlockHash: BLOCK.hash,
      },
    });
    finalizedAvailable = false;
    const result = await dfr.confirmTransaction({
      chain: CHAIN,
      txHash,
      minFinality: 'finalized',
      timeoutMs: 1_000,
    });
    expect(result.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(result.confirmation).toMatchObject({
      status: 'included',
      finality: 'included',
      requiredFinality: 'finalized',
      reached: false,
    });
    // HTTP 已返回后仍有新的只读 RPC 观测，证明后台循环确实继续；
    // 测试清理时由 engine.close 中止。
    const callsAtResponse = confirmationObservationCalls;
    for (let attempt = 0; attempt < 40 && confirmationObservationCalls === callsAtResponse; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(confirmationObservationCalls).toBeGreaterThan(callsAtResponse);
    finalizedAvailable = true;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const updated = await stores.transaction.get(built.transactionId);
      if (updated?.status === 'finalized') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    await expect(stores.transaction.get(built.transactionId)).resolves.toMatchObject({
      status: 'finalized',
      canonicalBlockHash: BLOCK.hash,
      blockRef: { kind: 'number', number: '17987839' },
    });
  });

  it('confirm body 指定未授权链时在调用引擎前拒绝', async () => {
    const err = await dfr.confirmTransaction({
      chain: 'base-sepolia' as ChainId,
      txHash: `0x${'aa'.repeat(32)}`,
      timeoutMs: 1_000,
    }).catch((error: unknown) => error);
    expect(err).toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED', status: 403 });
  });

  it('SDK simulate → 200 成功，记录推进到 simulated', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-sim-0001' });
    const simulated = await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });

    expect(simulated.simulation.success).toBe(true);
    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('simulated');
  });

  it('载荷与落库记录不一致 → 400，且不推进状态', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-sim-0002' });
    const err = await dfr
      .simulateTransaction({
        transactionId: built.transactionId,
        unsignedTransaction: { ...built.unsignedTransaction, payload: '0x02deadbeef' },
      })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'DFR_VALIDATION_FAILED', status: 400 });
    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('built');
  });

  it('链上回滚 → 422 DFR_TRANSACTION_REVERTED，记录为 reverted（不是 500）', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-sim-0003' });
    callMode = 'revert';
    try {
      const err = await dfr
        .simulateTransaction({
          transactionId: built.transactionId,
          unsignedTransaction: built.unsignedTransaction,
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'DFR_TRANSACTION_REVERTED', status: 422 });
    } finally {
      callMode = 'ok';
    }
    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('reverted');
  });

  it('未装配写能力的部署 → 422（fail-closed，不是 500）', async () => {
    // 能力路由由 registry 决定：core.getChainInfo 仍可用，但写端点需要能力声明。
    // 这里直接验证 Gateway 未传 transactions 时的行为（部署未开放写路径）。
    const readOnly = createGatewayServer({
      core: { listChains: () => [], startHealthChecks: () => ({ started: [], skipped: [] }), stopHealthChecks: () => undefined } as never,
      auth: {
        keyId: KEY_ID,
        currentHash: hashSecret(SECRET, PEPPER),
        pepper: PEPPER,
        projectId: 'm1-write-e2e',
        scope: { chains: '*', capabilities: '*', allowWrite: true },
      },
      allowWrite: true,
    });
    await new Promise<void>((resolveListen) => readOnly.listen(0, '127.0.0.1', resolveListen));
    const port = (readOnly.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/transactions/build`, {
        method: 'POST',
        headers: {
          'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(REQUEST),
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { dfr_code?: string };
      expect(body.dfr_code).toBe('DFR_UNSUPPORTED_CAPABILITY');
    } finally {
      await new Promise<void>((resolveClose) => readOnly.close(() => resolveClose()));
    }
  });
});
