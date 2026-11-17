/**
 * M1 写路径端口装配测试（DFR-M1-B07）。
 *
 * 这里不mock：真实的 `DfrCore` + `EvmAdapter` + 可编程 Provider 替身走完整
 * Adapter → Provider 传输链，验证 composition root 装配出来的端口确实：
 *   1. 用 `eth_getTransactionCount(from,'pending')` 读 nonce 并转十进制字符串；
 *   2. 把引擎分配的 nonce 原样交给 Adapter build（不重新查 nonce）；
 *   3. simulate 使用记录里的 `from`（B03 载荷路径不含发送方，必须由这里补上）。
 */
import { describe, expect, it } from 'vitest';
import { DfrCore } from '@dfr/core';
import { EvmAdapter } from '@dfr/adapter-evm';
import { ChainRegistry } from '@dfr/registry';
import { createStubFetch, type StubCall } from '@dfr/provider';
import { newRequestId } from '@dfr/errors';
import type { AccountRef, Chain, ChainId, DecimalUint, TransactionId } from '@dfr/types';
import { createCoreTransactionChainPort } from '../src/transaction-port.js';

const CHAIN = 'ethereum-sepolia' as ChainId;
const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };
const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };
const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
  baseFeePerGas: '0x3b9aca00',
};

const registry = ChainRegistry.fromObject(
  {
    schemaVersion: '1',
  updatedAt: '2026-10-04T00:00:00Z',
  chains: {
    [CHAIN]: {
      displayName: 'Ethereum Sepolia',
      family: 'evm',
      network: 'testnet',
      externalChainId: '11155111',
      adapter: { id: 'evm', version: '^0.1.0' },
      finality: { kind: 'checkpoint', finalizedTag: true },
      finalityStatus: 'unverified',
      capabilities: [
        'account.balance',
        'block.read',
        'transaction.read',
        'transaction.build',
        'transaction.simulate',
      ],
      milestone: 'M1',
    },
  },
  providers: {
    'stub-primary': {
      chain: CHAIN,
      kind: 'json-rpc-http',
      endpointRef: 'env:DFR_B07_STUB_URL',
      credentialRef: 'none',
      priority: 10,
      weight: 1,
      timeoutMs: 5000,
      cost: { unit: 'request', priceUsd: '0' },
    },
    },
  },
  { env: { DFR_B07_STUB_URL: 'https://stub-primary.invalid' }, source: 'b07-port-test' },
);

function harness(): { port: ReturnType<typeof createCoreTransactionChainPort>; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchImpl = createStubFetch({
    onCall: (call) => calls.push(call),
    resolve: (call) => {
      switch (call.method) {
        case 'eth_chainId':
          return { kind: 'result', value: '0xaa36a7' };
        case 'eth_getTransactionCount':
          return { kind: 'result', value: '0x2a' };
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
        case 'eth_estimateGas':
          return { kind: 'result', value: '0x5208' };
        case 'eth_maxPriorityFeePerGas':
          return { kind: 'result', value: '0x3b9aca00' };
        case 'eth_getBlockByNumber':
          return { kind: 'result', value: call.params[0] === '0x112a87f' ? { ...BLOCK, number: '0x112a87f' } : BLOCK };
        case 'eth_call':
          return { kind: 'result', value: '0x' };
        case 'web3_clientVersion':
          return { kind: 'result', value: 'stub/1.0.0' };
        default:
          return { kind: 'rpc-error', code: -32601, message: `unsupported ${call.method}` };
      }
    },
  });

  const core = new DfrCore({
    registry,
    adapters: [
      { id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) },
    ],
    milestone: 'M1',
    fetchImpl,
    transactionStores: {
      // 本文件只测端口，不触碰 Store；任一被调用都说明装配越界。
      transaction: {} as never,
      idempotency: {} as never,
      nonce: {} as never,
      tracker: {} as never,
    },
  });
  return { port: createCoreTransactionChainPort(core), calls };
}

describe('createCoreTransactionChainPort（DFR-M1-B07 装配）', () => {
  it('getPendingNonce 读 eth_getTransactionCount(from,"pending") 并返回十进制字符串', async () => {
    const { port, calls } = harness();
    const nonce = await port.getPendingNonce!({
      chain: CHAIN,
      account: FROM,
      requestId: newRequestId(),
      signal: new AbortController().signal,
    });

    expect(nonce).toBe('42');
    expect(typeof nonce).toBe('string');
    const call = calls.find((c) => c.method === 'eth_getTransactionCount');
    expect(call?.params).toEqual([FROM.address, 'pending']);
  });

  it('build 把引擎分配的 nonce 原样交给 Adapter（不再查链上 nonce）', async () => {
    const { port, calls } = harness();
    const unsigned = await port.build({
      request: {
        chain: CHAIN,
        from: FROM,
        to: TO,
        value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' as DecimalUint },
        nonce: '42' as DecimalUint,
      },
      requestId: newRequestId(),
      signal: new AbortController().signal,
    });

    expect(unsigned.chain).toBe(CHAIN);
    expect(unsigned.meta.requiresNonce).toBe('42');
    expect(unsigned.meta.chainIdForSigning).toBe('11155111');
    // 显式 nonce 路径不得再读 nonce，否则租约与载荷可能不一致。
    expect(calls.filter((c) => c.method === 'eth_getTransactionCount')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'eth_estimateGas')).toHaveLength(1);
  });

  it('simulate 使用记录里的 from（载荷本身不含发送方）', async () => {
    const { port, calls } = harness();
    const unsigned = await port.build({
      request: {
        chain: CHAIN,
        from: FROM,
        to: TO,
        value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' as DecimalUint },
        nonce: '42' as DecimalUint,
      },
      requestId: newRequestId(),
      signal: new AbortController().signal,
    });
    calls.length = 0;

    const result = await port.simulate({
      transactionId: 'txn_test' as TransactionId,
      unsigned,
      from: FROM,
      requestId: newRequestId(),
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(true);
    const call = calls.find((c) => c.method === 'eth_call');
    const params = call?.params[0] as { from?: string; to?: string } | undefined;
    expect(params?.from).toBe(FROM.address);
    expect(params?.to).toBe(TO.address);
  });

  it('B43: EVM nonce does not use a Solana block-height expiry RPC', async () => {
    const { port, calls } = harness();
    const expired = await port.isSequencingExpired!({
      chain: CHAIN,
      token: { kind: 'nonce', value: '42' as DecimalUint },
      requestId: newRequestId(),
      signal: new AbortController().signal,
    });
    expect(expired).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('B43: missing blockhash expiry capability fails closed through the real Core port', async () => {
    const { port, calls } = harness();
    await expect(port.isSequencingExpired!({
      chain: CHAIN,
      token: {
        kind: 'blockhash',
        value: '11111111111111111111111111111111',
        lastValidBlockHeight: '100' as DecimalUint,
      },
      requestId: newRequestId(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
    expect(calls.some(c => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('broadcast 把记录真值（from + unsigned 载荷）随 options 传给 Core（M1-C03a）', async () => {
    // 这里用替身 Core：本用例只验证 composition root 的搬运，不重复 Adapter 的链语义测试。
    const captured: { chainId?: string; options?: Record<string, unknown> } = {};
    const stubCore = {
      async broadcastTransaction(
        chainId: string,
        _signed: unknown,
        _ctx: unknown,
        options: Record<string, unknown>,
      ) {
        captured.chainId = chainId;
        captured.options = options;
        return {
          ref: { kind: 'hash', hash: `0x${'ab'.repeat(32)}` },
          status: 'broadcast',
          accepted: true,
          observedAt: '2026-10-04T00:00:00.000Z',
        };
      },
    } as unknown as DfrCore;
    const port = createCoreTransactionChainPort(stubCore);

    await port.broadcast!({
      signed: {
        schemaVersion: '1',
        chain: CHAIN,
        unsigned: { schemaVersion: '1', chain: CHAIN, payload: '0x02aa', meta: {} },
        signedPayload: '0x02bb',
        expectedHash: `0x${'ab'.repeat(32)}`,
      },
      expected: { from: FROM, unsignedPayload: '0x02aa' },
      options: { rebroadcast: true },
      requestId: newRequestId(),
      signal: new AbortController().signal,
    });

    expect(captured.chainId).toBe(CHAIN);
    // 记录真值必须原样到达 Adapter 层；客户端回传的 unsigned 不能替代它。
    expect(captured.options?.['expectedFrom']).toEqual(FROM);
    expect(captured.options?.['expectedUnsignedPayload']).toBe('0x02aa');
    expect(captured.options?.['rebroadcast']).toBe(true);
  });

  it('confirm 经 Adapter 单次观测并由 Registry unverified 策略 fail-closed', async () => {
    const { port, calls } = harness();
    const result = await port.confirm!({
      chain: CHAIN,
      txHash: `0x${'aa'.repeat(32)}`,
      minFinality: 'finalized',
      requestId: newRequestId(),
      signal: new AbortController().signal,
    });
    expect(result.requiredFinality).toBe('finalized');
    expect(result.reached).toBe(false);
    expect(result.finality).toBe('finalized');
    expect(result.status).toBe('confirmed');
    expect(calls.filter((call) => call.method === 'eth_getTransactionByHash')).toHaveLength(1);
    expect(calls.some((call) => call.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('非 EVM 链族 fail-closed（不静默降级成别家 Adapter）', async () => {
    const { port } = harness();
    await expect(
      port.getPendingNonce!({
        chain: 'solana-devnet' as ChainId,
        account: { chain: 'solana-devnet' as ChainId, address: FROM.address },
        requestId: newRequestId(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'DFR_NOT_FOUND' });
  });
});
