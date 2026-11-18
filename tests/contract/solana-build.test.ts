/**
 * Solana Adapter build test (DFR-M3-B01).
 *
 * Authoritative sources: ADR-032 (the blockhash is the ordering prerequisite), adapter-spec §8.2, m3-taskbook B01.
 * Fully offline: the mock Provider fixes the on-chain reads; a decode round-trip proves the payload is self-consistent.
 */
import { describe, expect, it } from 'vitest';
import { SolanaAdapter, decodeTransactionPayload } from '@dfr/adapter-solana';
import type { AdapterContext, Chain, ChainId, TransactionRequest } from '@dfr/types';
import { makeContext } from './adapter-contract.js';

const DEVNET = 'solana-devnet' as ChainId;
/** A valid 32-byte public key: all 1s = 32 zero bytes (used here as a readable placeholder address). */
const FROM = '11111111111111111111111111111111';
/** Another valid address (32 bytes). */
const TO = 'So11111111111111111111111111111111111111112';
const BLOCKHASH = 'BM2MpjjG9Wk6fzPVd62cCvYJFmPzZFxPVXX6g8NsqyDZ'; // secret-scan:allow public-blockhash-from-devnet-fixture
const LAST_VALID = 495_317_734;

const chain: Chain = {
  id: DEVNET,
  displayName: 'Solana Devnet',
  family: 'solana',
  network: 'devnet',
  adapter: { id: 'solana', version: '^0.1.0' },
  finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.build'],
};

const handlers = {
  getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID } }),
};

const nativeValue = (amount: string) => ({ asset: { kind: 'native' as const, chain: DEVNET }, amount: amount as never });

/** Only covers fields that **exist**: under exactOptionalPropertyTypes you cannot delete with `{ to: undefined }`. */
function request(overrides: Partial<TransactionRequest> = {}): TransactionRequest {
  const base: TransactionRequest = {
    chain: DEVNET,
    from: { chain: DEVNET, address: FROM },
    to: { chain: DEVNET, address: TO },
    value: nativeValue('1'),
  };
  return { ...base, ...overrides };
}

function withoutField(field: 'to' | 'value'): TransactionRequest {
  const base = request();
  const copy = { ...base } as Record<string, unknown>;
  delete copy[field];
  return copy as unknown as TransactionRequest;
}

describe('Solana Adapter build (M3-B01)', () => {
  const adapter = new SolanaAdapter({ chain });

  it('declares transaction.build, and produces a decodable base64 unsigned transaction', async () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.build');
    const ctx = makeContext(chain, handlers);
    const unsigned = await adapter.build(ctx, request());

    expect(unsigned.chain).toBe(DEVNET);
    expect(unsigned.meta.encoding).toBe('base64');
    expect(unsigned.meta.recentBlockhash).toBe(BLOCKHASH);
    // Solana has no requiresNonce (the ordering prerequisite is the blockhash).
    expect(unsigned.meta.requiresNonce).toBeUndefined();

    const decoded = decodeTransactionPayload(unsigned.payload);
    expect(decoded.version).toBe('legacy');
    expect(decoded.signed).toBe(false);
    expect(decoded.recentBlockhash).toBe(BLOCKHASH);
    // fee payer first; recipient address second; system program in the table.
    expect(decoded.accountKeys[0]).toBe(FROM);
    expect(decoded.accountKeys).toContain(TO);
    expect(decoded.accountKeys).toContain('11111111111111111111111111111111');
    expect(decoded.header.numRequiredSignatures).toBe(1);
    expect(decoded.instructions).toHaveLength(1);
  });

  it('the amount converts to lamports at 9 decimals, and the instruction data is little-endian u32 enum 2 + u64 lamports', async () => {
    const ctx = makeContext(chain, handlers);
    const unsigned = await adapter.build(ctx, request({ value: nativeValue('1') }));
    const decoded = decodeTransactionPayload(unsigned.payload);
    const data = Buffer.from(decoded.instructions[0]!.data, 'base64');
    expect(data.length).toBe(12);
    expect(data.readUInt32LE(0)).toBe(2); // SystemInstruction::Transfer
    expect(data.readBigUInt64LE(4)).toBe(1_000_000_000n); // 1 SOL
  });

  it('the blockhash comes from the chain (getLatestBlockhash), not hardcoded', async () => {
    const seen: string[] = [];
    const ctx = makeContext(chain, handlers, (method) => seen.push(method));
    await adapter.build(ctx, request());
    expect(seen).toContain('getLatestBlockhash');
  });

  it('recentBlockhash is written to meta (for SequencingStore to record lastValidBlockHeight)', async () => {
    const ctx = makeContext(chain, handlers);
    const unsigned = await adapter.build(ctx, request({ value: nativeValue('2') }));
    expect(unsigned.meta.recentBlockhash).toBe(BLOCKHASH);
    expect(unsigned.meta.feeEstimate?.asset).toEqual({ kind: 'native', chain: DEVNET });
    // Base signature fee: 5000 lamports × 1 signer.
    expect(unsigned.meta.feeEstimate?.amount).toBe('5000');
  });

  it('an EVM-semantics nonce → DFR_INVALID_REQUEST (not silently ignored)', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(adapter.build(ctx, request({ nonce: '3' as never }))).rejects.toMatchObject({
      code: 'DFR_INVALID_REQUEST',
    });
  });

  it('missing to → DFR_UNSUPPORTED_CAPABILITY (program deployment not supported)', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(adapter.build(ctx, withoutField('to'))).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_CAPABILITY',
    });
  });

  it('invalid address → DFR_INVALID_ACCOUNT', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.build(ctx, request({ to: { chain: DEVNET, address: '0invalid' } })),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_ACCOUNT' });
  });

  it('non-native asset / cross-chain asset → DFR_INVALID_ASSET', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.build(ctx, request({ value: { asset: { kind: 'token', chain: DEVNET, assetId: TO }, amount: '1' as never } })),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_ASSET' });
    await expect(
      adapter.build(ctx, request({ value: { asset: { kind: 'native', chain: 'ethereum-sepolia' as ChainId }, amount: '1' as never } })),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_ASSET' });
  });

  it('missing amount → DFR_INVALID_ASSET', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(adapter.build(ctx, withoutField('value'))).rejects.toMatchObject({
      code: 'DFR_INVALID_ASSET',
    });
  });

  it('contract.read is not implemented yet → DFR_UNSUPPORTED_CAPABILITY (fail-closed)', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      (adapter as unknown as { readContract(a: AdapterContext, b: unknown): Promise<unknown> }).readContract(ctx, {}),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });
});
