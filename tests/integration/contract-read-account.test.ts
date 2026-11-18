/**
 * `contract.read` / `account.code` real-chain read-only integration test (ADR-035/036, M4).
 *
 * Skipped by default; enable explicitly:
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL=https://sepolia.base.org \
 *   pnpm vitest run tests/integration/contract-read-account.test.ts
 */
import { describe, expect, it } from 'vitest';
import { ChainRegistry } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import { EvmAdapter } from '@dfr/adapter-evm';
import { newRequestId } from '@dfr/errors';
import type { Chain, ChainId } from '@dfr/types';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';

const RUN = process.env['DFR_RUN_TESTNET'] === '1';
const BASE = process.env['DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL'];
const ENABLED = RUN && BASE !== undefined && BASE !== '';
const CHAIN = 'base-sepolia' as ChainId;
// Base Sepolia Wrapped Ether (ERC-20 contract, publicly known address).
const WETH = '0x4200000000000000000000000000000000000006';

function makeCore(): DfrCore {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: BASE ?? 'https://x.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://x.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://y.invalid',
      DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: 'https://s.invalid',
    },
  });
  return new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    transactionStores: createInMemoryTransactionStores(),
  });
}

describe.skipIf(!ENABLED)('contract.read / account.code real-chain read-only integration test (ADR-035/036)', () => {
  it('account.code: WETH is a contract; a regular address is an EOA', async () => {
    const core = makeCore();
    const contract = await core.getAccount(CHAIN, { chain: CHAIN, address: WETH }, { requestId: newRequestId() });
    expect(contract.kind).toBe('contract');
    expect(contract.exists).toBe(true);

    const eoa = await core.getAccount(CHAIN, { chain: CHAIN, address: '0x0000000000000000000000000000000000000001' }, { requestId: newRequestId() });
    expect(eoa.kind).toBe('externally-owned');
  }, 30_000);

  it('contract.read: abi+method reads WETH.totalSupply() and decodes it to a decimal string', async () => {
    const result = await makeCore().readContract(
      CHAIN,
      { chain: CHAIN, contract: WETH, abi: ['function totalSupply() view returns (uint256)'], method: 'totalSupply' },
      { requestId: newRequestId() },
    );
    expect(typeof result.data).toBe('string');
    expect(result.data.startsWith('0x')).toBe(true);
    // bigint is normalized to a decimal string.
    expect(typeof result.decoded).toBe('string');
    expect(/^\d+$/u.test(String(result.decoded))).toBe(true);
  }, 30_000);
});
