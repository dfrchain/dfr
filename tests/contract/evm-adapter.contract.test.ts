/**
 * EVM Adapter 契约测试（DFR-008 / M0 验收）。
 *
 * 用 mock Provider 离线运行，不需要任何 RPC 端点或凭证。
 * 断言覆盖 adapter-spec 第 9 章 L1 清单。
 */
import { describe, expect, it } from 'vitest';
import {
  decodeTransactionPayload,
  encodeUnsignedTransaction,
  EvmAdapter,
} from '@dfr/adapter-evm';
import { createDfrError, isDfrError } from '@dfr/errors';
import type { AdapterContext, Chain, ChainId, TransactionRequest } from '@dfr/types';
import { defineAdapterContract, makeContext } from './adapter-contract.js';
import { createMockProviderRouter } from './mock-provider.js';

const SEPOLIA = 'ethereum-sepolia' as ChainId;
const ADDRESS = '0x1111111111111111111111111111111111111111';
const TX_HASH = `0x${'ab'.repeat(32)}`;

const chain: Chain = {
  id: SEPOLIA,
  displayName: 'Ethereum Sepolia',
  family: 'evm',
  network: 'testnet',
  externalChainId: '11155111',
  adapter: { id: 'evm', version: '^0.1.0' },
  finality: { kind: 'checkpoint', finalizedTag: true },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read'],
};

const BLOCK_LATEST = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: ['0xaa', '0xbb'],
  baseFeePerGas: '0x3b9aca00',
};
const BLOCK_FINALIZED = { ...BLOCK_LATEST, number: '0x112a000', hash: `0x${'33'.repeat(32)}` };
/** 0x112a000 的十进制形式，用于按高度查询已最终化区块。 */
const FINALIZED_HEIGHT = '17997824';

const handlers = {
  eth_chainId: () => '0xaa36a7',
  eth_blockNumber: () => '0x112a880',
  web3_clientVersion: () => 'geth/v1.14.0-stable/linux-amd64/go1.21',
  eth_getBlockByNumber: (params: readonly unknown[]) => {
    const tag = params[0];
    if (tag === 'finalized') return BLOCK_FINALIZED;
    if (typeof tag === 'string' && tag.startsWith('0x')) {
      if (BigInt(tag) === BigInt(BLOCK_FINALIZED.number)) return BLOCK_FINALIZED;
      return BLOCK_LATEST;
    }
    return BLOCK_LATEST;
  },
  eth_getBalance: () => '0xde0b6b3a7640000', // 1 ETH
  eth_getTransactionByHash: () => ({
    hash: TX_HASH,
    blockNumber: '0x112a880',
    blockHash: BLOCK_LATEST.hash,
    from: ADDRESS,
    to: '0x2222222222222222222222222222222222222222',
    value: '0x2386f26fc10000',
    nonce: '0x2a',
    gas: '0x5208',
    gasPrice: '0x3b9aca00',
  }),
  eth_getTransactionReceipt: () => ({
    transactionHash: TX_HASH,
    blockNumber: '0x112a880',
    blockHash: BLOCK_LATEST.hash,
    status: '0x1',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x3b9aca00',
  }),
};

defineAdapterContract({
  name: 'EVM Adapter',
  chain,
  createAdapter: (c) => new EvmAdapter({ chain: c }),
  handlers,
  registryCapabilities: chain.capabilities,
  invalidAccount: '0xnot-an-address',
  // EVM 没有 slot 概念（Solana 才有）。
  unsupportedBlockRefs: [{ kind: 'slot', slot: '1' as never }],
  // 契约测试必须用一个 Adapter 确实**未实现**的能力，否则这条"未声明能力不得静默降级"
  // 的负对照会空转。ADR-035 起 contract.read 已实现；`event.subscribe` 仍是**部署级**
  // 能力（ADR-025，由 Core 事件总线提供，Adapter 不实现）——用它做负对照。
  unsupportedCall: async (adapter, ctx) =>
    (adapter as unknown as { subscribe(a: AdapterContext, b: unknown): AsyncIterable<unknown> })
      .subscribe(ctx, {})[Symbol.asyncIterator]().next(),
});

describe('EVM Adapter 只读路径（M0：getInfo / getBalance / getBlock / getTransaction）', () => {
  const adapter = new EvmAdapter({ chain });

  it('getInfo 返回十进制高度并校验 chainId', async () => {
    const ctx = makeContext(chain, handlers);
    const info = await adapter.getInfo(ctx);
    expect(info.family).toBe('evm');
    expect(info.chain).toBe(SEPOLIA);
    expect(info.height).toBe('18000000');
    expect(info.latestBlockHash).toBe(BLOCK_LATEST.hash);
    expect(info.nodeVersion).toBe('geth/v1.14.0-stable/linux-amd64/go1.21');
  });

  it('同一次 getInfo 复用同一个 Provider 句柄（chainId 校验才有意义）', async () => {
    const router = createMockProviderRouter({ chain: chain.id, handlers });
    const ctx: AdapterContext = {
      chain: chain.id,
      network: chain.network,
      providers: router,
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await adapter.getInfo(ctx);
    // eth_chainId / eth_blockNumber / eth_getBlockByNumber / web3_clientVersion
    // 必须落在同一个端点上，否则 chainId 校验无法说明这一份数据的来源。
    expect((router as unknown as { acquired: number }).acquired).toBe(1);
  });

  it('chainId 不一致 → DFR_CHAIN_MISMATCH（fail-closed）', async () => {
    const ctx = makeContext(chain, { ...handlers, eth_chainId: () => '0x1' });
    await expect(adapter.getInfo(ctx)).rejects.toMatchObject({ code: 'DFR_CHAIN_MISMATCH' });
  });

  it('getBalance 返回原生资产与最小单位十进制字符串', async () => {
    const ctx = makeContext(chain, handlers);
    const balance = await adapter.getBalance(ctx, { account: { chain: SEPOLIA, address: ADDRESS } });
    expect(balance.amount).toBe('1000000000000000000');
    expect(balance.decimals).toBe(18);
    expect(balance.asset).toEqual({ kind: 'native', chain: SEPOLIA });
  });

  it('代币余额在 M0 返回 DFR_UNSUPPORTED_CAPABILITY，不伪装成功', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.getBalance(ctx, {
        account: { chain: SEPOLIA, address: ADDRESS },
        asset: { kind: 'token', chain: SEPOLIA, assetId: ADDRESS },
      }),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('getBlock 支持 tag:latest / tag:finalized / number，并返回 finality', async () => {
    const ctx = makeContext(chain, handlers);
    const latest = await adapter.getBlock(ctx, { kind: 'tag', tag: 'latest' });
    expect(latest?.number).toBe('18000000');
    expect(latest?.finality).toBe('included');
    expect(latest?.transactionCount).toBe(2);

    const finalized = await adapter.getBlock(ctx, { kind: 'tag', tag: 'finalized' });
    expect(finalized?.finality).toBe('finalized');

    const byNumber = await adapter.getBlock(ctx, { kind: 'number', number: FINALIZED_HEIGHT as never });
    expect(byNumber?.hash).toBe(BLOCK_FINALIZED.hash);
    expect(byNumber?.finality).toBe('finalized');

    // 高于 finalized 高度的区块只能是 included，不能提前宣称 finalized。
    const notYet = await adapter.getBlock(ctx, { kind: 'number', number: '18000000' as never });
    expect(notYet?.finality).toBe('included');
  });

  it('getBlock 对不存在的区块返回 null（与"链不可用"区分）', async () => {
    const ctx = makeContext(chain, { ...handlers, eth_getBlockByNumber: () => null });
    expect(await adapter.getBlock(ctx, { kind: 'number', number: '1' as never })).toBeNull();
  });

  it('getTransaction 返回归一化交易，数值字段是十进制字符串', async () => {
    const ctx = makeContext(chain, handlers);
    const tx = await adapter.getTransaction(ctx, { kind: 'hash', hash: TX_HASH });
    expect(tx?.status).toBe('included');
    expect(tx?.nonce).toBe('42');
    expect(tx?.value?.amount).toBe('10000000000000000');
    expect(typeof tx?.value?.amount).toBe('string');
    expect(tx?.blockRef).toEqual({ kind: 'number', number: '18000000' });
  });

  it('getTransaction 对不存在的交易返回 null', async () => {
    const ctx = makeContext(chain, { ...handlers, eth_getTransactionByHash: () => null });
    expect(await adapter.getTransaction(ctx, { kind: 'hash', hash: TX_HASH })).toBeNull();
  });

  it('getReceipt 返回成功标志与实际费用（含计价资产）', async () => {
    const ctx = makeContext(chain, handlers);
    const receipt = await adapter.getReceipt(ctx, { kind: 'hash', hash: TX_HASH });
    expect(receipt?.success).toBe(true);
    expect(receipt?.gasUsed).toBe('21000');
    expect(receipt?.effectiveFee?.asset).toEqual({ kind: 'native', chain: SEPOLIA });
    expect(receipt?.effectiveFee?.amount).toBe('21000000000000');
  });

  it('非法交易哈希 → DFR_INVALID_REQUEST', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.getTransaction(ctx, { kind: 'hash', hash: '0xdeadbeef' }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_REQUEST' });
  });

  it('所有只读调用都声明 safe-read（Provider 层据此重试）', async () => {
    const methods: string[] = [];
    const ctx = makeContext(chain, handlers, (m) => methods.push(m));
    await adapter.getInfo(ctx);
    await adapter.getBalance(ctx, { account: { chain: SEPOLIA, address: ADDRESS } });
    await adapter.getBlock(ctx, { kind: 'tag', tag: 'latest' });
    await adapter.getTransaction(ctx, { kind: 'hash', hash: TX_HASH });
    expect(methods).toContain('eth_chainId');
    expect(methods).toContain('eth_getBalance');
    expect(methods).toContain('eth_getBlockByNumber');
    expect(methods).toContain('eth_getTransactionByHash');
  });
});

/* ------------------------------------------------------------------ */
/* M1-B02：EVM build 能力                                             */
/* ------------------------------------------------------------------ */

const TO_ADDRESS = '0x2222222222222222222222222222222222222222';
const TIP_HEX = '0x3b9aca00'; // 1 gwei
const GAS_ESTIMATE_HEX = '0x5208'; // 21000

/** 在只读 handlers 上叠加 build 需要的 RPC；用 overrides / delete 制造边界场景。 */
function buildHandlers(
  overrides: Record<string, (params: readonly unknown[]) => unknown> = {},
): Record<string, (params: readonly unknown[]) => unknown> {
  return {
    ...handlers,
    eth_getTransactionCount: () => '0x2a', // pending nonce 42
    eth_maxPriorityFeePerGas: () => TIP_HEX,
    eth_gasPrice: () => '0x4a817c800', // 20 gwei
    eth_estimateGas: () => GAS_ESTIMATE_HEX,
    ...overrides,
  };
}

const BUILD_REQUEST: TransactionRequest = {
  chain: SEPOLIA,
  from: { chain: SEPOLIA, address: ADDRESS },
  to: { chain: SEPOLIA, address: TO_ADDRESS },
  value: { asset: { kind: 'native', chain: SEPOLIA }, amount: '1000000000000000' as never },
};

const BUILD_REQUEST_ID = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never;

function buildContext(
  handlerTable: Record<string, (params: readonly unknown[]) => unknown>,
  onCall?: (method: string) => void,
): AdapterContext {
  return {
    chain: chain.id,
    network: chain.network,
    providers: createMockProviderRouter({
      chain: chain.id,
      handlers: handlerTable,
      ...(onCall ? { onCall } : {}),
    }),
    signal: new AbortController().signal,
    requestId: BUILD_REQUEST_ID,
  };
}

/* ------------------------------------------------------------------ */
/* M1-C02：广播能力的契约面（能力声明 + 本地校验失败不得发出广播）          */
/* ------------------------------------------------------------------ */

describe('EVM Adapter broadcast 能力（M1-C02）', () => {
  const adapter = new EvmAdapter({ chain });

  it('capabilities() 声明 transaction.broadcast', () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.broadcast');
  });

  it('未签名载荷 → DFR_TRANSACTION_REJECTED，且不发出 eth_sendRawTransaction', async () => {
    const methods: string[] = [];
    const ctx = makeContext(chain, { ...handlers }, (method) => methods.push(method));

    // 未签名载荷：结构合法但不是可广播的已签名交易。
    const unsigned = encodeUnsignedTransaction({
      chainId: '11155111',
      nonce: '42',
      to: TO_ADDRESS,
      value: '1',
      gas: '21000',
      maxFeePerGas: '3000000000',
      maxPriorityFeePerGas: '1000000000',
      type: 'eip1559',
    });

    const error = await adapter
      .broadcast(ctx, {
        schemaVersion: '1',
        chain: SEPOLIA,
        unsigned: {
          schemaVersion: '1',
          chain: SEPOLIA,
          payload: unsigned.payload,
          meta: { encoding: 'hex', requiresNonce: '42' as never },
        },
        signedPayload: unsigned.payload,
        expectedHash: `0x${'11'.repeat(32)}`,
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    // 必须是"未签名"这一条原因，而不是碰巧被别的校验拦住
    // （否则移除 not_signed 分支时这条负对照会空转）。
    expect(isDfrError(error) && error.details?.['reason']).toBe('not_signed');
    // 关键安全属性：本地校验失败时绝不能已经发出广播。
    expect(methods).toEqual([]);
  });
});

describe('EVM Adapter build 能力（M1-B02，ADR-016 / m1-api-contract.md）', () => {
  const adapter = new EvmAdapter({ chain });

  it('capabilities() 声明 transaction.build', () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.build');
  });

  it('build 复用同一个 Provider 句柄，产出可解码的 eip1559 未签名载荷', async () => {
    const router = createMockProviderRouter({ chain: chain.id, handlers: buildHandlers() });
    const ctx: AdapterContext = {
      chain: chain.id,
      network: chain.network,
      providers: router,
      signal: new AbortController().signal,
      requestId: BUILD_REQUEST_ID,
    };
    const unsigned = await adapter.build(ctx, BUILD_REQUEST);

    // nonce + gas + fee + chainId 校验必须落在同一端点上（adapter-spec 8.1）。
    expect((router as unknown as { acquired: number }).acquired).toBe(1);
    expect(unsigned.schemaVersion).toBe('1');
    expect(unsigned.chain).toBe(SEPOLIA);
    expect(unsigned.meta.encoding).toBe('hex');
    expect(unsigned.meta.chainIdForSigning).toBe('11155111');
    expect(unsigned.meta.requiresNonce).toBe('42');
    // 费用上限 = gas × maxFeePerGas（21000 × 3 gwei），计价资产为原生币。
    expect(unsigned.meta.feeEstimate).toEqual({
      asset: { kind: 'native', chain: SEPOLIA },
      amount: '63000000000000',
    });

    const decoded = decodeTransactionPayload(unsigned.payload);
    expect(decoded.type).toBe('eip1559');
    expect(decoded.chainId).toBe('11155111');
    expect(decoded.nonce).toBe('42');
    expect(decoded.to).toBe(TO_ADDRESS);
    expect(decoded.value).toBe('1000000000000000');
    expect(decoded.gas).toBe('21000');
    expect(decoded.maxPriorityFeePerGas).toBe('1000000000');
    // maxFeePerGas = 2 × baseFee + tip（有界余量，见交付报告决策）。
    expect(decoded.maxFeePerGas).toBe('3000000000');
    expect(decoded.signed).toBe(false);
  });

  it('pending nonce 来自 eth_getTransactionCount(from, "pending")', async () => {
    let nonceParams: readonly unknown[] | undefined;
    const ctx = buildContext(
      buildHandlers({
        eth_getTransactionCount: (params) => {
          nonceParams = params;
          return '0x2a';
        },
      }),
    );
    const unsigned = await adapter.build(ctx, BUILD_REQUEST);
    expect(nonceParams).toEqual([ADDRESS, 'pending']);
    expect(unsigned.meta.requiresNonce).toBe('42');
  });

  it('显式 nonce 优先，且不再查询链上 nonce', async () => {
    const methods: string[] = [];
    const ctx = buildContext(buildHandlers(), (m) => methods.push(m));
    const unsigned = await adapter.build(ctx, { ...BUILD_REQUEST, nonce: '7' as never });
    expect(methods).not.toContain('eth_getTransactionCount');
    expect(unsigned.meta.requiresNonce).toBe('7');
    expect(decodeTransactionPayload(unsigned.payload).nonce).toBe('7');
  });

  it('req.maxFee 作为费用上限；低于 baseFee + tip 时 fail-closed', async () => {
    const ctx = buildContext(buildHandlers());
    const capped = await adapter.build(ctx, { ...BUILD_REQUEST, maxFee: '5000000000' as never });
    expect(decodeTransactionPayload(capped.payload).maxFeePerGas).toBe('5000000000');

    await expect(
      adapter.build(ctx, { ...BUILD_REQUEST, maxFee: '1500000000' as never }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('端点 chainId 与注册表不一致 → DFR_CHAIN_MISMATCH，不构造载荷', async () => {
    const ctx = buildContext(buildHandlers({ eth_chainId: () => '0x1' }));
    await expect(adapter.build(ctx, BUILD_REQUEST)).rejects.toMatchObject({
      code: 'DFR_CHAIN_MISMATCH',
    });
  });

  it('Provider 返回非法十六进制数量 → DFR_PROVIDER_INVALID_RESPONSE（fail-closed）', async () => {
    const ctx = buildContext(buildHandlers({ eth_estimateGas: () => 'not-a-quantity' }));
    await expect(adapter.build(ctx, BUILD_REQUEST)).rejects.toMatchObject({
      code: 'DFR_PROVIDER_INVALID_RESPONSE',
    });
  });

  it('缺少 to（合约创建）→ DFR_UNSUPPORTED_CAPABILITY', async () => {
    const ctx = buildContext(buildHandlers());
    const withoutTo = { ...BUILD_REQUEST } as Record<string, unknown>;
    delete withoutTo.to;
    await expect(adapter.build(ctx, withoutTo as never)).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_CAPABILITY',
    });
  });

  it('非原生 value → DFR_INVALID_ASSET', async () => {
    const ctx = buildContext(buildHandlers());
    await expect(
      adapter.build(ctx, {
        ...BUILD_REQUEST,
        value: {
          asset: { kind: 'token', chain: SEPOLIA, assetId: TO_ADDRESS },
          amount: '1' as never,
        },
      }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_ASSET' });
  });

  it('build 全程只发 safe-read 调用，不出现广播 / 签名方法', async () => {
    const methods: string[] = [];
    const ctx = buildContext(buildHandlers(), (m) => methods.push(m));
    await adapter.build(ctx, BUILD_REQUEST);

    const allowed = new Set([
      'eth_chainId',
      'eth_getTransactionCount',
      'eth_estimateGas',
      'eth_getBlockByNumber',
      'eth_maxPriorityFeePerGas',
      'eth_feeHistory',
    ]);
    for (const method of methods) {
      expect(allowed.has(method), `build 发出了未预期的 RPC 方法 ${method}`).toBe(true);
    }
    expect(methods).not.toContain('eth_sendRawTransaction');
    expect(methods).toContain('eth_estimateGas');
  });

  it('不支持 eth_maxPriorityFeePerGas 时回退 eth_feeHistory；两者都不可用则 fail-closed', async () => {
    const withHistory = buildHandlers({ eth_feeHistory: () => ({ reward: [['0x77359400']] }) });
    delete withHistory.eth_maxPriorityFeePerGas;
    const unsigned = await adapter.build(buildContext(withHistory), BUILD_REQUEST);
    expect(decodeTransactionPayload(unsigned.payload).maxPriorityFeePerGas).toBe('2000000000');

    const noTip = buildHandlers();
    delete noTip.eth_maxPriorityFeePerGas;
    await expect(adapter.build(buildContext(noTip), BUILD_REQUEST)).rejects.toMatchObject({
      code: 'DFR_CHAIN_UNAVAILABLE',
    });
  });

  it('legacy 交易类型使用 eth_gasPrice，不请求 1559 费用字段', async () => {
    const legacy = new EvmAdapter({ chain, transactionType: 'legacy' });
    const methods: string[] = [];
    const ctx = buildContext(buildHandlers(), (m) => methods.push(m));
    const unsigned = await legacy.build(ctx, BUILD_REQUEST);

    const decoded = decodeTransactionPayload(unsigned.payload);
    expect(decoded.type).toBe('legacy');
    expect(decoded.gasPrice).toBe('20000000000');
    expect(decoded.maxFeePerGas).toBeUndefined();
    expect(methods).not.toContain('eth_maxPriorityFeePerGas');
    expect(methods).not.toContain('eth_getBlockByNumber');
    expect(unsigned.meta.feeEstimate?.amount).toBe('420000000000000');
  });

  it('build 输出的数值字段全部是十进制字符串（无 JS number）', async () => {
    const ctx = buildContext(buildHandlers());
    const unsigned = await adapter.build(ctx, BUILD_REQUEST);
    expect(typeof unsigned.meta.requiresNonce).toBe('string');
    expect(typeof unsigned.meta.feeEstimate?.amount).toBe('string');

    const decoded = decodeTransactionPayload(unsigned.payload);
    const numeric = [decoded.nonce, decoded.value, decoded.gas, decoded.maxFeePerGas, decoded.maxPriorityFeePerGas];
    for (const value of numeric) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^(?:0|[1-9][0-9]*)$/u);
    }
  });

  it('build 不绕过 Provider 直接访问网络（fetch 调用次数为 0）', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('Adapter 不得直接访问网络');
    }) as typeof fetch;
    try {
      await adapter.build(buildContext(buildHandlers()), BUILD_REQUEST);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/* ------------------------------------------------------------------ */
/* M1-B03：EVM simulate 能力                                          */
/* ------------------------------------------------------------------ */

const SIMULATE_TO = '0x3333333333333333333333333333333333333333';
const SIMULATE_HANDLERS: Record<string, (params: readonly unknown[]) => unknown> = {
  ...buildHandlers(),
  eth_call: () => '0x',
};

const SIMULATE_REQUEST: TransactionRequest = {
  chain: SEPOLIA,
  from: { chain: SEPOLIA, address: ADDRESS },
  to: { chain: SEPOLIA, address: SIMULATE_TO },
  value: { asset: { kind: 'native', chain: SEPOLIA }, amount: '0' as never },
};

/** 与 Provider transport 一致的"执行回滚"错误（error-spec 第 5.1 章映射）。 */
function revertedError(message = 'execution reverted: ERC20: transfer amount exceeds balance') {
  return createDfrError('DFR_TRANSACTION_REVERTED', {
    requestId: BUILD_REQUEST_ID,
    message: '执行回滚',
    chain: SEPOLIA,
    chainError: { message },
  });
}

describe('EVM Adapter simulate 能力（M1-B03）', () => {
  const adapter = new EvmAdapter({ chain });

  it.each(['legacy', 'eip2930'] as const)(
    'simulate(TransactionRequest) reports the %s gas price as the estimated fee',
    async (transactionType) => {
      const priced = new EvmAdapter({ chain, transactionType });
      const ctx = buildContext({ ...SIMULATE_HANDLERS, eth_gasPrice: () => '0x3b9aca00' });
      const result = await priced.simulate(ctx, SIMULATE_REQUEST);
      expect(result.estimatedFee).toEqual({
        asset: { kind: 'native', chain: SEPOLIA },
        amount: '21000000000000',
      });
    },
  );

  it('capabilities() 声明 transaction.simulate', () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.simulate');
  });

  it('simulate(TransactionRequest) 复用同一句柄并归一化 success / cost / fee', async () => {
    const router = createMockProviderRouter({ chain: chain.id, handlers: SIMULATE_HANDLERS });
    const ctx: AdapterContext = {
      chain: chain.id,
      network: chain.network,
      providers: router,
      signal: new AbortController().signal,
      requestId: BUILD_REQUEST_ID,
    };
    const result = await adapter.simulate(ctx, SIMULATE_REQUEST);

    expect((router as unknown as { acquired: number }).acquired).toBe(1);
    expect(result.success).toBe(true);
    expect(result.estimatedCost).toBe('21000');
    expect(result.estimatedFee).toEqual({
      asset: { kind: 'native', chain: SEPOLIA },
      amount: '63000000000000',
    });
  });

  it('eth_call 回滚 → success=false + revertReason，不抛 500', async () => {
    const ctx = buildContext({
      ...SIMULATE_HANDLERS,
      eth_call: () => {
        throw revertedError();
      },
    });
    const result = await adapter.simulate(ctx, SIMULATE_REQUEST);
    expect(result.success).toBe(false);
    expect(result.revertReason).toContain('transfer amount exceeds balance');
  });

  it('eth_estimateGas 回滚同样归一化为 success=false', async () => {
    const ctx = buildContext({
      ...SIMULATE_HANDLERS,
      eth_estimateGas: () => {
        throw revertedError('execution reverted: panic: arithmetic overflow');
      },
    });
    const result = await adapter.simulate(ctx, SIMULATE_REQUEST);
    expect(result.success).toBe(false);
    expect(result.revertReason).toContain('arithmetic overflow');
  });

  it('非回滚错误（Provider 不可用）向上抛出，不伪装成回滚', async () => {
    const ctx = buildContext({
      ...SIMULATE_HANDLERS,
      eth_call: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: BUILD_REQUEST_ID,
          message: 'endpoint down',
          chain: SEPOLIA,
        });
      },
    });
    await expect(adapter.simulate(ctx, SIMULATE_REQUEST)).rejects.toMatchObject({
      code: 'DFR_PROVIDER_UNAVAILABLE',
    });
  });

  it('simulate(UnsignedTransaction) 复用载荷的 gas/费用，且不谎报发送方', async () => {
    const built = await adapter.build(buildContext(buildHandlers()), BUILD_REQUEST);

    let callParams: readonly unknown[] | undefined;
    const methods: string[] = [];
    const ctx = buildContext(
      {
        ...SIMULATE_HANDLERS,
        eth_call: (params) => {
          callParams = params;
          return '0x';
        },
      },
      (m) => methods.push(m),
    );
    const result = await adapter.simulate(ctx, built);

    expect(result.success).toBe(true);
    expect(result.estimatedCost).toBe('21000');
    expect(result.estimatedFee?.amount).toBe('63000000000000');
    // 载荷不携带发送方：必须显式提示，而不是假装用零地址就等价。
    expect(result.warnings?.join(' ')).toContain('发送方');
    // 已构造载荷不再重新估 gas（gas 已由 build 固定）。
    expect(methods).not.toContain('eth_estimateGas');
    expect(methods).toContain('eth_call');
    // eth_call 不得携带伪造的 from。
    expect(callParams?.[0]).not.toHaveProperty('from');
    expect((callParams?.[0] as { to?: string })?.to).toBe(TO_ADDRESS);
  });

  it('simulate 全程只发 safe-read，chainId 不符时 fail-closed', async () => {
    const methods: string[] = [];
    const ctx = buildContext(SIMULATE_HANDLERS, (m) => methods.push(m));
    await adapter.simulate(ctx, SIMULATE_REQUEST);
    expect(methods).toContain('eth_call');
    expect(methods).not.toContain('eth_sendRawTransaction');

    await expect(
      adapter.simulate(
        buildContext({ ...SIMULATE_HANDLERS, eth_chainId: () => '0x1' }),
        SIMULATE_REQUEST,
      ),
    ).rejects.toMatchObject({ code: 'DFR_CHAIN_MISMATCH' });
  });

  it('simulate(UnsignedTransaction) 的 chainId 必须与请求链一致', async () => {
    const built = await adapter.build(buildContext(buildHandlers()), BUILD_REQUEST);
    const foreign = { ...built, chain: 'base-sepolia' as ChainId };
    await expect(adapter.simulate(buildContext(SIMULATE_HANDLERS), foreign as never)).rejects.toMatchObject(
      { code: 'DFR_CHAIN_MISMATCH' },
    );
  });
});
