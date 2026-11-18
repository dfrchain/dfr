/**
 * Solana Adapter contract test (M2-A03).
 *
 * **Calls `defineAdapterContract` directly** (ADR-025 / AGENTS.md §6):
 * generic assertions must not be changed to fit a new chain; chain-specific differences are expressed through
 * the chain object and capability declarations.
 *
 * Scope: M2 read-only (getInfo / getBalance / getBlock). The write path belongs to M3.
 */
import { describe, expect, it } from 'vitest';
import { SolanaAdapter } from '@dfr/adapter-solana';
import type { AdapterContext, BlockRef, Chain, ChainId } from '@dfr/types';
import { defineAdapterContract, makeContext } from './adapter-contract.js';
import { createMockProviderRouter } from './mock-provider.js';

const DEVNET = 'solana-devnet' as ChainId;
/** A valid 32-byte public key (base58): all 1s = the base58 representation of 32 zero bytes. */
const ADDRESS = '11111111111111111111111111111111';
/** 64 '1's = 64 zero bytes, a Solana signature in valid shape. */
const SIGNATURE = '1'.repeat(64);
/** Another valid base58 string of a different length (64 bytes), for asserting the signature-array >1 case. */
const SIGNATURE_2 = '2'.repeat(64);
const SLOT = 508_000_000;

/** The capabilities the registry actually declared at M2-A03 (see the solana-devnet section of chains.yaml). */
const chain: Chain = {
  id: DEVNET,
  displayName: 'Solana Devnet',
  family: 'solana',
  network: 'devnet',
  adapter: { id: 'solana', version: '^0.1.0' },
  finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.build', 'transaction.simulate', 'transaction.broadcast'],
};

const handlers = {
  getVersion: () => ({ 'solana-core': '4.4.0-beta.0', 'feature-set': 1855282951 }),
  getSlot: () => SLOT,
  getLatestBlockhash: () => ({ context: { slot: SLOT }, value: { blockhash: 'BLOCKHASH111', lastValidBlockHeight: SLOT + 150 } }),
  getAccountInfo: () => ({ context: { slot: SLOT }, value: { lamports: 1_000_000_000, owner: '11111111111111111111111111111111', executable: false } }),
  getBlock: () => ({
    blockhash: 'BLOCKHASH111',
    previousBlockhash: 'BLOCKHASH000',
    blockHeight: 1234,
    blockTime: 1_700_000_000,
    parentSlot: SLOT - 1,
    signatures: ['SIG1', 'SIG2'],
  }),
  getTransaction: () => ({
    slot: SLOT,
    blockTime: 1_700_000_000,
    transactionIndex: 3,
    version: 'legacy',
    transaction: {
      signatures: [SIGNATURE, SIGNATURE_2],
      message: { accountKeys: [ADDRESS, '11111111111111111111111111111111'], recentBlockhash: 'BLOCKHASH111' },
    },
    meta: { err: null, fee: 10_000, computeUnitsConsumed: 13_336, logMessages: [] },
  }),
};

defineAdapterContract({
  name: 'Solana Adapter',
  chain,
  createAdapter: (c) => new SolanaAdapter({ chain: c }),
  handlers,
  registryCapabilities: chain.capabilities,
  // Invalid address: contains '0', a character outside the base58 alphabet
  invalidAccount: '0invalidSolanaAddress000000000000000000',
  // ADR-027: Solana addresses by slot; number / tag / hash are all fail-closed.
  unsupportedBlockRefs: [
    { kind: 'number', number: '1' as never },
    { kind: 'tag', tag: 'latest' },
    { kind: 'hash', hash: 'BLOCKHASH111' },
  ],
  // Undeclared capability: contract.read (read-only contract/program calls) is not implemented yet → fail-closed.
  unsupportedCall: async (adapter, ctx) =>
    (adapter as unknown as { readContract(a: AdapterContext, b: unknown): Promise<unknown> }).readContract(ctx, {}),
});

describe('Solana Adapter read-only path (M2-A03)', () => {
  const adapter = new SolanaAdapter({ chain });

  it('getInfo returns slot and node version, and no EVM height', async () => {
    const ctx = makeContext(chain, handlers);
    const info = await adapter.getInfo(ctx);
    expect(info.family).toBe('solana');
    expect(info.chain).toBe(DEVNET);
    expect(info.slot).toBe(String(SLOT));
    expect(info.height, 'Solana must not return an EVM height').toBeUndefined();
    expect(info.nodeVersion).toBe('4.4.0-beta.0');
    expect(info.latestBlockHash).toBe('BLOCKHASH111');
  });

  it('getInfo reuses the same Provider handle', async () => {
    const router = createMockProviderRouter({ chain: chain.id, handlers });
    const ctx: AdapterContext = {
      chain: chain.id,
      network: chain.network,
      providers: router,
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await adapter.getInfo(ctx);
    expect((router as unknown as { acquired: number }).acquired).toBe(1);
  });

  it('getBalance returns a lamports decimal string with 9 decimals', async () => {
    const ctx = makeContext(chain, handlers);
    const balance = await adapter.getBalance(ctx, { account: { chain: DEVNET, address: ADDRESS } });
    expect(balance.amount).toBe('1000000000');
    expect(balance.decimals).toBe(9);
    expect(balance.asset).toEqual({ kind: 'native', chain: DEVNET });
  });

  it('when the account does not exist, lamports count as 0 (Solana semantics), not a not-found error', async () => {
    const ctx = makeContext(chain, { ...handlers, getAccountInfo: () => ({ context: { slot: SLOT }, value: null }) });
    const balance = await adapter.getBalance(ctx, { account: { chain: DEVNET, address: ADDRESS } });
    expect(balance.amount).toBe('0');
  });

  it('SPL token balances are explicitly unsupported, not faked as success', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.getBalance(ctx, {
        account: { chain: DEVNET, address: ADDRESS },
        asset: { kind: 'token', chain: DEVNET, assetId: ADDRESS },
      }),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('getBlock addresses by slot and returns slot/blockhash, not number', async () => {
    const ctx = makeContext(chain, handlers);
    const block = await adapter.getBlock(ctx, { kind: 'slot', slot: String(SLOT) as never });
    expect(block?.slot).toBe(String(SLOT));
    expect(block?.hash).toBe('BLOCKHASH111');
    expect(block?.number, 'Solana blocks must not carry an EVM number').toBeUndefined();
    expect(block?.parentHash).toBe('BLOCKHASH000');
    expect(block?.transactionCount).toBe(2);
  });

  it('number / tag / hash addressing fails explicitly in M2 (fail-closed, not silent downgrade)', async () => {
    const ctx = makeContext(chain, handlers);
    const refs: BlockRef[] = [
      { kind: 'number', number: '1' as never },
      { kind: 'tag', tag: 'latest' },
      { kind: 'hash', hash: 'BLOCKHASH111' },
    ];
    for (const ref of refs) {
      await expect(adapter.getBlock(ctx, ref), `${ref.kind} must be rejected`).rejects.toMatchObject({
        code: 'DFR_UNSUPPORTED_CAPABILITY',
      });
    }
  });

  it('a nonexistent slot returns null (distinguished from "chain unavailable")', async () => {
    const ctx = makeContext(chain, { ...handlers, getBlock: () => null });
    expect(await adapter.getBlock(ctx, { kind: 'slot', slot: '1' as never })).toBeNull();
  });
});

describe('Solana Adapter transaction queries (M2-B04)', () => {
  const adapter = new SolanaAdapter({ chain });

  it('getTransaction returns slot addressing, lamports fee, and included status', async () => {
    const ctx = makeContext(chain, handlers);
    const tx = await adapter.getTransaction(ctx, { kind: 'hash', hash: SIGNATURE });
    expect(tx).not.toBeNull();
    expect(tx!.chain).toBe(DEVNET);
    expect(tx!.status).toBe('included');
    expect(tx!.blockRef).toEqual({ kind: 'slot', slot: String(SLOT) });
    expect(tx!.fee?.amount).toBe('10000');
    expect(tx!.from?.address).toBe(ADDRESS);
    // Do not force EVM fields onto it: Solana has no nonce, and no single to/value.
    expect(tx!.nonce, 'Solana transactions must not carry an EVM nonce').toBeUndefined();
    expect(tx!.value, 'Solana transactions must not fabricate a single value').toBeUndefined();
  });

  it('meta.err non-null → status=failed with an error (no false success)', async () => {
    const ctx = makeContext(chain, {
      ...handlers,
      getTransaction: () => ({
        slot: SLOT,
        transaction: { signatures: [SIGNATURE], message: { accountKeys: [ADDRESS] } },
        meta: { err: { InstructionError: [0, 'Custom'] }, fee: 5_000 },
      }),
    });
    const tx = await adapter.getTransaction(ctx, { kind: 'hash', hash: SIGNATURE });
    expect(tx!.status).toBe('failed');
    expect(tx!.error?.code).toBe('DFR_TRANSACTION_REVERTED');
  });

  it('a nonexistent signature returns null', async () => {
    const ctx = makeContext(chain, { ...handlers, getTransaction: () => null });
    expect(await adapter.getTransaction(ctx, { kind: 'hash', hash: SIGNATURE })).toBeNull();
  });

  it('invalid signature → DFR_INVALID_REQUEST (shape validation in the Adapter)', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.getTransaction(ctx, { kind: 'hash', hash: 'not-a-signature' }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_REQUEST' });
  });

  it('getReceipt returns computeUnitsConsumed as gasUsed with a lamports fee', async () => {
    const ctx = makeContext(chain, handlers);
    const receipt = await adapter.getReceipt(ctx, { kind: 'hash', hash: SIGNATURE });
    expect(receipt).not.toBeNull();
    expect(receipt!.success).toBe(true);
    expect(receipt!.gasUsed).toBe('13336');
    expect(receipt!.effectiveFee?.amount).toBe('10000');
    expect(receipt!.blockRef).toEqual({ kind: 'slot', slot: String(SLOT) });
  });

  it('getReceipt returns null for an invalid signature (soft validation, no throw)', async () => {
    const ctx = makeContext(chain, handlers);
    expect(await adapter.getReceipt(ctx, { kind: 'hash', hash: 'bad!' })).toBeNull();
  });
});

describe('Solana ordering-prerequisite expiry semantics (M3-A01, ADR-032)', () => {
  const adapter = new SolanaAdapter({ chain });
  const blockhashToken = (lastValidBlockHeight: string) => ({
    kind: 'blockhash' as const,
    value: '1'.repeat(48) + '2345', // secret-scan:allow public-blockhash-placeholder
    lastValidBlockHeight: lastValidBlockHeight as never,
  });

  it('chain height <= lastValidBlockHeight → not expired; chain height > lastValidBlockHeight → expired', async () => {
    const fresh = makeContext(chain, { ...handlers, getBlockHeight: () => 1000 });
    // Boundary: chain height == lastValidBlockHeight → still usable (only **strictly greater** counts as expired).
    await expect(adapter.isSequencingExpired(fresh, blockhashToken('1000'))).resolves.toBe(false);
    await expect(adapter.isSequencingExpired(fresh, blockhashToken('1001'))).resolves.toBe(false);
    await expect(adapter.isSequencingExpired(fresh, blockhashToken('999'))).resolves.toBe(true);

    const stale = makeContext(chain, { ...handlers, getBlockHeight: () => 1001 });
    await expect(adapter.isSequencingExpired(stale, blockhashToken('1000'))).resolves.toBe(true);
  });

  it('judges by block height (not the local clock), comparing beyond the safe-integer range with decimal strings', async () => {
    const ctx = makeContext(chain, { ...handlers, getBlockHeight: () => 9_007_199_254_740_994 });
    // Comparing with JS numbers would lose precision; it must be exact here.
    await expect(
      adapter.isSequencingExpired(ctx, blockhashToken('9007199254740995')),
    ).resolves.toBe(false);
    await expect(
      adapter.isSequencingExpired(ctx, blockhashToken('9007199254740993')),
    ).resolves.toBe(true);
  });

  it('a non-blockhash token (EVM nonce) → DFR_INVALID_REQUEST, no guessing', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.isSequencingExpired(ctx, { kind: 'nonce', value: '1' as never }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_REQUEST' });
  });

  it('chain mismatch → DFR_CHAIN_MISMATCH (fail-closed)', async () => {
    const otherChain = 'ethereum-sepolia' as ChainId;
    const router = createMockProviderRouter({ chain: otherChain, handlers });
    const ctx: AdapterContext = {
      chain: otherChain,
      network: 'testnet',
      providers: router,
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await expect(adapter.isSequencingExpired(ctx, blockhashToken('1'))).rejects.toMatchObject({
      code: 'DFR_CHAIN_MISMATCH',
    });
  });
});
