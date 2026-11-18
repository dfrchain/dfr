/**
 * Solana Adapter broadcast test (DFR-M3-C01).
 *
 * Authoritative sources: m3-taskbook C01, error-spec §5.1, the four EVM broadcast red lines.
 * Fully offline: the mock Provider fixes the sendTransaction response.
 *
 * Takes a real signed transaction as the "signed payload", replacing its signature segment with non-zero bytes,
 * so decode/binding follow the real path without depending on any private key.
 */
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import { SolanaAdapter, SolanaBindingError, bindSignedTransaction } from '@dfr/adapter-solana';
import type { Chain, ChainId, SignedTransaction } from '@dfr/types';
import { makeContext } from './adapter-contract.js';
import { createMockProviderRouter } from './mock-provider.js';
import { SOLANA_DEVNET_FIXTURES, SOLANA_DEVNET_LEGACY_SIGNED } from '../../adapters/solana/test/support/devnet-fixtures.js';

const DEVNET = 'solana-devnet' as ChainId;
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

/** An existing real signed legacy transaction (offline ground truth). */
const signedPayload = SOLANA_DEVNET_LEGACY_SIGNED.signedPayloadBase64;
const FEE_PAYER = SOLANA_DEVNET_LEGACY_SIGNED.feePayer;
const TX_HASH = SOLANA_DEVNET_LEGACY_SIGNED.txHash;

function signed(overrides: Partial<SignedTransaction> = {}): SignedTransaction {
  return {
    schemaVersion: '1',
    chain: DEVNET,
    unsigned: { schemaVersion: '1', chain: DEVNET, payload: signedPayload, meta: { encoding: 'base64' } },
    signedPayload,
    expectedHash: TX_HASH,
    ...overrides,
  };
}

describe('Solana broadcast (M3-C01)', () => {
  const adapter = new SolanaAdapter({ chain });

  it('declares transaction.broadcast', () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.broadcast');
  });

  it('single submission: sendTransaction exactly once, maxRetries:0, non-idempotent-write', async () => {
    const calls: Array<{ method: string; params: unknown; idempotency: string }> = [];
    const ctx = {
      chain: DEVNET,
      network: chain.network,
      providers: createMockProviderRouter({
        chain: DEVNET,
        handlers: { sendTransaction: () => TX_HASH },
        onCall: (method, call) => calls.push({ method, params: call.params, idempotency: call.idempotency }),
      }),
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    const result = await adapter.broadcast(ctx, signed());
    expect(result.accepted).toBe(true);
    expect(result.ref).toEqual({ kind: 'hash', hash: TX_HASH });
    const sends = calls.filter((c) => c.method === 'sendTransaction');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.idempotency).toBe('non-idempotent-write');
    expect((sends[0]!.params as unknown[])[1]).toMatchObject({ maxRetries: 0, skipPreflight: false });
  });

  it('the signature returned by the endpoint disagrees with the payload recomputation → DFR_PROVIDER_INVALID_RESPONSE', async () => {
    const ctx = makeContext(chain, { sendTransaction: () => '1'.repeat(64) });
    await expect(adapter.broadcast(ctx, signed())).rejects.toMatchObject({
      code: 'DFR_PROVIDER_INVALID_RESPONSE',
    });
  });

  it('already processed (a genuine DFR error) → idempotent success, no throw', async () => {
    const ctx = makeContext(chain, {
      sendTransaction: () => {
        throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: DEVNET,
          message: 'Transaction already been processed',
          chainError: { message: 'already been processed' },
        });
      },
    });
    const result = await adapter.broadcast(ctx, signed());
    expect(result.accepted).toBe(true);
    expect(result.ref).toEqual({ kind: 'hash', hash: TX_HASH });
  });

  it('a non-idempotent ordinary error is rethrown as-is (not misjudged as already known)', async () => {
    const ctx = makeContext(chain, {
      sendTransaction: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: DEVNET,
          message: 'provider down',
        });
      },
    });
    await expect(adapter.broadcast(ctx, signed())).rejects.toMatchObject({
      code: 'DFR_PROVIDER_UNAVAILABLE',
    });
  });

  it('with record ground truth, full binding: fee payer mismatch → 422 DFR_TRANSACTION_REJECTED, and no broadcast', async () => {
    const calls: string[] = [];
    const ctx = {
      chain: DEVNET,
      network: chain.network,
      providers: createMockProviderRouter({
        chain: DEVNET,
        handlers: { sendTransaction: () => TX_HASH },
        onCall: (m) => calls.push(m),
      }),
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await expect(
      adapter.broadcast(ctx, signed(), {
        expectedFrom: { chain: DEVNET, address: 'So11111111111111111111111111111111111111112' },
        expectedUnsignedPayload: signedPayload,
      }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED', details: { reason: 'sender_mismatch' } });
    expect(calls).not.toContain('sendTransaction');
  });

  it('with record ground truth: expectedHash mismatch → rejected', async () => {
    const ctx = makeContext(chain, { sendTransaction: () => TX_HASH });
    await expect(
      adapter.broadcast(ctx, signed({ expectedHash: '2'.repeat(64) }), {
        expectedFrom: { chain: DEVNET, address: FEE_PAYER },
        expectedUnsignedPayload: signedPayload,
      }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
  });

  it('with record ground truth: unsigned payload and signed payload are not the same transaction → rejected (with a reason)', async () => {
    const ctx = makeContext(chain, { sendTransaction: () => TX_HASH });
    const other = SOLANA_DEVNET_FIXTURES.find((f) => f.version === 'v0')!;
    await expect(
      adapter.broadcast(ctx, signed(), {
        expectedFrom: { chain: DEVNET, address: FEE_PAYER },
        expectedUnsignedPayload: other.blockPayloadBase64,
      }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED', details: { reason: 'unsigned_payload_mismatch' } });
  });

  it('half a ground truth (only expectedFrom) → invalid_expectation, no broadcast', async () => {
    const calls: string[] = [];
    const ctx = {
      chain: DEVNET,
      network: chain.network,
      providers: createMockProviderRouter({
        chain: DEVNET,
        handlers: { sendTransaction: () => TX_HASH },
        onCall: (m) => calls.push(m),
      }),
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await expect(
      adapter.broadcast(ctx, signed(), { expectedFrom: { chain: DEVNET, address: FEE_PAYER } }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED', details: { reason: 'invalid_expectation' } });
    expect(calls).not.toContain('sendTransaction');
  });
});

describe('Solana signature binding (bindSignedTransaction, M3-C01)', () => {
  it('real signed payload: binding passes, txHash = signature #0', () => {
    const result = bindSignedTransaction(signedPayload, {
      from: FEE_PAYER,
      unsignedPayload: signedPayload,
      expectedHash: TX_HASH,
    });
    expect(result.txHash).toBe(TX_HASH);
    expect(result.decoded.signed).toBe(true);
  });

  it('unsigned (all-zero signature) → not_signed', () => {
    // Zero out the signature segment: the first 1 byte is the signature count (1), followed by 64 bytes of signature.
    const bytes = Buffer.from(signedPayload, 'base64');
    bytes.fill(0, 1, 65);
    const unsigned = bytes.toString('base64');
    try {
      bindSignedTransaction(unsigned, { from: FEE_PAYER, unsignedPayload: unsigned, expectedHash: TX_HASH });
      throw new Error('expected to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(SolanaBindingError);
      expect((err as SolanaBindingError).reason).toBe('not_signed');
    }
  });
});
