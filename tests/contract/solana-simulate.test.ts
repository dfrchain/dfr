/**
 * Solana Adapter simulate test (DFR-M3-B02).
 *
 * Authoritative sources: m3-taskbook B02, adapter-spec §8.2, the EVM simulate semantics (aligned).
 * Fully offline: the mock Provider fixes the simulateTransaction response.
 */
import { describe, expect, it } from 'vitest';
import { SolanaAdapter } from '@dfr/adapter-solana';
import type { Chain, ChainId, TransactionRequest, UnsignedTransaction } from '@dfr/types';
import { makeContext } from './adapter-contract.js';

const DEVNET = 'solana-devnet' as ChainId;
const FEE_PAYER = '11111111111111111111111111111111';
const TO = 'So11111111111111111111111111111111111111112';
const BLOCKHASH = 'BM2MpjjG9Wk6fzPVd62cCvYJFmPzZFxPVXX6g8NsqyDZ'; // secret-scan:allow public-blockhash-from-devnet-fixture

const chain: Chain = {
  id: DEVNET,
  displayName: 'Solana Devnet',
  family: 'solana',
  network: 'devnet',
  adapter: { id: 'solana', version: '^0.1.0' },
  finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.build', 'transaction.simulate'],
};

const baseHandlers = {
  getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }),
};

const okResult = () => ({ value: { err: null, logs: ['Program 11111111111111111111111111111111 invoke [1]'], unitsConsumed: 150, fee: 5000 } });
const revertResult = () => ({ value: { err: { InstructionError: [0, 'Custom'] }, logs: [], unitsConsumed: 0, fee: 5000 } });

const request = (): TransactionRequest => ({
  chain: DEVNET,
  from: { chain: DEVNET, address: FEE_PAYER },
  to: { chain: DEVNET, address: TO },
  value: { asset: { kind: 'native', chain: DEVNET }, amount: '0' },
} as never);

describe('Solana Adapter simulate (M3-B02)', () => {
  const adapter = new SolanaAdapter({ chain });

  it('declares transaction.simulate, and the success path returns unitsConsumed / fee', async () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.simulate');
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult });
    const result = await adapter.simulate(ctx, request());
    expect(result.success).toBe(true);
    expect(result.estimatedCost).toBe('150');
    expect(result.estimatedFee).toEqual({ asset: { kind: 'native', chain: DEVNET }, amount: '5000' });
  });

  it('the request path builds first, then simulates (one getLatestBlockhash)', async () => {
    const seen: string[] = [];
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult }, (m) => seen.push(m));
    await adapter.simulate(ctx, request());
    expect(seen).toContain('getLatestBlockhash');
    expect(seen).toContain('simulateTransaction');
  });

  it('an execution revert does not throw 5xx; instead success:false + revertReason', async () => {
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: revertResult });
    const result = await adapter.simulate(ctx, request());
    expect(result.success).toBe(false);
    expect(result.revertReason).toContain('InstructionError');
    // The revert path reports no estimatedCost (there is no passable transaction).
    expect(result.estimatedCost).toBeUndefined();
  });

  it('the payload path: simulates the given base64 payload directly (no fresh blockhash)', async () => {
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult });
    const built = await adapter.build(ctx, request());
    const seen: string[] = [];
    const ctx2 = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult }, (m) => seen.push(m));
    const result = await adapter.simulate(ctx2, built);
    expect(result.success).toBe(true);
    expect(seen).toEqual(['simulateTransaction']); // did not build again
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it('the payload path rejects non-base64 encoding (fail-closed)', async () => {
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult });
    const unsigned = {
      schemaVersion: '1',
      chain: DEVNET,
      payload: 'deadbeef',
      meta: { encoding: 'hex' },
    } as UnsignedTransaction;
    await expect(adapter.simulate(ctx, unsigned)).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_VERSION',
    });
  });

  it('BlockhashNotFound → success:false with a hint to rebuild (C03 handoff)', async () => {
    const ctx = makeContext(chain, {
      ...baseHandlers,
      simulateTransaction: () => ({ value: { err: 'BlockhashNotFound', logs: [], unitsConsumed: 0, fee: null } }),
    });
    const result = await adapter.simulate(ctx, request());
    expect(result.success).toBe(false);
    expect(result.revertReason).toBe('BlockhashNotFound');
    expect(result.warnings?.some((w) => w.includes('rebuild'))).toBe(true);
  });

  it('simulateTransaction with no value → DFR_PROVIDER_UNAVAILABLE (do not fake success)', async () => {
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: () => ({}) });
    await expect(adapter.simulate(ctx, request())).rejects.toMatchObject({
      code: 'DFR_PROVIDER_UNAVAILABLE',
    });
  });

  it('contract.read is not implemented yet → DFR_UNSUPPORTED_CAPABILITY', async () => {
    const ctx = makeContext(chain, baseHandlers);
    await expect(
      (adapter as unknown as { readContract(a: unknown, b: unknown): Promise<unknown> }).readContract(ctx, {}),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });
});
