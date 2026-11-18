/**
 * Solana Adapter observeConfirmation test (DFR-M3-C02).
 *
 * Authoritative sources: ADR-031 (three-level commitment mapping), m3-taskbook C02.
 * Offline: the mock Provider returns different results per commitment.
 */
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import { SolanaAdapter } from '@dfr/adapter-solana';
import type { Chain, ChainId } from '@dfr/types';
import { makeContext } from './adapter-contract.js';

const DEVNET = 'solana-devnet' as ChainId;
const SIGNATURE = '1'.repeat(64); // A 64-byte signature in valid shape

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

/** Tiered responses by commitment: finalized / confirmed / processed. */
function handlersByCommitment(map: Record<string, unknown>) {
  return {
    getTransaction: (params: readonly unknown[]) => {
      const opts = params[1] as { commitment?: string } | undefined;
      const value = map[opts?.commitment ?? 'processed'] ?? null;
      return value;
    },
  };
}

const txAt = (slot: number, err: unknown = null) => ({
  slot,
  blockTime: 1_700_000_000,
  transaction: { signatures: [SIGNATURE], message: { accountKeys: [], recentBlockhash: 'x' } },
  meta: { err, fee: 5000, computeUnitsConsumed: 150, logMessages: [] },
});

describe('Solana observeConfirmation (M3-C02)', () => {
  const adapter = new SolanaAdapter({ chain });

  it('when finalized is available: status=finalized, finality=finalized, with slot', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ finalized: txAt(100) }));
    const obs = await adapter.observeConfirmation(ctx, { txHash: SIGNATURE });
    expect(obs).not.toBeNull();
    expect(obs!.status).toBe('finalized');
    expect(obs!.finality).toBe('finalized');
    expect(obs!.blockRef).toEqual({ kind: 'slot', slot: '100' });
    // Solana does not fabricate canonicalBlockHash (getTransaction does not return a block hash).
    expect(obs!.canonicalBlockHash).toBeUndefined();
  });

  it('when only confirmed is visible: status=confirmed, finality=confirmed', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ confirmed: txAt(90) }));
    const obs = await adapter.observeConfirmation(ctx, { txHash: SIGNATURE });
    expect(obs!.status).toBe('confirmed');
    expect(obs!.finality).toBe('confirmed');
  });

  it('when only processed is visible: finality=included (ADR-031: processed→included)', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ processed: txAt(80) }));
    const obs = await adapter.observeConfirmation(ctx, { txHash: SIGNATURE });
    expect(obs!.status).toBe('included');
    expect(obs!.finality).toBe('included');
  });

  it('execution failed but confirmed: status=reverted, finality reported as-is', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ finalized: txAt(70, { InstructionError: [0, 'Custom'] }) }));
    const obs = await adapter.observeConfirmation(ctx, { txHash: SIGNATURE });
    expect(obs!.status).toBe('reverted');
    expect(obs!.finality).toBe('finalized');
  });

  it('nothing found at all three levels → null (upper layer stays unknown, no faked status)', async () => {
    const ctx = makeContext(chain, handlersByCommitment({}));
    expect(await adapter.observeConfirmation(ctx, { txHash: SIGNATURE })).toBeNull();
  });

  it('cluster does not support processed commitment (observed on devnet) → skip that tier, do not treat it as failure', async () => {
    // devnet's getTransaction returns -32602 "Method does not support commitment below `confirmed`" for
    // processed. It must not throw just because finalized/confirmed are also not found.
    const ctx = makeContext(chain, {
      getTransaction: (params: readonly unknown[]) => {
        const opts = params[1] as { commitment?: string } | undefined;
        if (opts?.commitment === 'processed') {
          throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
            requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
            chain: DEVNET,
            message: 'Method does not support commitment below `confirmed`',
            chainError: { message: 'Method does not support commitment below `confirmed`' },
          });
        }
        return null;
      },
    });
    expect(await adapter.observeConfirmation(ctx, { txHash: SIGNATURE })).toBeNull();
  });

  it('invalid signature → DFR_INVALID_REQUEST (shape validation in the Adapter)', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ finalized: txAt(1) }));
    await expect(
      adapter.observeConfirmation(ctx, { txHash: 'not-a-signature' }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_REQUEST' });
  });
});
