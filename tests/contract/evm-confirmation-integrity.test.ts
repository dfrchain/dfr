import { describe, expect, it } from 'vitest';
import { EvmAdapter } from '../../adapters/evm/src/adapter.js';
import type { AdapterContext, Chain, ChainId } from '@dfr/types';
import { createMockProviderRouter } from './mock-provider.js';

const chainId = 'base-sepolia' as ChainId;
const chain: Chain = {
  id: chainId, displayName: 'Base Sepolia', family: 'evm', network: 'testnet',
  externalChainId: '84532', adapter: { id: 'evm', version: '^0.1.0' },
  finality: { kind: 'checkpoint', finalizedTag: true }, finalityStatus: 'verified',
  capabilities: ['block.read', 'transaction.read'],
};
const hash = `0x${'11'.repeat(32)}`;
const blockHash = `0x${'22'.repeat(32)}`;
const otherHash = `0x${'33'.repeat(32)}`;
const tx = { hash, blockNumber: '0xa', blockHash, from: `0x${'44'.repeat(20)}`, to: null, value: '0x0', nonce: '0x0' };
const receipt = { transactionHash: hash, blockNumber: '0xa', blockHash, status: '0x1', gasUsed: '0x5208' };

function context(opts: { tx?: unknown; receipt?: unknown; canonicalHash?: string; canonicalHashes?: string[]; externalChainId?: string; latestNumber?: string } = {}): AdapterContext {
  let canonicalReads = 0;
  const providers = createMockProviderRouter({
    chain: chainId,
    handlers: {
      eth_chainId: () => opts.externalChainId ?? '0x14a34',
      eth_getTransactionByHash: () => opts.tx === undefined ? tx : opts.tx,
      eth_getTransactionReceipt: () => opts.receipt === undefined ? receipt : opts.receipt,
      eth_getBlockByNumber: (params) => params[0] === '0xa'
        ? { number: '0xa', hash: opts.canonicalHashes?.[canonicalReads++] ?? opts.canonicalHash ?? blockHash }
        : { number: params[0] === 'latest' ? opts.latestNumber ?? '0x20' : '0x20', hash: otherHash },
    },
  });
  return { chain: chainId, network: 'testnet', providers, signal: new AbortController().signal,
    requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never };
}

describe('EVM confirmation binds receipt and canonical block', () => {
  const adapter = new EvmAdapter({ chain });
  it('does not finalize when receipt is missing', async () => {
    expect(await adapter.observeConfirmation(context({ receipt: null }), { txHash: hash })).toBeNull();
  });
  it('rejects an RPC endpoint serving a different chain', async () => {
    await expect(adapter.observeConfirmation(context({ externalChainId: '0x1' }), { txHash: hash }))
      .rejects.toMatchObject({ code: 'DFR_CHAIN_MISMATCH' });
  });
  it('rejects inconsistent receipt, status and canonical block', async () => {
    for (const inconsistent of [
      { ...receipt, transactionHash: otherHash },
      { ...receipt, blockHash: otherHash },
      { ...receipt, blockNumber: '0xb' },
      { ...receipt, status: undefined },
      { ...receipt, status: '0x2' },
    ]) {
      expect(await adapter.observeConfirmation(context({ receipt: inconsistent }), { txHash: hash })).toBeNull();
    }
    expect(await adapter.observeConfirmation(context({ canonicalHash: otherHash }), { txHash: hash })).toBeNull();
    expect(await adapter.observeConfirmation(context({ tx: { ...tx, hash: otherHash } }), { txHash: hash })).toBeNull();
    expect(await adapter.observeConfirmation(context({ tx: { ...tx, blockHash: null } }), { txHash: hash })).toBeNull();
  });
  it('does not finalize a block above the reported chain head', async () => {
    expect(await adapter.observeConfirmation(context({ latestNumber: '0x9' }), { txHash: hash })).toBeNull();
  });
  it('rejects a reorg observed during confirmation', async () => {
    expect(await adapter.observeConfirmation(context({ canonicalHashes: [blockHash, otherHash] }), { txHash: hash })).toBeNull();
  });
  it('preserves successful and reverted observations with matching canonical facts', async () => {
    expect(await adapter.observeConfirmation(context(), { txHash: hash })).toMatchObject({ status: 'finalized', finality: 'finalized' });
    expect(await adapter.observeConfirmation(context({ receipt: { ...receipt, status: '0x0' } }), { txHash: hash }))
      .toMatchObject({ status: 'reverted' });
  });
});
