/**
 * EVM Adapter `logs()` (ADR-034) unit tests.
 *
 * Covers: eth_getLogs parameter construction, ChainLog mapping, the bounded-range red line, and fail-closed invalid input.
 */
import { describe, expect, it } from 'vitest';
import { EvmAdapter } from '../src/adapter.js';
import type { AdapterContext, BlockRef, Chain, ChainId, DecimalUint } from '@dfr/types';
import { createMockProviderRouter } from '../../../tests/contract/mock-provider.js';

const CHAIN = 'base-sepolia' as ChainId;
const chain: Chain = {
  id: CHAIN,
  displayName: 'Base Sepolia',
  family: 'evm',
  network: 'testnet',
  externalChainId: '84532',
  adapter: { id: 'evm', version: '^0.1.0' },
  finality: { kind: 'checkpoint', finalizedTag: true },
  finalityStatus: 'verified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'contract.logs'],
};
const ADDRESS = '0x1111111111111111111111111111111111111111';

function ctxWith(handlers: Record<string, (params: readonly unknown[]) => unknown>, onCall?: (m: string, c: { params: readonly unknown[] }) => void): AdapterContext {
  return {
    chain: CHAIN,
    network: 'testnet',
    providers: createMockProviderRouter({ chain: CHAIN, handlers, ...(onCall ? { onCall } : {}) }),
    signal: new AbortController().signal,
    requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  };
}

const RPC_LOG = {
  address: ADDRESS,
  // ERC-20 Transfer(address,address,uint256) topic0 (public constant).
  topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'], // secret-scan:allow erc20-transfer-topic0
  data: '0x' + '00'.repeat(32),
  blockNumber: '0x64',
  transactionHash: '0x' + 'ab'.repeat(32),
  transactionIndex: '0x2',
  logIndex: '0x5',
  removed: false,
};

const n = (v: string): BlockRef => ({ kind: 'number', number: v as DecimalUint });

describe('EVM Adapter logs (ADR-034)', () => {
  it('declares contract.logs, builds eth_getLogs params, and maps ChainLog', async () => {
    const adapter = new EvmAdapter({ chain });
    expect(adapter.capabilities().capabilities).toContain('contract.logs');

    const calls: Array<{ method: string; params: readonly unknown[] }> = [];
    const ctx = ctxWith({ eth_getLogs: () => [RPC_LOG] }, (m, c) => calls.push({ method: m, params: c.params }));
    const logs = await adapter.logs(ctx, { chain: CHAIN, address: ADDRESS, fromBlock: n('90'), toBlock: n('100') });

    expect(calls.filter((c) => c.method === 'eth_getLogs')).toHaveLength(1);
    const params = (calls[0]!.params[0]) as Record<string, unknown>;
    expect(params['fromBlock']).toBe('0x5a'); // 90
    expect(params['toBlock']).toBe('0x64'); // 100
    expect(params['address']).toBe(ADDRESS);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      address: ADDRESS,
      index: '5',
      txHash: '0x' + 'ab'.repeat(32),
      txIndex: '2',
      removed: false,
      blockRef: { kind: 'number', number: '100' },
    });
  });

  it('range wider than maxBlockRange → DFR_VALIDATION_FAILED (no truncation)', async () => {
    const adapter = new EvmAdapter({ chain, maxBlockRange: '100' as DecimalUint });
    const ctx = ctxWith({ eth_getLogs: () => [] });
    await expect(
      adapter.logs(ctx, { chain: CHAIN, fromBlock: n('1'), toBlock: n('200') }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('a range exactly equal to maxBlockRange is allowed (+1 boundary)', async () => {
    const adapter = new EvmAdapter({ chain, maxBlockRange: '100' as DecimalUint });
    const ctx = ctxWith({ eth_getLogs: () => [] });
    await expect(
      adapter.logs(ctx, { chain: CHAIN, fromBlock: n('1'), toBlock: n('100') }),
    ).resolves.toEqual([]);
  });

  it('toBlock < fromBlock → DFR_VALIDATION_FAILED', async () => {
    const adapter = new EvmAdapter({ chain });
    const ctx = ctxWith({ eth_getLogs: () => [] });
    await expect(
      adapter.logs(ctx, { chain: CHAIN, fromBlock: n('100'), toBlock: n('90') }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('tag/hash cannot be range endpoints → DFR_VALIDATION_FAILED', async () => {
    const adapter = new EvmAdapter({ chain });
    const ctx = ctxWith({ eth_getLogs: () => [] });
    await expect(
      adapter.logs(ctx, { chain: CHAIN, fromBlock: { kind: 'tag', tag: 'latest' }, toBlock: n('100') }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    await expect(
      adapter.logs(ctx, { chain: CHAIN, fromBlock: n('1'), toBlock: { kind: 'hash', hash: '0x' + 'aa'.repeat(32) } }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('invalid contract address → DFR_INVALID_ACCOUNT', async () => {
    const adapter = new EvmAdapter({ chain });
    const ctx = ctxWith({ eth_getLogs: () => [] });
    await expect(
      adapter.logs(ctx, { chain: CHAIN, address: '0xnothex', fromBlock: n('1'), toBlock: n('2') }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_ACCOUNT' });
  });

  it('limit truncates the number of returned entries', async () => {
    const adapter = new EvmAdapter({ chain });
    const many = Array.from({ length: 5 }, (_, i) => ({ ...RPC_LOG, logIndex: `0x${i.toString(16)}` }));
    const ctx = ctxWith({ eth_getLogs: () => many });
    const logs = await adapter.logs(ctx, { chain: CHAIN, fromBlock: n('1'), toBlock: n('2'), limit: 2 });
    expect(logs).toHaveLength(2);
  });

  it('query still runs without address (any contract)', async () => {
    const adapter = new EvmAdapter({ chain });
    const calls: Array<Record<string, unknown>> = [];
    const ctx = ctxWith({ eth_getLogs: (params) => { calls.push(params[0] as Record<string, unknown>); return []; } });
    await adapter.logs(ctx, { chain: CHAIN, fromBlock: n('1'), toBlock: n('2') });
    expect(calls[0]!['address']).toBeUndefined();
  });
});
