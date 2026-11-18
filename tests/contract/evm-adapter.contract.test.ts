/**
 * EVM Adapter contract test (DFR-008 / M0 acceptance).
 *
 * Runs offline against a mock Provider; no RPC endpoint or credentials needed.
 * Assertions cover the adapter-spec Chapter 9 L1 checklist.
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
/** The decimal form of 0x112a000, for querying finalized blocks by height. */
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
  // EVM has no slot concept (only Solana does).
  unsupportedBlockRefs: [{ kind: 'slot', slot: '1' as never }],
  // The contract test must use a capability the Adapter genuinely has **not** implemented, or this negative
  // control for "undeclared capabilities must not silently downgrade" would spin idle. Since ADR-035 contract.read
  // is implemented; `event.subscribe` is still a **deployment-level** capability (ADR-025, provided by Core's
  // event bus, not implemented by the Adapter) — use it as the negative control.
  unsupportedCall: async (adapter, ctx) =>
    (adapter as unknown as { subscribe(a: AdapterContext, b: unknown): AsyncIterable<unknown> })
      .subscribe(ctx, {})[Symbol.asyncIterator]().next(),
});

describe('EVM Adapter read-only path (M0: getInfo / getBalance / getBlock / getTransaction)', () => {
  const adapter = new EvmAdapter({ chain });

  it('getInfo returns a decimal height and validates chainId', async () => {
    const ctx = makeContext(chain, handlers);
    const info = await adapter.getInfo(ctx);
    expect(info.family).toBe('evm');
    expect(info.chain).toBe(SEPOLIA);
    expect(info.height).toBe('18000000');
    expect(info.latestBlockHash).toBe(BLOCK_LATEST.hash);
    expect(info.nodeVersion).toBe('geth/v1.14.0-stable/linux-amd64/go1.21');
  });

  it('the same getInfo call reuses one Provider handle (that is what makes the chainId check meaningful)', async () => {
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
    // must land on the same endpoint, or the chainId check says nothing about where this data came from.
    expect((router as unknown as { acquired: number }).acquired).toBe(1);
  });

  it('chainId mismatch → DFR_CHAIN_MISMATCH (fail-closed)', async () => {
    const ctx = makeContext(chain, { ...handlers, eth_chainId: () => '0x1' });
    await expect(adapter.getInfo(ctx)).rejects.toMatchObject({ code: 'DFR_CHAIN_MISMATCH' });
  });

  it('getBalance returns the native asset with a smallest-unit decimal string', async () => {
    const ctx = makeContext(chain, handlers);
    const balance = await adapter.getBalance(ctx, { account: { chain: SEPOLIA, address: ADDRESS } });
    expect(balance.amount).toBe('1000000000000000000');
    expect(balance.decimals).toBe(18);
    expect(balance.asset).toEqual({ kind: 'native', chain: SEPOLIA });
  });

  it('token balances return DFR_UNSUPPORTED_CAPABILITY in M0, not faked success', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.getBalance(ctx, {
        account: { chain: SEPOLIA, address: ADDRESS },
        asset: { kind: 'token', chain: SEPOLIA, assetId: ADDRESS },
      }),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('getBlock supports tag:latest / tag:finalized / number, and returns finality', async () => {
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

    // A block above the finalized height can only be included; it must not be claimed finalized early.
    const notYet = await adapter.getBlock(ctx, { kind: 'number', number: '18000000' as never });
    expect(notYet?.finality).toBe('included');
  });

  it('getBlock returns null for a nonexistent block (distinguished from "chain unavailable")', async () => {
    const ctx = makeContext(chain, { ...handlers, eth_getBlockByNumber: () => null });
    expect(await adapter.getBlock(ctx, { kind: 'number', number: '1' as never })).toBeNull();
  });

  it('getTransaction returns a normalized transaction, with numeric fields as decimal strings', async () => {
    const ctx = makeContext(chain, handlers);
    const tx = await adapter.getTransaction(ctx, { kind: 'hash', hash: TX_HASH });
    expect(tx?.status).toBe('included');
    expect(tx?.nonce).toBe('42');
    expect(tx?.value?.amount).toBe('10000000000000000');
    expect(typeof tx?.value?.amount).toBe('string');
    expect(tx?.blockRef).toEqual({ kind: 'number', number: '18000000' });
  });

  it('getTransaction returns null for a nonexistent transaction', async () => {
    const ctx = makeContext(chain, { ...handlers, eth_getTransactionByHash: () => null });
    expect(await adapter.getTransaction(ctx, { kind: 'hash', hash: TX_HASH })).toBeNull();
  });

  it('getReceipt returns the success flag and actual fee (including the pricing asset)', async () => {
    const ctx = makeContext(chain, handlers);
    const receipt = await adapter.getReceipt(ctx, { kind: 'hash', hash: TX_HASH });
    expect(receipt?.success).toBe(true);
    expect(receipt?.gasUsed).toBe('21000');
    expect(receipt?.effectiveFee?.asset).toEqual({ kind: 'native', chain: SEPOLIA });
    expect(receipt?.effectiveFee?.amount).toBe('21000000000000');
  });

  it('invalid transaction hash → DFR_INVALID_REQUEST', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.getTransaction(ctx, { kind: 'hash', hash: '0xdeadbeef' }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_REQUEST' });
  });

  it('all read-only calls declare safe-read (the Provider layer retries on that basis)', async () => {
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
/* M1-B02: EVM build capability                                              */
/* ------------------------------------------------------------------ */

const TO_ADDRESS = '0x2222222222222222222222222222222222222222';
const TIP_HEX = '0x3b9aca00'; // 1 gwei
const GAS_ESTIMATE_HEX = '0x5208'; // 21000

/** Layers the RPCs build needs on top of the read-only handlers; uses overrides / delete to construct boundary scenarios. */
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
/* M1-C02: the contract side of broadcast capability (capability declaration + local validation failure must not emit a broadcast) */
/* ------------------------------------------------------------------ */

describe('EVM Adapter broadcast capability (M1-C02)', () => {
  const adapter = new EvmAdapter({ chain });

  it('capabilities() declares transaction.broadcast', () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.broadcast');
  });

  it('unsigned payload → DFR_TRANSACTION_REJECTED, and no eth_sendRawTransaction is emitted', async () => {
    const methods: string[] = [];
    const ctx = makeContext(chain, { ...handlers }, (method) => methods.push(method));

    // Unsigned payload: structurally valid but not a broadcastable signed transaction.
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
    // It must be the "unsigned" reason, not coincidentally blocked by some other check
    // (or this negative control would spin idle if the not_signed branch were removed).
    expect(isDfrError(error) && error.details?.['reason']).toBe('not_signed');
    // Key safety property: a local validation failure must never have already emitted a broadcast.
    expect(methods).toEqual([]);
  });
});

describe('EVM Adapter build capability (M1-B02, ADR-016 / m1-api-contract.md)', () => {
  const adapter = new EvmAdapter({ chain });

  it('capabilities() declares transaction.build', () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.build');
  });

  it('build reuses the same Provider handle and produces a decodable eip1559 unsigned payload', async () => {
    const router = createMockProviderRouter({ chain: chain.id, handlers: buildHandlers() });
    const ctx: AdapterContext = {
      chain: chain.id,
      network: chain.network,
      providers: router,
      signal: new AbortController().signal,
      requestId: BUILD_REQUEST_ID,
    };
    const unsigned = await adapter.build(ctx, BUILD_REQUEST);

    // nonce + gas + fee + chainId checks must land on the same endpoint (adapter-spec 8.1).
    expect((router as unknown as { acquired: number }).acquired).toBe(1);
    expect(unsigned.schemaVersion).toBe('1');
    expect(unsigned.chain).toBe(SEPOLIA);
    expect(unsigned.meta.encoding).toBe('hex');
    expect(unsigned.meta.chainIdForSigning).toBe('11155111');
    expect(unsigned.meta.requiresNonce).toBe('42');
    // Fee cap = gas × maxFeePerGas (21000 × 3 gwei), priced in the native coin.
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
    // maxFeePerGas = 2 × baseFee + tip (bounded headroom; see the delivery report decision).
    expect(decoded.maxFeePerGas).toBe('3000000000');
    expect(decoded.signed).toBe(false);
  });

  it('pending nonce comes from eth_getTransactionCount(from, "pending")', async () => {
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

  it('an explicit nonce takes priority, and the on-chain nonce is no longer queried', async () => {
    const methods: string[] = [];
    const ctx = buildContext(buildHandlers(), (m) => methods.push(m));
    const unsigned = await adapter.build(ctx, { ...BUILD_REQUEST, nonce: '7' as never });
    expect(methods).not.toContain('eth_getTransactionCount');
    expect(unsigned.meta.requiresNonce).toBe('7');
    expect(decodeTransactionPayload(unsigned.payload).nonce).toBe('7');
  });

  it('req.maxFee acts as the fee cap; below baseFee + tip it fails closed', async () => {
    const ctx = buildContext(buildHandlers());
    const capped = await adapter.build(ctx, { ...BUILD_REQUEST, maxFee: '5000000000' as never });
    expect(decodeTransactionPayload(capped.payload).maxFeePerGas).toBe('5000000000');

    await expect(
      adapter.build(ctx, { ...BUILD_REQUEST, maxFee: '1500000000' as never }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('endpoint chainId disagrees with the registry → DFR_CHAIN_MISMATCH, no payload is constructed', async () => {
    const ctx = buildContext(buildHandlers({ eth_chainId: () => '0x1' }));
    await expect(adapter.build(ctx, BUILD_REQUEST)).rejects.toMatchObject({
      code: 'DFR_CHAIN_MISMATCH',
    });
  });

  it('Provider returns an illegal hex quantity → DFR_PROVIDER_INVALID_RESPONSE (fail-closed)', async () => {
    const ctx = buildContext(buildHandlers({ eth_estimateGas: () => 'not-a-quantity' }));
    await expect(adapter.build(ctx, BUILD_REQUEST)).rejects.toMatchObject({
      code: 'DFR_PROVIDER_INVALID_RESPONSE',
    });
  });

  it('missing to (contract creation) → DFR_UNSUPPORTED_CAPABILITY', async () => {
    const ctx = buildContext(buildHandlers());
    const withoutTo = { ...BUILD_REQUEST } as Record<string, unknown>;
    delete withoutTo.to;
    await expect(adapter.build(ctx, withoutTo as never)).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_CAPABILITY',
    });
  });

  it('non-native value → DFR_INVALID_ASSET', async () => {
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

  it('build only issues safe-read calls; no broadcast / signing methods appear', async () => {
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
      expect(allowed.has(method), `build issued an unexpected RPC method ${method}`).toBe(true);
    }
    expect(methods).not.toContain('eth_sendRawTransaction');
    expect(methods).toContain('eth_estimateGas');
  });

  it('falls back to eth_feeHistory when eth_maxPriorityFeePerGas is unsupported; fails closed when neither is available', async () => {
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

  it('legacy transaction types use eth_gasPrice and do not request 1559 fee fields', async () => {
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

  it('all numeric fields in build output are decimal strings (no JS number)', async () => {
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

  it('build does not bypass the Provider to reach the network directly (fetch call count is 0)', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('Adapter must not access the network directly');
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
/* M1-B03: EVM simulate capability                                          */
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

/** An "execution reverted" error consistent with the Provider transport (error-spec §5.1 mapping). */
function revertedError(message = 'execution reverted: ERC20: transfer amount exceeds balance') {
  return createDfrError('DFR_TRANSACTION_REVERTED', {
    requestId: BUILD_REQUEST_ID,
    message: 'execution reverted',
    chain: SEPOLIA,
    chainError: { message },
  });
}

describe('EVM Adapter simulate capability (M1-B03)', () => {
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

  it('capabilities() declares transaction.simulate', () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.simulate');
  });

  it('simulate(TransactionRequest) reuses the same handle and normalizes success / cost / fee', async () => {
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

  it('eth_call revert → success=false + revertReason, no 500 thrown', async () => {
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

  it('eth_estimateGas revert is likewise normalized to success=false', async () => {
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

  it('a non-revert error (Provider unavailable) is thrown upward, not disguised as a revert', async () => {
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

  it('simulate(UnsignedTransaction) reuses the payload gas/fees and does not lie about the sender', async () => {
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
    // The payload carries no sender: it must be stated explicitly, not pretended equivalent to the zero address.
    expect(result.warnings?.join(' ')).toContain('sender');
    // A constructed payload is not re-estimated for gas (gas is already fixed by build).
    expect(methods).not.toContain('eth_estimateGas');
    expect(methods).toContain('eth_call');
    // eth_call must not carry a forged from.
    expect(callParams?.[0]).not.toHaveProperty('from');
    expect((callParams?.[0] as { to?: string })?.to).toBe(TO_ADDRESS);
  });

  it('simulate only issues safe-read throughout; chainId mismatch fails closed', async () => {
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

  it('simulate(UnsignedTransaction) chainId must match the request chain', async () => {
    const built = await adapter.build(buildContext(buildHandlers()), BUILD_REQUEST);
    const foreign = { ...built, chain: 'base-sepolia' as ChainId };
    await expect(adapter.simulate(buildContext(SIMULATE_HANDLERS), foreign as never)).rejects.toMatchObject(
      { code: 'DFR_CHAIN_MISMATCH' },
    );
  });
});
