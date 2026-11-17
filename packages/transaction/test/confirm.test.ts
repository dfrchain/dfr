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
  it('在 tracker lease 内按既有状态机与 CAS 持久化链上确认结果', async () => {
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

  it('未验证的 finalized 观测最多推进到 confirmed，不落库为 finalized', async () => {
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

  it('超时返回最后观测 reached=false，并用独立 signal 继续后台跟踪', async () => {
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

  it('缺少 tracker lease 或 chain confirm 端口时 fail-closed', async () => {
    const engine = new TransactionEngine({
      stores: { transaction: {} as never, idempotency: {} as never, nonce: {} as never },
      chain: {} as unknown as TransactionChainPort,
    });
    await expect(engine.confirm({ chain, txHash: hash, timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_CAPABILITY',
    });
  });

  it('广播后短暂查无此笔不中止 confirm：截止返回 pending 并转后台收敛（F-2）', async () => {
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
            throw createDfrError('DFR_TRANSACTION_NOT_FOUND', { requestId: newRequestId(), message: '链上未找到该交易', chain });
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
