import { describe, expect, it } from 'vitest';
import type { ChainId, ConfirmationResult, TransactionStatus } from '@dfr/types';
import { createDfrError, newRequestId } from '@dfr/errors';
import type { TrackerLease, TrackerLeaseStore } from '../src/stores.js';
import type { ChainConfirmInput, TransactionChainPort } from '../src/engine.js';
import { TransactionEngine } from '../src/engine.js';

const chain = 'ethereum-sepolia' as ChainId;
const hash = `0x${'a'.repeat(64)}`;
const lease: TrackerLease = {
  chain,
  txHash: hash,
  ownerToken: 'owner',
  leaseExpiresAt: '2026-10-05T02:00:00.000Z' as never,
  heartbeatAt: '2026-10-05T01:59:00.000Z' as never,
};

function confirmation(reached: boolean): ConfirmationResult {
  return {
    ref: { kind: 'hash', hash },
    status: 'included',
    finality: 'included',
    requiredFinality: 'finalized',
    confirmations: '2' as never,
    reached,
  };
}

function trackerLeases(): TrackerLeaseStore {
  return {
    acquire: async () => ({ kind: 'acquired', lease }),
    renew: async () => ({ kind: 'renewed', lease }),
    release: async () => ({ kind: 'released' }),
    listRecoverable: async () => [],
  };
}

describe('TransactionEngine.confirm', () => {
  it('persists on-chain confirmation results inside the tracker lease, using the existing state machine and CAS', async () => {
    const record = {
      transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJK01',
      projectId: 'default',
      chain,
      requestFingerprint: 'f'.repeat(64),
      status: 'included',
      stateVersion: '7',
      from: { chain, address: '0x1111111111111111111111111111111111111111' },
      txHash: hash,
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    } as const;
    let moved: unknown;
    const transactionStore = {
      getByHash: async () => record,
      transition: async (input: unknown) => {
        moved = input;
        return { kind: 'applied', record: { ...record, status: 'confirmed', stateVersion: '8' } };
      },
    };
    const engine = new TransactionEngine({
      stores: {
        transaction: transactionStore as never,
        idempotency: {} as never,
        nonce: {} as never,
        tracker: trackerLeases(),
      },
      chain: {
        confirm: async () => ({
          ...confirmation(true),
          status: 'confirmed',
          finality: 'confirmed',
          blockRef: { kind: 'number', number: '100' },
        }),
      } as unknown as TransactionChainPort,
    });

    await engine.confirm({ chain, txHash: hash, timeoutMs: 1_000 });

    expect(moved).toMatchObject({
      transactionId: record.transactionId,
      expectedStatus: 'included',
      expectedVersion: '7',
      toStatus: 'confirmed',
      reason: 'confirmed',
    });
    engine.close();
  });

  it('an unverified finalized observation advances at most to confirmed, never persisting as finalized', async () => {
    let current: {
      transactionId: string;
      projectId: string;
      chain: ChainId;
      requestFingerprint: string;
      status: TransactionStatus;
      stateVersion: string;
      from: { chain: ChainId; address: string };
      txHash: string;
      createdAt: string;
      updatedAt: string;
    } = {
      transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJK02',
      projectId: 'default',
      chain,
      requestFingerprint: 'e'.repeat(64),
      status: 'included',
      stateVersion: '3',
      from: { chain, address: '0x1111111111111111111111111111111111111111' },
      txHash: hash,
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    };
    const reasons: string[] = [];
    const transactionStore = {
      getByHash: async () => current,
      transition: async (input: { toStatus: string; reason: string }) => {
        reasons.push(input.reason);
        current = { ...current, status: input.toStatus as TransactionStatus, stateVersion: '4' };
        return { kind: 'applied', record: current };
      },
    };
    const engine = new TransactionEngine({
      stores: {
        transaction: transactionStore as never,
        idempotency: {} as never,
        nonce: {} as never,
        tracker: trackerLeases(),
      },
      chain: {
        confirm: async () => ({
          ...confirmation(false),
          status: 'confirmed',
          finality: 'finalized',
          requiredFinality: 'finalized',
        }),
      } as unknown as TransactionChainPort,
    });

    await engine.confirm({ chain, txHash: hash, timeoutMs: 1_000 });

    expect(current.status).toBe('confirmed');
    expect(reasons).toEqual(['confirmed']);
    engine.close();
  });

  it('a timeout returns the last observation with reached=false, and keeps following in the background with an independent signal', async () => {
    let clock = 0;
    let calls = 0;
    const signals: AbortSignal[] = [];
    const engine = new TransactionEngine({
      stores: {
        transaction: { getByHash: async () => null } as never,
        idempotency: {} as never,
        nonce: {} as never,
        tracker: trackerLeases(),
      },
      chain: {
        confirm: async (input: ChainConfirmInput) => {
          calls += 1;
          signals.push(input.signal);
          return confirmation(calls >= 3);
        },
      } as unknown as TransactionChainPort,
      confirmationClock: () => clock,
      confirmationSleep: async (ms) => { clock += ms; },
    });
    const caller = new AbortController();
    const result = await engine.confirm({ chain, txHash: hash, timeoutMs: 1_000, signal: caller.signal });
    expect(result.reached).toBe(false);
    for (let index = 0; index < 10 && calls < 3; index += 1) await Promise.resolve();
    expect(calls).toBe(3);
    expect(signals[0]).toBe(caller.signal);
    expect(signals[2]).not.toBe(caller.signal);
    engine.close();
  });

  it('fail-closed when the tracker lease or the chain confirm port is missing', async () => {
    const engine = new TransactionEngine({
      stores: { transaction: {} as never, idempotency: {} as never, nonce: {} as never },
      chain: {} as unknown as TransactionChainPort,
    });
    await expect(engine.confirm({ chain, txHash: hash, timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_CAPABILITY',
    });
  });

  it('a transaction briefly unfindable right after broadcast does not abort confirm: return pending at the deadline and converge in the background (F-2)', async () => {
    let clock = 0;
    let calls = 0;
    const signals: AbortSignal[] = [];
    const engine = new TransactionEngine({
      stores: {
        transaction: { getByHash: async () => null } as never,
        idempotency: {} as never,
        nonce: {} as never,
        tracker: trackerLeases(),
      },
      chain: {
        confirm: async (input: ChainConfirmInput) => {
          calls += 1;
          signals.push(input.signal);
          if (calls < 3) {
            throw createDfrError('DFR_TRANSACTION_NOT_FOUND', { requestId: newRequestId(), message: 'Transaction not found on-chain', chain });
          }
          return confirmation(true);
        },
      } as unknown as TransactionChainPort,
      confirmationClock: () => clock,
      confirmationSleep: async (ms) => { clock += ms; },
    });
    const caller = new AbortController();
    const result = await engine.confirm({ chain, txHash: hash, timeoutMs: 1_000, signal: caller.signal });
    expect(result).toMatchObject({ status: 'pending', finality: 'unknown', reached: false });
    for (let index = 0; index < 50 && calls < 3; index += 1) await Promise.resolve();
    expect(calls).toBe(3);
    expect(signals[2]).not.toBe(caller.signal);
    engine.close();
  });
});
