// M1 广播写路径离线 E2E（DFR-M1-E03 前置）。
//
// 链路：SDK → Gateway → Core → EVM Adapter → Provider 替身 → TransactionEngine（测试替身 Store）
//
// 与 `m1-write.e2e.test.ts`（build/simulate/confirm）的区别：本文件把**真实签名**接入
// 完整 HTTP 写路径，验证 C02/C03 的广播语义在启用 `transaction.broadcast` 能力后端到端成立：
//   1. 能力启用后广播端点不再返回 422 DFR_UNSUPPORTED_CAPABILITY；
//   2. `eth_sendRawTransaction` 在整个请求中**恰好一次**（non-idempotent-write，绝不重试/切换重发）；
//   3. 记录状态推进 built → simulated → sign(signed) → broadcast，且 expectedHash/txHash 落库；
//   4. 客户端改过的签名载荷（换 nonce / 换收款人）被绑定校验拒绝，且**不发出广播**；
//   5. 记录里永远没有 `signedPayload`（签名原文不持久化）。
//
// 私钥在运行时从常量派生（仓库内无私钥字面量），与 adapters/evm/test/broadcast.test.ts 同一做法。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import {
  createGatewayServer,
  createCoreTransactionChainPort,
  hashSecret,
  TokenBucketLimiter,
} from '@dfr/gateway';
import { createStubFetch } from '@dfr/provider';
import { ChainRegistry } from '@dfr/registry';
import { DFR, isDfrApiError } from '@dfr/sdk-typescript';
import { TransactionEngine } from '@dfr/transaction';
import type { AccountRef, Chain, ChainId, DecimalUint, TransactionId } from '@dfr/types';
import { createInMemoryTransactionStores } from './support/in-memory-transaction-stores.js';
// 签名辅助放在 adapters/evm/test 下：viem 只能存在于 EVM Adapter（ADR-016 §2）。
import {
  addressOf,
  deriveTestPrivateKey,
  signUnsignedPayload,
  transactionHashOf,
} from '../../adapters/evm/test/support/external-signer.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN = 'ethereum-sepolia' as ChainId;
const CHAIN_ID = 11155111;
const SECRET = 'm1BroadcastE2eSecret0123456789abc';
const PEPPER = 'm1-broadcast-e2e-pepper';
const KEY_ID = 'M1Brcast'; // 恰好 8 位 [A-Za-z0-9]

/** 运行时派生的测试私钥；仓库内不出现私钥字面量。 */
const TEST_KEY = deriveTestPrivateKey('dfr-m1-e03-broadcast-signer');
const FROM = { chain: CHAIN, address: addressOf(TEST_KEY) } as AccountRef;
const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };

const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
  baseFeePerGas: '0x3b9aca00',
};

/** 每一次 `eth_sendRawTransaction` 的载荷；用于断言"恰好一次"。 */
const rawSends: string[] = [];
/** 广播应答开关：`already-known` 是幂等成功，不是错误。 */
let sendMode: 'ok' | 'already-known' | 'boom' = 'ok';

const stubFetch = createStubFetch({
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
        return { kind: 'result', value: BLOCK };
      case 'eth_call':
        return { kind: 'result', value: '0x' };
      case 'eth_getTransactionByHash':
        return { kind: 'result', value: null };
      case 'eth_sendRawTransaction': {
        const payload = String(call.params[0]);
        rawSends.push(payload);
        if (sendMode === 'boom') {
          return { kind: 'rpc-error', code: -32000, message: 'insufficient funds for gas * price + value' };
        }
        if (sendMode === 'already-known') {
          return { kind: 'rpc-error', code: -32000, message: 'already known' };
        }
        // 真实端点返回交易哈希 = keccak256(已签名载荷)。
        return { kind: 'result', value: transactionHashOf(payload) };
      }
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
    newTransactionId: () =>
      `txn_01J8Z6W3Q2K9M4ABCDEFGHJK${String(nextTransactionNumber++).padStart(2, '0')}` as TransactionId,
  });
  const created = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'm1-broadcast-e2e',
      scope: { chains: [CHAIN], capabilities: '*', allowWrite: true },
    },
    allowWrite: true,
    transactions: engine,
    // 本文件在单个测试进程里连续发多次写请求（build+simulate+broadcast × 4 用例），
    // 会超过默认写桶（容量 10 / 2rps）。这里只放大限流，不改变被测行为——
    // 限流本身由 apps/gateway/test/gateway.test.ts 单独覆盖。
    limiter: new TokenBucketLimiter({
      read: { capacity: 1_000, refillPerSecond: 1_000 },
      write: { capacity: 1_000, refillPerSecond: 1_000 },
      stream: { capacity: 100, refillPerSecond: 100 },
    }),
  });
  server = created;
  await new Promise<void>((resolveListen) => created.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
  dfr = new DFR({ apiKey: `dfr_${KEY_ID}_${SECRET}`, baseUrl });
});

afterAll(async () => {
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

/**
 * 模拟"调用方自己的签名器"：把 build 产出的未签名载荷解回字段，用测试私钥重新签名。
 * `overrides` 用于构造绑定不一致的负对照。
 */
function externalSign(
  unsignedPayload: string,
  overrides: { nonce?: bigint; to?: string } = {},
) {
  return signUnsignedPayload({
    unsignedPayload,
    privateKey: TEST_KEY,
    chainId: CHAIN_ID,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  });
}

describe('M1 广播写路径离线 E2E（DFR-M1-E03 前置）', () => {
  it('能力启用后：build → 外部签名 → simulate → broadcast 全链路成功，且只广播一次', async () => {
    rawSends.length = 0;
    sendMode = 'ok';

    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-bc-0001' });
    expect(built.unsignedTransaction.meta.requiresNonce).toBe('42');

    const simulated = await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    expect(simulated.simulation.success).toBe(true);

    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);
    const result = await dfr.broadcastTransaction(
      {
        transactionId: built.transactionId,
        signedTransaction: {
          schemaVersion: '1',
          chain: CHAIN,
          unsigned: built.unsignedTransaction,
          signedPayload,
          expectedHash,
        },
      },
      { idempotencyKey: 'e2e-bc-0001-broadcast' },
    );

    expect(result.broadcast.accepted).toBe(true);
    expect(result.broadcast.txHash).toBe(expectedHash);
    // 恰好一次：Provider 层对 non-idempotent-write 绝不重试。
    expect(rawSends).toEqual([signedPayload]);

    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('broadcast');
    expect(record?.txHash).toBe(expectedHash);
    expect(record?.expectedHash).toBe(expectedHash);
    // 签名原文永不落库。
    expect(record).not.toHaveProperty('signedPayload');
  });

  it('already known 视为幂等成功（不重复广播出第二次）', async () => {
    rawSends.length = 0;
    sendMode = 'already-known';

    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-bc-0002' });
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);
    const result = await dfr.broadcastTransaction(
      {
        transactionId: built.transactionId,
        signedTransaction: {
          schemaVersion: '1',
          chain: CHAIN,
          unsigned: built.unsignedTransaction,
          signedPayload,
          expectedHash,
        },
      },
      { idempotencyKey: 'e2e-bc-0002-broadcast' },
    );

    expect(result.broadcast.accepted).toBe(true);
    expect(rawSends).toHaveLength(1);
  });

  it('签名载荷与记录不一致（换 nonce）→ 403/422 拒绝，且不发出广播', async () => {
    rawSends.length = 0;
    sendMode = 'ok';

    const built = await dfr.buildTransaction(
      { ...REQUEST, value: { ...REQUEST.value, amount: '3000' as DecimalUint } },
      { idempotencyKey: 'e2e-bc-0003' },
    );
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    // 用不同的 nonce 签名：签名有效，但与记录绑定的未签名载荷不符。
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload, {
      nonce: 9999n,
    });

    const error = await dfr
      .broadcastTransaction(
        {
          transactionId: built.transactionId,
          signedTransaction: {
            schemaVersion: '1',
            chain: CHAIN,
            unsigned: built.unsignedTransaction,
            signedPayload,
            expectedHash,
          },
        },
        { idempotencyKey: 'e2e-bc-0003-broadcast' },
      )
      .catch((e: unknown) => e);

    expect(isDfrApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: expect.any(Number) });
    // 关键安全属性：本地绑定校验失败时绝不发广播。
    expect(rawSends).toEqual([]);
  });

  it('TX-02: 单节点余额不足拒绝并不证明签名交易从未传播；记录保持 unknown', async () => {
    rawSends.length = 0;
    sendMode = 'boom';

    const built = await dfr.buildTransaction(
      { ...REQUEST, value: { ...REQUEST.value, amount: '4000' as DecimalUint } },
      { idempotencyKey: 'e2e-bc-0004' },
    );
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);

    const error = await dfr
      .broadcastTransaction(
        {
          transactionId: built.transactionId,
          signedTransaction: {
            schemaVersion: '1',
            chain: CHAIN,
            unsigned: built.unsignedTransaction,
            signedPayload,
            expectedHash,
          },
        },
        { idempotencyKey: 'e2e-bc-0004-broadcast' },
      )
      .catch((e: unknown) => e);

    expect(isDfrApiError(error)).toBe(true);
    expect(rawSends).toHaveLength(1); // 发送过，但端点拒绝
    const record = await stores.transaction.get(built.transactionId);
    // RPC response is not a global proof of non-propagation. The durable
    // signed hash stays observable and its nonce cannot be released blindly.
    expect(record?.status).toBe('unknown');
    expect(record?.expectedHash).toBe(expectedHash);
  });

  it('重播：dropped 记录 + rebroadcast:true → 202 且只广播一次（TODO-012 端到端）', async () => {
    rawSends.length = 0;
    sendMode = 'ok';

    // 用真实签名走完整路径：build → simulate → 外部签名 → 把记录置为 dropped
    //（模拟"已广播后被 mempool 丢弃"），再重播。这样 Adapter 的签名绑定校验
    // 面对的是真实 EIP-1559 载荷，而不是占位字节。
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-rb-0001' });
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const record = await stores.transaction.get(built.transactionId);
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);

    // 直接推进到 dropped（测试替身不做状态机校验，正是为了能构造这个起点）。
    await stores.transaction.transition({
      transactionId: built.transactionId,
      expectedStatus: record!.status,
      expectedVersion: record!.stateVersion,
      toStatus: 'dropped' as never,
      reason: 'dropped' as never,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
      patch: { expectedHash } as never,
    } as never);

    const result = await dfr.broadcastTransaction(
      {
        transactionId: built.transactionId,
        signedTransaction: {
          schemaVersion: '1',
          chain: CHAIN,
          unsigned: built.unsignedTransaction,
          signedPayload,
          expectedHash,
        },
      },
      { idempotencyKey: 'e2e-rb-0001-broadcast', rebroadcast: true },
    );

    expect(result.broadcast.rebroadcast).toBe(true);
    expect(result.broadcast.accepted).toBe(true);
    // 重播仍只发出一次 non-idempotent-write。
    expect(rawSends).toHaveLength(1);
    expect((await stores.transaction.get(built.transactionId))?.status).toBe('broadcast');
  });

  it('重播负对照：非 dropped 状态传 rebroadcast:true → 拒绝且零广播', async () => {
    rawSends.length = 0;
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-rb-0002' });
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);

    const error = await dfr
      .broadcastTransaction(
        {
          transactionId: built.transactionId,
          signedTransaction: {
            schemaVersion: '1',
            chain: CHAIN,
            unsigned: built.unsignedTransaction,
            signedPayload,
            expectedHash,
          },
        },
        { idempotencyKey: 'e2e-rb-0002-broadcast', rebroadcast: true },
      )
      .catch((e: unknown) => e);

    expect(isDfrApiError(error)).toBe(true);
    // 关键：simulated 状态不允许重播，且**零广播**。
    expect(rawSends).toEqual([]);
  });
});
