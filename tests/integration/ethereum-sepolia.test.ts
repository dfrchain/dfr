/**
 * DFR-014: Ethereum Sepolia real read-only integration test.
 *
 * **Skipped** by default: CI and default local runs must not depend on public RPC (nondeterministic, quota-limited, flaky).
 * Enable explicitly:
 *
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL=https://<your Sepolia RPC> \
 *   pnpm vitest run tests/integration/ethereum-sepolia.test.ts
 *
 * Optional: DFR_TESTNET_TX_HASH=0x... verifies the transaction query path.
 *
 * This test only makes read-only calls: no signing, no broadcasting, no touching private keys (ADR-010).
 */
import { describe, expect, it } from 'vitest';
import { ChainRegistry, projectChain } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import { ProviderManager } from '@dfr/provider';
import { decodeTransactionPayload, EvmAdapter } from '@dfr/adapter-evm';
import { newRequestId } from '@dfr/errors';
import type { AdapterContext, ChainId } from '@dfr/types';

const RUN = process.env['DFR_RUN_TESTNET'] === '1';
const ENDPOINT = process.env['DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL'];
const ENABLED = RUN && ENDPOINT !== undefined && ENDPOINT !== '';
const CHAIN = 'ethereum-sepolia' as ChainId;

function makeCore(): DfrCore {
  const registry = ChainRegistry.load();
  return new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) }],
    milestone: 'M0',
  });
}

describe.skipIf(!ENABLED)('Ethereum Sepolia read-only integration test (DFR-014)', () => {
  const core = makeCore();
  const ctx = { requestId: newRequestId() };

  it('getInfo returns the real height and latest block hash, and chainId validation passes', async () => {
    const info = await core.getChainInfo(CHAIN, ctx);
    expect(info.chain).toBe(CHAIN);
    expect(info.network).toBe('testnet');
    expect(BigInt(info.height ?? '0')).toBeGreaterThan(0n);
    expect(info.latestBlockHash).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 30_000);

  it('getBalance returns a balance in the smallest decimal unit', async () => {
    const balance = await core.getBalance(
      {
        chain: CHAIN,
        // The zero address predictably has a balance (usually 0), used to verify the pipeline without depending on any account's balance.
        account: { chain: CHAIN, address: '0x0000000000000000000000000000000000000000' },
      },
      ctx,
    );
    expect(balance.amount).toMatch(/^[0-9]+$/);
    expect(balance.decimals).toBe(18);
  }, 30_000);

  it('getBlock(tag:finalized) returns a finalized block', async () => {
    const block = await core.getBlock(CHAIN, { kind: 'tag', tag: 'finalized' }, ctx);
    expect(block).not.toBeNull();
    expect(block?.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(block?.finality).toBe('finalized');
  }, 30_000);

  it('getBlock returns null for a nonexistent future height', async () => {
    const block = await core.getBlock(CHAIN, { kind: 'number', number: '999999999999' as never }, ctx);
    expect(block).toBeNull();
  }, 30_000);

  const txHash = process.env['DFR_TESTNET_TX_HASH'];
  it.skipIf(txHash === undefined)('getTransaction uses DFR_TESTNET_TX_HASH to verify transaction queries', async () => {
    const tx = await core.getTransaction(CHAIN, { kind: 'hash', hash: txHash as string }, ctx);
    expect(tx?.chain).toBe(CHAIN);
    expect(typeof tx?.status).toBe('string');
  }, 30_000);
});

describe.skipIf(ENABLED)('Ethereum Sepolia integration test (not enabled)', () => {
  it('skipped by default: set DFR_RUN_TESTNET=1 and an RPC endpoint, then run', () => {
    expect(ENABLED).toBe(false);
  });
});

/**
 * DFR-M1-B02: build an unsigned transaction on real Sepolia.
 *
 * Read-only + build-only: no signing, no broadcasting, no touching private keys. Skipped by default, same switch as the other real-network tests.
 * Use the Sepolia deposit contract address as `from` (that address has held a balance long-term), so `eth_estimateGas`
 * does not fail with "sender has no balance to pay for gas"; the transfer amount is 0, with no on-chain effect.
 */
describe.skipIf(!ENABLED)('Ethereum Sepolia build integration test (DFR-M1-B02, build-only)', () => {
  const FUNDED_FROM = '0x00000000219ab540356cBB839Cbe05303d7705Fa';

  it('build produces a decodable eip1559 unsigned payload on the real RPC', async () => {
    const registry = ChainRegistry.load();
    const entry = registry.listEntries().find((e) => e.id === CHAIN);
    if (entry === undefined) throw new Error(`registry is missing chain ${CHAIN}`);
    const chain = projectChain(entry);
    const adapter = new EvmAdapter({ chain });
    const providers = new ProviderManager({
      chain: CHAIN,
      descriptors: registry.listProviders(CHAIN),
      resolveEndpoint: (d) => registry.resolveEndpoint(d),
      resolveCredential: (d) => registry.resolveCredential(d),
    });
    const ctx: AdapterContext = {
      chain: CHAIN,
      network: chain.network,
      providers,
      signal: new AbortController().signal,
      requestId: newRequestId(),
    };

    const unsigned = await adapter.build(ctx, {
      chain: CHAIN,
      from: { chain: CHAIN, address: FUNDED_FROM },
      to: { chain: CHAIN, address: FUNDED_FROM },
      value: { asset: { kind: 'native', chain: CHAIN }, amount: '0' as never },
    });

    const decoded = decodeTransactionPayload(unsigned.payload);
    expect(unsigned.meta.encoding).toBe('hex');
    expect(decoded.type).toBe('eip1559');
    expect(decoded.chainId).toBe(chain.externalChainId);
    expect(decoded.signed).toBe(false);
    expect(decoded.nonce).toBe(unsigned.meta.requiresNonce);
    expect(BigInt(decoded.gas)).toBeGreaterThan(0n);
    expect(BigInt(decoded.maxFeePerGas ?? '0')).toBeGreaterThan(0n);
    expect(BigInt(decoded.maxPriorityFeePerGas ?? '0')).toBeGreaterThanOrEqual(0n);
  }, 30_000);
});
