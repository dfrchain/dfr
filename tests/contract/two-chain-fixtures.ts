/**
 * Shared fixture for the two-chain L3 comparison (M2-D01).
 *
 * Declares, per chain, "how to construct the Adapter / which mock responses to use / which differences are
 * explicitly rejected"; the comparison test only runs the **same** assertions.
 */
import { EvmAdapter } from '@dfr/adapter-evm';
import { SolanaAdapter } from '@dfr/adapter-solana';
import type { AdapterContext, AdapterCapabilities, BlockRef, Chain, ChainId } from '@dfr/types';
import { makeContext } from './adapter-contract.js';
import type { Handler } from './mock-provider.js';

const EVM_CHAIN = 'ethereum-sepolia' as ChainId;
const SOLANA_CHAIN = 'solana-devnet' as ChainId;

export interface ChainFixture {
  readonly chain: Chain;
  /** BlockRef branches this chain **explicitly rejects** (differences expressed as data, not as "some assertion did not run"). */
  readonly unsupportedBlockRefs: readonly BlockRef[];
  readonly invalidAccount: string;
  /** Run one "invalid account" query in this chain's mock environment. */
  getBalanceWithInvalidAccount(): Promise<unknown>;
  /** Query a block by the given ref in this chain's mock environment. */
  getBlockRef(ref: BlockRef): Promise<unknown>;
  /** Capabilities declared by this chain's Adapter. */
  capabilities(): AdapterCapabilities;
}

function build(input: {
  readonly chain: Chain;
  readonly handlers: Record<string, Handler>;
  readonly invalidAccount: string;
  readonly unsupportedBlockRefs: readonly BlockRef[];
  readonly create: (chain: Chain) => {
    capabilities(): AdapterCapabilities;
    getBalance(ctx: AdapterContext, req: never): Promise<unknown>;
    getBlock(ctx: AdapterContext, ref: BlockRef): Promise<unknown>;
  };
}): ChainFixture {
  return {
    chain: input.chain,
    invalidAccount: input.invalidAccount,
    unsupportedBlockRefs: input.unsupportedBlockRefs,
    capabilities: () => input.create(input.chain).capabilities(),
    async getBalanceWithInvalidAccount() {
      const ctx = makeContext(input.chain, input.handlers);
      return input.create(input.chain).getBalance(ctx, {
        account: { chain: input.chain.id, address: input.invalidAccount },
      } as never);
    },
    async getBlockRef(ref: BlockRef) {
      const ctx = makeContext(input.chain, input.handlers);
      return input.create(input.chain).getBlock(ctx, ref);
    },
  };
}

export const EVM_FIXTURE: ChainFixture = build({
  chain: {
    id: EVM_CHAIN,
    displayName: 'Ethereum Sepolia',
    family: 'evm',
    network: 'testnet',
    externalChainId: '11155111',
    adapter: { id: 'evm', version: '^0.1.0' },
    finality: { kind: 'checkpoint', finalizedTag: true },
    finalityStatus: 'verified',
    capabilities: ['account.balance', 'block.read', 'transaction.read'],
  },
  handlers: {
    eth_chainId: () => '0xaa36a7',
    eth_blockNumber: () => '0x1',
    eth_getBalance: () => '0x1',
    eth_getBlockByNumber: () => null,
  },
  invalidAccount: '0xnot-an-address',
  // EVM has no slot concept (that is Solana's addressing mode).
  unsupportedBlockRefs: [{ kind: 'slot', slot: '1' as never }],
  create: (chain) => new EvmAdapter({ chain }) as never,
});

export const SOLANA_FIXTURE: ChainFixture = build({
  chain: {
    id: SOLANA_CHAIN,
    displayName: 'Solana Devnet',
    family: 'solana',
    network: 'devnet',
    adapter: { id: 'solana', version: '^0.1.0' },
    finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
    finalityStatus: 'unverified',
    capabilities: ['account.balance', 'block.read', 'transaction.read'],
  },
  handlers: {
    getVersion: () => ({ 'solana-core': '4.4.0' }),
    getSlot: () => 1,
    getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: 'B' } }),
    getAccountInfo: () => ({ value: { lamports: 1 } }),
    getBlock: () => null,
  },
  invalidAccount: '0invalidSolanaAddress000000000000000000',
  // ADR-027: Solana addresses by slot; number / tag / hash are all fail-closed.
  unsupportedBlockRefs: [
    { kind: 'number', number: '1' as never },
    { kind: 'tag', tag: 'latest' },
    { kind: 'hash', hash: 'BLOCKHASH111' },
  ],
  create: (chain) => new SolanaAdapter({ chain }) as never,
});

export const TWO_CHAINS: readonly ChainFixture[] = [EVM_FIXTURE, SOLANA_FIXTURE];
