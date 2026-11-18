/**
 * Solana blockhash-expiry build retry semantics (DFR-M3-C03).
 *
 * Authoritative sources: m3-taskbook C03, ADR-033, error-spec §4.4.
 * Goal: after expiry the chain rejects the transaction → a clear error code + an actionable hint
 * ("rebuild needed"); **must not re-sign automatically** (signing belongs outside).
 */
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import { SolanaAdapter } from '@dfr/adapter-solana';
import { classifyBroadcastFailure } from '@dfr/transaction';
import type { Chain, ChainId, SignedTransaction } from '@dfr/types';
import { makeContext } from './adapter-contract.js';
import { SOLANA_DEVNET_LEGACY_SIGNED } from '../../adapters/solana/test/support/devnet-fixtures.js';

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

const signedPayload = SOLANA_DEVNET_LEGACY_SIGNED.signedPayloadBase64;
const TX_HASH = SOLANA_DEVNET_LEGACY_SIGNED.txHash;

const signed = (): SignedTransaction => ({
  schemaVersion: '1',
  chain: DEVNET,
  unsigned: { schemaVersion: '1', chain: DEVNET, payload: signedPayload, meta: { encoding: 'base64' } },
  signedPayload,
  expectedHash: TX_HASH,
});

describe('Solana blockhash expiry (M3-C03)', () => {
  const adapter = new SolanaAdapter({ chain });

  it('node reports "Blockhash not found" → DFR_BLOCKHASH_EXPIRED + actionable hint (rebuild)', async () => {
    const ctx = makeContext(chain, {
      sendTransaction: () => {
        throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: DEVNET,
          message: 'RPC response error -32002: Blockhash not found',
          chainError: { message: 'Blockhash not found' },
        });
      },
    });
    try {
      await adapter.broadcast(ctx, signed());
      throw new Error('expected DFR_BLOCKHASH_EXPIRED');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('DFR_BLOCKHASH_EXPIRED');
      expect(JSON.stringify(err)).toContain('rebuild');
    }
  });

  it('an ordinary revert / other error is not misclassified as blockhash expiry', async () => {
    const ctx = makeContext(chain, {
      sendTransaction: () => {
        throw createDfrError('DFR_TRANSACTION_REJECTED', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: DEVNET,
          message: 'instruction error',
        });
      },
    });
    await expect(adapter.broadcast(ctx, signed())).rejects.toMatchObject({
      code: 'DFR_TRANSACTION_REJECTED',
    });
  });
});

describe('Engine attribution of blockhash expiry (M3-C03 / ADR-019)', () => {
  it('DFR_BLOCKHASH_EXPIRED is classified as rejected (provably unrecoverable → terminal state failed)', () => {
    const error = createDfrError('DFR_BLOCKHASH_EXPIRED', {
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
      chain: DEVNET,
      message: 'expired',
    });
    expect(classifyBroadcastFailure(error)).toBe('rejected');
  });

  it('an unclassified error stays indeterminate (no guessing)', () => {
    const error = createDfrError('DFR_PROVIDER_TIMEOUT', {
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
      chain: DEVNET,
      message: 'timeout',
    });
    expect(classifyBroadcastFailure(error)).toBe('indeterminate');
  });
});
