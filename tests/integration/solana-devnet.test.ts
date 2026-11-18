/**
 * Solana devnet real read-only integration test (M2-A03).
 *
 * Skipped by default: CI and default local runs do not depend on public RPC.
 * Enable explicitly:
 *   DFR_RUN_SOLANA=1 pnpm vitest run tests/integration/solana-devnet.test.ts
 *
 * Read-only throughout: getVersion / getSlot / getLatestBlockhash / getAccountInfo / getBlock.
 */
import { describe, expect, it } from 'vitest';
import { DfrCore } from '@dfr/core';
import { SolanaAdapter } from '@dfr/adapter-solana';
import { EvmAdapter } from '@dfr/adapter-evm';
import { ChainRegistry } from '@dfr/registry';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';

const ENABLED = process.env['DFR_RUN_SOLANA'] === '1';
const DEVNET = 'solana-devnet' as never;
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

function makeCore(): DfrCore {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: 'https://api.devnet.solana.com',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://1rpc.io/sepolia',
    },
  });
  return new DfrCore({
    registry,
    // The M2 milestone loads all chains <= M2 (including EVM chains), so both Adapters must be registered.
    adapters: [
      { id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) },
      { id: 'solana', version: '0.1.0', create: (chain) => new SolanaAdapter({ chain }) },
    ],
    milestone: 'M2',
    // M1+ requires a complete transaction Store; this test only drives the read-only path, so a stand-in is enough
    // (the production path must use @dfr/storage-postgres, see ADR-014).
    transactionStores: createInMemoryTransactionStores(),
  });
}

const ctx = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  signal: new AbortController().signal,
};

describe.skipIf(!ENABLED)('Solana devnet real read-only integration test (M2-A03)', () => {
  it('Core loads solana-devnet under the M2 milestone', () => {
    expect(makeCore().listChains().map((c) => c.id)).toContain('solana-devnet');
  });

  it('getChainInfo returns the real slot and solana-core version', async () => {
    const info = await makeCore().getChainInfo(DEVNET, ctx);
    expect(info.family).toBe('solana');
    expect(BigInt(info.slot ?? '0')).toBeGreaterThan(100_000_000n);
    expect(info.height, 'must not fake an EVM height').toBeUndefined();
    expect(typeof info.nodeVersion).toBe('string');
  }, 30_000);

  it('getBalance returns the lamports of a Wrapped SOL account (decimal string)', async () => {
    const balance = await makeCore().getBalance(
      { chain: DEVNET, account: { chain: DEVNET, address: WRAPPED_SOL } },
      ctx,
    );
    expect(balance.decimals).toBe(9);
    expect(balance.asset).toEqual({ kind: 'native', chain: DEVNET });
    expect(/^\d+$/u.test(String(balance.amount))).toBe(true);
  }, 30_000);

  it('getBlock reads a block with a real slot (slot / blockhash consistent)', async () => {
    const core = makeCore();
    const info = await core.getChainInfo(DEVNET, ctx);
    const slot = (BigInt(info.slot!) - 32n).toString(10);
    const block = await core.getBlock(DEVNET, { kind: 'slot', slot: slot as never }, ctx);
    expect(block).not.toBeNull();
    expect(block!.slot).toBe(slot);
    expect(typeof block!.hash).toBe('string');
    expect(block!.number, 'a Solana block must not carry an EVM number').toBeUndefined();
  }, 30_000);

  it('getTransaction queries with a real signature (M2-B04)', async () => {
    const core = makeCore();
    // Take the most recent real signature of the Wrapped SOL account, then query by signature.
    const sig = await fetch('https://api.devnet.solana.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [WRAPPED_SOL, { limit: 1 }],
      }),
    })
      .then((r) => r.json() as Promise<{ result?: { signature: string }[] }>)
      .then((d) => d.result?.[0]?.signature);
    expect(typeof sig).toBe('string');

    const tx = await core.getTransaction(DEVNET, { kind: 'hash', hash: sig! }, ctx);
    expect(tx).not.toBeNull();
    expect(tx!.chain).toBe('solana-devnet');
    expect(['included', 'failed']).toContain(tx!.status);
    if (tx!.blockRef !== undefined) expect(tx!.blockRef.kind).toBe('slot');
    expect(tx!.nonce, 'a Solana transaction must not carry an EVM nonce').toBeUndefined();
    expect(tx!.fee).toBeDefined();
  }, 30_000);

  it('number-based lookup is explicitly rejected (fail-closed, not a silent downgrade)', async () => {
    await expect(
      makeCore().getBlock(DEVNET, { kind: 'number', number: '1' as never }, ctx),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  }, 30_000);
});
