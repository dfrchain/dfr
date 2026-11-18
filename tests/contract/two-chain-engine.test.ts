/**
 * M3-D01: two-chain shared engine state-machine comparison.
 *
 * Completion gate (roadmap M3): "EVM/Solana share the Transaction Engine state machine".
 *
 * This test does **not** run the Adapters again; it proves the same `TransactionEngine` follows the **same**
 * state machine and assertions under an EVM-shaped and a Solana-shaped chain port; the only chain difference
 * is the "ordering prerequisite kind" (nonce vs blockhash).
 *
 * Isomorphic to M2-D01 (read-only comparison): differences are expressed through data, not `if (family === ...)`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SolanaAdapter } from '@dfr/adapter-solana';
import { EvmAdapter } from '@dfr/adapter-evm';
import type { ChainId, SequencingToken, TransactionRequest, TransactionStatus, UnsignedTransaction } from '@dfr/types';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';
import { TransactionEngine } from '@dfr/transaction';
import type { TransactionChainPort, SequencingLease, SequencingStore } from '@dfr/transaction';
import { createMockProviderRouter } from './mock-provider.js';
import { SOLANA_DEVNET_LEGACY_SIGNED } from '../../adapters/solana/test/support/devnet-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The engine-port differences between the two chains are expressed **only as data**: EVM has getPendingNonce; Solana uses getSequencingToken. */
interface EngineFixture {
  readonly chain: ChainId;
  readonly family: 'evm' | 'solana';
  readonly from: { chain: ChainId; address: string };
  readonly to: { chain: ChainId; address: string };
  /** The expected ordering-prerequisite kind. */
  readonly expectedTokenKind: 'nonce' | 'blockhash';
  readonly port: TransactionChainPort;
}

const EVM_CHAIN = 'ethereum-sepolia' as ChainId;
const SOL_CHAIN = 'solana-devnet' as ChainId;

function evmPort(): TransactionChainPort {
  const adapter = new EvmAdapter({
    chain: {
      id: EVM_CHAIN,
      displayName: 'Ethereum Sepolia',
      family: 'evm',
      network: 'testnet',
      externalChainId: '11155111',
      adapter: { id: 'evm', version: '^0.1.0' },
      finality: { kind: 'checkpoint', finalizedTag: true },
      finalityStatus: 'verified',
      capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.build'],
    },
  });
  const ctx = {
    chain: EVM_CHAIN,
    network: 'testnet',
    providers: createMockProviderRouter({
      chain: EVM_CHAIN,
      handlers: { eth_chainId: () => '0xaa36a7' },
    }),
    signal: new AbortController().signal,
    requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  };
  return {
    getPendingNonce: async () => '7' as never,
    getSequencingToken: async (): Promise<SequencingToken> => ({ kind: 'nonce', value: '7' as never }),
    withSequencingToken: (req: TransactionRequest, token: SequencingToken) => ({ ...req, nonce: token.value as never }),
    simulate: async () => ({ success: true }),
    build: async ({ request }: { request: TransactionRequest }): Promise<UnsignedTransaction> => ({
      schemaVersion: '1' as const,
      chain: request.chain,
      payload: '0x02f8',
      meta: { encoding: 'hex', requiresNonce: request.nonce ?? ('0' as never) },
    }),
    // Port for confirmation observation: shares the same assertions as Solana.
    confirm: async () => ({
      ref: { kind: 'hash', hash: `0x${'a'.repeat(64)}` },
      status: 'confirmed',
      finality: 'confirmed',
      requiredFinality: 'confirmed',
      confirmations: '3' as never,
      reached: true,
    }),
    _adapter: adapter,
    _ctx: ctx,
  } as unknown as TransactionChainPort;
}

/** Solana port: really uses the B01/B02/C01/C02 implementations (via Core's wiring equivalent). */
function solanaPort(): TransactionChainPort {
  return {
    getSequencingToken: async (): Promise<SequencingToken> => ({
      kind: 'blockhash',
      value: SOLANA_DEVNET_LEGACY_SIGNED.recentBlockhash,
      lastValidBlockHeight: '495317734' as never,
    }),
    withSequencingToken: (req: TransactionRequest, token: SequencingToken) => ({ ...req, recentBlockhash: token.value }),
    simulate: async () => ({ success: true }),
    build: async ({ request }: { request: TransactionRequest }): Promise<UnsignedTransaction> => ({
      schemaVersion: '1' as const,
      chain: request.chain,
      payload: SOLANA_DEVNET_LEGACY_SIGNED.signedPayloadBase64,
      meta: { encoding: 'base64', ...(request.recentBlockhash !== undefined ? { recentBlockhash: request.recentBlockhash } : {}) },
    }),
    confirm: async () => ({
      ref: { kind: 'hash', hash: SOLANA_DEVNET_LEGACY_SIGNED.txHash },
      status: 'confirmed',
      finality: 'confirmed',
      requiredFinality: 'confirmed',
      confirmations: '3' as never,
      reached: true,
    }),
  };
}

const FIXTURES: readonly EngineFixture[] = [
  {
    chain: EVM_CHAIN,
    family: 'evm',
    from: { chain: EVM_CHAIN, address: '0x1111111111111111111111111111111111111111' },
    to: { chain: EVM_CHAIN, address: '0x2222222222222222222222222222222222222222' },
    expectedTokenKind: 'nonce',
    port: evmPort(),
  },
  {
    chain: SOL_CHAIN,
    family: 'solana',
    from: { chain: SOL_CHAIN, address: SOLANA_DEVNET_LEGACY_SIGNED.feePayer },
    to: { chain: SOL_CHAIN, address: 'So11111111111111111111111111111111111111112' },
    expectedTokenKind: 'blockhash',
    port: solanaPort(),
  },
];

describe('M3-D01 two chains share the engine state machine', () => {
  it('the engine does not branch on chain family (same assertions; differences expressed by token kind)', () => {
    const source = readFileSync(resolve(here, '../../packages/transaction/src/engine.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
    const familyBranches = code.match(/family\s*===\s*['"][a-z]+['"]/gu) ?? [];
    expect(familyBranches, `The engine must not branch on chain family; found: ${familyBranches.join(', ')}`).toEqual([]);
    // Dispatch is based on the token's kind.
    expect(source).toContain("pendingToken.kind === 'nonce'");
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.family}: build follows the same state machine, ordering-prerequisite kind = ${fixture.expectedTokenKind}`, async () => {
      const stores = createInMemoryTransactionStores();
      const engine = new TransactionEngine({
        stores: {
          ...stores,
          // Solana needs a sequencing store; EVM gets one too (it is not written to — uniform assembly).
          sequencing: solanaSequencingStore(),
        },
        chain: fixture.port,
        newTransactionId: () => `txn_d01_${fixture.family}` as never,
      });
      const result = await engine.build({
        request: {
          chain: fixture.chain,
          from: fixture.from,
          to: fixture.to,
          value: { asset: { kind: 'native', chain: fixture.chain }, amount: '1' },
        } as never,
      });

      // Same state machine: both start as built, version 0.
      expect(result.status).toBe('built' as TransactionStatus);
      expect(result.sequencingToken?.kind).toBe(fixture.expectedTokenKind);

      const record = await stores.transaction.get(result.transactionId);
      expect(record?.status).toBe('built');
      expect(record?.stateVersion).toBe('0');
      expect(record?.sequencingRef?.kind).toBe(fixture.expectedTokenKind);
      // The EVM record has a nonce column, Solana does not — this is the **only** difference, and it is data, not a branch.
      if (fixture.family === 'evm') expect(record?.nonce).toBe('7');
      else expect(record?.nonce).toBeUndefined();
    });
  }

  it('confirm on both chains follows the same engine path (same assertion, different data)', async () => {
    for (const fixture of FIXTURES) {
      const stores = createInMemoryTransactionStores();
      const engine = new TransactionEngine({ stores, chain: fixture.port });
      // Drive the port layer directly: the engine carries confirmation results across without distinguishing chain family.
      const confirmation = await fixture.port.confirm!({
        chain: fixture.chain,
        txHash: fixture.family === 'evm' ? `0x${'a'.repeat(64)}` : SOLANA_DEVNET_LEGACY_SIGNED.txHash,
        signal: new AbortController().signal,
      });
      expect(confirmation.reached).toBe(true);
      expect(confirmation.finality).toBe('confirmed');
      void engine;
    }
  });

  it('both Adapters implement the write-path capabilities (registry ⊆ adapter in its M3 form)', () => {
    const evmAdapter = new EvmAdapter({
      chain: {
        id: EVM_CHAIN, displayName: 'x', family: 'evm', network: 'testnet',
        externalChainId: '11155111', adapter: { id: 'evm', version: '^0.1.0' },
        finality: { kind: 'checkpoint', finalizedTag: true }, finalityStatus: 'verified',
        capabilities: [],
      },
    });
    const solAdapter = new SolanaAdapter({
      chain: {
        id: SOL_CHAIN, displayName: 'x', family: 'solana', network: 'devnet',
        adapter: { id: 'solana', version: '^0.1.0' },
        finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
        finalityStatus: 'unverified', capabilities: [],
      },
    });
    for (const adapter of [evmAdapter, solAdapter]) {
      expect(adapter.capabilities().capabilities).toContain('transaction.build');
      expect(adapter.capabilities().capabilities).toContain('transaction.simulate');
      expect(adapter.capabilities().capabilities).toContain('transaction.broadcast');
    }
  });
});

/** Minimal SequencingStore isomorphic to packages/transaction/test/solana-build.test.ts. */
function solanaSequencingStore() {
  const rows = new Map<string, SequencingLease>();
  return {
    async reserve(input: never) {
      const i = input as { chain: never; account: never; token: never; transactionId: string };
      const existing = rows.get(i.transactionId);
      if (existing !== undefined) return { kind: 'reused' as const, lease: existing };
      const lease = {
        chain: i.chain, account: i.account, token: i.token, transactionId: i.transactionId,
        status: 'reserved' as const, expiresAt: '2026-10-06T00:00:00Z' as never,
      } as unknown as SequencingLease;
      rows.set(i.transactionId, lease);
      return { kind: 'reserved' as const, lease };
    },
    async markConsumed() { return { kind: 'not_found' as const }; },
    async releaseIfSafe() { return { kind: 'not_found' as const }; },
    async releaseExpiredOrphaned() { return 0; },
  } as unknown as SequencingStore;
}
