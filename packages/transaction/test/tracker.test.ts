import { describe, expect, it } from 'vitest';
import type { ChainId, Iso8601 } from '@dfr/types';
import { createDfrError, newRequestId } from '@dfr/errors';
import { ConfirmationTracker } from '../src/tracker.js';

const chain = 'ethereum-sepolia' as ChainId;
const lease = { chain, txHash: '0xabc', ownerToken: 'owner', leaseExpiresAt: '2026-01-01T00:00:01.000Z' as Iso8601, heartbeatAt: '2026-01-01T00:00:00.000Z' as Iso8601 };

describe('ConfirmationTracker', () => {
  it('when the lease is held by another owner, do not observe and return reached=false', async () => {
    let observed = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'held_by_other' as const, lease }), renew: async () => ({ kind: 'lost' as const }), release: async () => ({ kind: 'lost' as const }), listRecoverable: async () => [] },
      observe: async () => { observed += 1; return { observed: 'submitted' as const }; },
      ownerToken: () => 'owner',
    });
    await expect(tracker.track({ chain, txHash: '0xabc', required: 'confirmed' })).resolves.toMatchObject({ reached: false, owner: false });
    expect(observed).toBe(0);
  });

  it('stop observing after losing the renewal lease; no longer write as the old owner', async () => {
    let observed = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'lost' as const }), release: async () => ({ kind: 'lost' as const }), listRecoverable: async () => [] },
      observe: async () => { observed += 1; return { observed: 'finalized' as const }; }, ownerToken: () => 'owner',
    });
    await expect(tracker.track({ chain, txHash: '0xabc', required: 'finalized' })).resolves.toMatchObject({ owner: false, reached: false });
    expect(observed).toBe(0);
  });

  it('on timeout, return reached=false, with the polling interval controlled by the injected clock', async () => {
    let clock = 0;
    let calls = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async () => { calls += 1; return { observed: 'submitted' as const }; }, ownerToken: () => 'owner', now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await expect(tracker.trackUntil({ chain, txHash: '0xabc', required: 'confirmed', timeoutMs: 1_000 })).resolves.toMatchObject({ reached: false, owner: true });
    expect(calls).toBe(2);
  });

  it('each confirmation observation uses a stable chain:txHash sticky key', async () => {
    let stickyKey = '';
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async (input) => { stickyKey = input.stickyKey; return { observed: 'finalized' as const }; }, ownerToken: () => 'owner',
    });
    await tracker.track({ chain, txHash: '0xabc', required: 'finalized' });
    expect(stickyKey).toBe('ethereum-sepolia:0xabc');
  });

  it('trackUntil tolerates a brief DFR_TRANSACTION_NOT_FOUND and converges once the transaction is visible (F-2)', async () => {
    let clock = 0;
    let calls = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async () => {
        calls += 1;
        if (calls < 3) {
          throw createDfrError('DFR_TRANSACTION_NOT_FOUND', { requestId: newRequestId(), message: 'Transaction not found on-chain', chain });
        }
        return { observed: 'confirmed' as const };
      },
      ownerToken: () => 'owner', now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await expect(tracker.trackUntil({ chain, txHash: '0xabc', required: 'confirmed', timeoutMs: 60_000 })).resolves.toMatchObject({ reached: true, owner: true, observed: 'confirmed' });
    expect(calls).toBe(3);
  });

  it('trackUntil returns reached=false without throwing when the transaction is still unfindable at the deadline (F-2)', async () => {
    let clock = 0;
    let calls = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async () => {
        calls += 1;
        throw createDfrError('DFR_TRANSACTION_NOT_FOUND', { requestId: newRequestId(), message: 'Transaction not found on-chain', chain });
      },
      ownerToken: () => 'owner', now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await expect(tracker.trackUntil({ chain, txHash: '0xabc', required: 'confirmed', timeoutMs: 1_000 })).resolves.toMatchObject({ reached: false, owner: true, observed: 'unknown' });
    expect(calls).toBe(2);
  });

  it('trackUntil rethrows errors other than DFR_TRANSACTION_NOT_FOUND immediately (F-2)', async () => {
    let calls = 0;
    const boom = createDfrError('DFR_CHAIN_UNAVAILABLE', { requestId: newRequestId(), message: 'Chain unavailable', chain });
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async () => { calls += 1; throw boom; },
      ownerToken: () => 'owner',
    });
    await expect(tracker.trackUntil({ chain, txHash: '0xabc', required: 'confirmed', timeoutMs: 60_000 })).rejects.toBe(boom);
    expect(calls).toBe(1);
  });
});
