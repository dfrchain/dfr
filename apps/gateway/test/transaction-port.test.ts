/**
 * M1 write-path port assembly test (DFR-M1-B07).
 *
 * No mocks here: a real `DfrCore` + `EvmAdapter` + programmable Provider stand-in walks the full
 * Adapter → Provider transport chain, verifying the port assembled by the composition root really:
 *   1. reads the nonce with `eth_getTransactionCount(from,'pending')` and converts it to a decimal string;
 *   2. hands the engine-allocated nonce to Adapter build as-is (without re-reading the nonce);
 *   3. simulate uses the record's `from` (the B03 payload path carries no sender, so it must be supplied here).
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
      // This file only tests the port and never touches the Store; any call to one means the assembly overreached.
      transaction: {} as never,
      idempotency: {} as never,
      nonce: {} as never,
      tracker: {} as never,
    },
  });
  return { port: createCoreTransactionChainPort(core), calls };
}

describe('createCoreTransactionChainPort (DFR-M1-B07 assembly)', () => {
  it('getPendingNonce reads eth_getTransactionCount(from,"pending") and returns a decimal string', async () => {
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

  it('build hands the engine-allocated nonce to the Adapter as-is (no longer reading the on-chain nonce)', async () => {
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
    // The explicit-nonce path must not read the nonce again, or the lease and payload could disagree.
    expect(calls.filter((c) => c.method === 'eth_getTransactionCount')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'eth_estimateGas')).toHaveLength(1);
  });

  it('simulate uses the record\'s from (the payload itself carries no sender)', async () => {
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

  it('broadcast passes the record\'s true values (from + unsigned payload) to Core with options (M1-C03a)', async () => {
    // A stand-in Core is used here: this case only verifies the composition root's carrying, not repeating the Adapter's chain-semantics tests.
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
    // The record's true values must reach the Adapter layer as-is; the unsigned echoed back by the client cannot substitute for them.
    expect(captured.options?.['expectedFrom']).toEqual(FROM);
    expect(captured.options?.['expectedUnsignedPayload']).toBe('0x02aa');
    expect(captured.options?.['rebroadcast']).toBe(true);
  });

  it('confirm observes once via the Adapter and fails closed under the Registry unverified policy', async () => {
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

  it('non-EVM chain families fail closed (never silently degrade to another family\'s Adapter)', async () => {
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
