/**
 * EVM Adapter `readContract` (ADR-035) and `getAccount` (ADR-036) unit tests.
 */
import { describe, expect, it } from 'vitest';
import { EvmAdapter } from '../src/adapter.js';
import type { AdapterContext, Chain, ChainId } from '@dfr/types';
import { createMockProviderRouter } from '../../../tests/contract/mock-provider.js';

const CHAIN = 'base-sepolia' as ChainId;
const chain: Chain = {
  id: CHAIN, displayName: 'Base Sepolia', family: 'evm', network: 'testnet',
  externalChainId: '84532', adapter: { id: 'evm', version: '^0.1.0' },
  finality: { kind: 'checkpoint', finalizedTag: true }, finalityStatus: 'verified',
  capabilities: ['account.balance', 'account.code', 'block.read', 'transaction.read', 'contract.read'],
};
const ADDRESS = '0x1111111111111111111111111111111111111111';

function ctxWith(handlers: Record<string, unknown>, onCall?: (m: string, params: readonly unknown[]) => void): AdapterContext {
  const router = createMockProviderRouter({
    chain: CHAIN,
    handlers: handlers as never,
    ...(onCall !== undefined ? { onCall: (m: string, c: { params: readonly unknown[] }) => onCall(m, c.params) } : {}),
  });
  return {
    chain: CHAIN, network: 'testnet', providers: router,
    signal: new AbortController().signal, requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  };
}

// balanceOf(address) returns (uint256)
const ABI = ['function balanceOf(address) view returns (uint256)'];

describe('EVM Adapter readContract (ADR-035)', () => {
  const adapter = new EvmAdapter({ chain });

  it('declares contract.read; the abi+method path encodes and returns the decoded result', async () => {
    expect(adapter.capabilities().capabilities).toContain('contract.read');
    const calls: Array<{ m: string; params: readonly unknown[] }> = [];
    // balanceOf → uint256 = 42
    // uint256 = 42 → 32 bytes (64 hex), i.e. 62 zeros + 2a
    const ctx = ctxWith(
      { eth_call: () => `0x${'0'.repeat(62)}2a` },
      (m, params) => calls.push({ m, params }),
    );
    const result = await adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS, abi: ABI, method: 'balanceOf', args: [ADDRESS] });
    // bigint is normalized to a decimal string (HTTP/JSON-safe, per the no-number rule).
    expect(result.decoded).toBe('42');
    expect(result.data).toBe(`0x${'0'.repeat(62)}2a`);
    const call = calls.find((c) => c.m === 'eth_call')!;
    const param = (call.params[0]) as { to: string; data: string };
    expect(param.to).toBe(ADDRESS);
    // balanceOf selector 0x70a08231
    expect(param.data.startsWith('0x70a08231')).toBe(true);
  });

  it('data path: calls directly and returns the raw hex (no decoding)', async () => {
    const calls: string[] = [];
    const ctx = ctxWith({ eth_call: () => '0xabc' }, (m) => calls.push(m));
    const result = await adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS, data: '0xdeadbeef' });
    expect(result.data).toBe('0xabc');
    expect(result.decoded).toBeUndefined();
    expect(calls).toContain('eth_call');
  });

  it('data and abi given together → DFR_VALIDATION_FAILED (no guessing)', async () => {
    const ctx = ctxWith({ eth_call: () => '0x' });
    await expect(
      adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS, data: '0xdeadbeef', abi: ABI, method: 'balanceOf' }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('neither given → DFR_VALIDATION_FAILED', async () => {
    const ctx = ctxWith({ eth_call: () => '0x' });
    await expect(adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS })).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('method missing from the ABI → DFR_VALIDATION_FAILED (no eth_call sent)', async () => {
    const calls: string[] = [];
    const ctx = ctxWith({ eth_call: () => '0x' }, (m) => calls.push(m));
    await expect(
      adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS, abi: ABI, method: 'missing' }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    expect(calls).not.toContain('eth_call');
  });
});

describe('EVM Adapter getAccount (ADR-036)', () => {
  const adapter = new EvmAdapter({ chain });

  it('non-empty code → kind=contract, exists=true, returns the nonce', async () => {
    expect(adapter.capabilities().capabilities).toContain('account.code');
    const ctx = ctxWith({ eth_getCode: () => '0x60806040', eth_getTransactionCount: () => '0x0', eth_getBalance: () => '0x0' });
    const account = await adapter.getAccount(ctx, { chain: CHAIN, address: ADDRESS });
    expect(account.kind).toBe('contract');
    expect(account.exists).toBe(true);
    expect(account.nonce).toBe('0');
  });

  it('empty code, nonce=0, balance=0 → kind=externally-owned, exists=false (heuristic)', async () => {
    const ctx = ctxWith({ eth_getCode: () => '0x', eth_getTransactionCount: () => '0x0', eth_getBalance: () => '0x0' });
    const account = await adapter.getAccount(ctx, { chain: CHAIN, address: ADDRESS });
    expect(account.kind).toBe('externally-owned');
    expect(account.exists).toBe(false);
  });

  it('empty code but non-zero balance → EOA with exists=true', async () => {
    const ctx = ctxWith({ eth_getCode: () => '0x', eth_getTransactionCount: () => '0x0', eth_getBalance: () => '0x2a' });
    const account = await adapter.getAccount(ctx, { chain: CHAIN, address: ADDRESS });
    expect(account.kind).toBe('externally-owned');
    expect(account.exists).toBe(true);
  });
});
