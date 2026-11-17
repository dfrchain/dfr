import { describe, expect, it } from 'vitest';
import type { ChainId, Iso8601 } from '@dfr/types';
import { createDfrError, newRequestId } from '@dfr/errors';
import { ConfirmationTracker } from '../src/tracker.js';

const chain = 'ethereum-sepolia' as ChainId;
const lease = { chain, txHash: '0xabc', ownerToken: 'owner', leaseExpiresAt: '2026-01-01T00:00:01.000Z' as Iso8601, heartbeatAt: '2026-01-01T00:00:00.000Z' as Iso8601 };

describe('ConfirmationTracker', () => {
  it('租约被其他 owner 持有时不观测并返回 reached=false', async () => {
    let observed = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'held_by_other' as const, lease }), renew: async () => ({ kind: 'lost' as const }), release: async () => ({ kind: 'lost' as const }), listRecoverable: async () => [] },
      observe: async () => { observed += 1; return { observed: 'submitted' as const }; },
      ownerToken: () => 'owner',
    });
    await expect(tracker.track({ chain, txHash: '0xabc', required: 'confirmed' })).resolves.toMatchObject({ reached: false, owner: false });
    expect(observed).toBe(0);
  });

  it('续租丢失后停止观测，不再以旧 owner 写入', async () => {
    let observed = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'lost' as const }), release: async () => ({ kind: 'lost' as const }), listRecoverable: async () => [] },
      observe: async () => { observed += 1; return { observed: 'finalized' as const }; }, ownerToken: () => 'owner',
    });
    await expect(tracker.track({ chain, txHash: '0xabc', required: 'finalized' })).resolves.toMatchObject({ owner: false, reached: false });
    expect(observed).toBe(0);
  });

  it('超时返回 reached=false，轮询间隔由注入时钟控制', async () => {
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

  it('每次确认观测使用稳定的 chain:txHash sticky key', async () => {
    let stickyKey = '';
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async (input) => { stickyKey = input.stickyKey; return { observed: 'finalized' as const }; }, ownerToken: () => 'owner',
    });
    await tracker.track({ chain, txHash: '0xabc', required: 'finalized' });
    expect(stickyKey).toBe('ethereum-sepolia:0xabc');
  });

  it('trackUntil 容忍短暂的 DFR_TRANSACTION_NOT_FOUND，交易可见后收敛（F-2）', async () => {
    let clock = 0;
    let calls = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async () => {
        calls += 1;
        if (calls < 3) {
          throw createDfrError('DFR_TRANSACTION_NOT_FOUND', { requestId: newRequestId(), message: '链上未找到该交易', chain });
        }
        return { observed: 'confirmed' as const };
      },
      ownerToken: () => 'owner', now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await expect(tracker.trackUntil({ chain, txHash: '0xabc', required: 'confirmed', timeoutMs: 60_000 })).resolves.toMatchObject({ reached: true, owner: true, observed: 'confirmed' });
    expect(calls).toBe(3);
  });

  it('trackUntil 在截止时仍查无此笔时返回 reached=false 而不抛错（F-2）', async () => {
    let clock = 0;
    let calls = 0;
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async () => {
        calls += 1;
        throw createDfrError('DFR_TRANSACTION_NOT_FOUND', { requestId: newRequestId(), message: '链上未找到该交易', chain });
      },
      ownerToken: () => 'owner', now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await expect(tracker.trackUntil({ chain, txHash: '0xabc', required: 'confirmed', timeoutMs: 1_000 })).resolves.toMatchObject({ reached: false, owner: true, observed: 'unknown' });
    expect(calls).toBe(2);
  });

  it('trackUntil 对 DFR_TRANSACTION_NOT_FOUND 以外的错误立即上抛（F-2）', async () => {
    let calls = 0;
    const boom = createDfrError('DFR_CHAIN_UNAVAILABLE', { requestId: newRequestId(), message: '链不可用', chain });
    const tracker = new ConfirmationTracker({
      leases: { acquire: async () => ({ kind: 'acquired' as const, lease }), renew: async () => ({ kind: 'renewed' as const, lease }), release: async () => ({ kind: 'released' as const }), listRecoverable: async () => [] },
      observe: async () => { calls += 1; throw boom; },
      ownerToken: () => 'owner',
    });
    await expect(tracker.trackUntil({ chain, txHash: '0xabc', required: 'confirmed', timeoutMs: 60_000 })).rejects.toBe(boom);
    expect(calls).toBe(1);
  });
});
