/**
 * TransactionEngine simulate contract test (DFR-M1-B05).
 *
 * Authoritative sources: transaction-lifecycle sections 4.2/3.1, m1-api-contract section 2.
 *
 * This task's two deliverables:
 *   1. binding: simulate's UnsignedTransaction must match the build-persisted payload byte for byte;
 *   2. blocking: a failed simulation lands the transaction on reverted (terminal state), after which broadcast is unreachable at the state-machine level.
 *
 * All with in-memory test doubles: only orchestration and state facts are verified, not SQL.
 */
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import type {
  AccountRef,
  ChainId,
  DecimalUint,
  Iso8601,
  RequestId,
  SimulationResult,
  TransactionId,
  UnsignedTransaction,
} from '@dfr/types';
import {
  TransactionEngine,
  canTransition,
  transition,
  type ChainSimulateInput,
  type TransactionChainPort,
  type TransactionRecord,
  type TransactionStore,
  type TransitionTransactionInput,
  type TransitionTransactionResult,
} from '../src/index.js';

const CHAIN = 'ethereum-sepolia' as ChainId;
const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };
const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };
const REQUEST_ID = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;
const TX_ID = 'txn_test_1' as TransactionId;

const dec = (value: string): DecimalUint => value as DecimalUint;
const iso = (ms: number): Iso8601 => new Date(ms).toISOString() as Iso8601;

const UNSIGNED: UnsignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN,
  payload: '0x02f8',
  meta: { encoding: 'hex', requiresNonce: dec('42'), chainIdForSigning: '11155111' },
};

/* ------------------------------------------------------------------ */
/* Test doubles: TransactionStore (supports injected CAS conflicts)                        */
/* ------------------------------------------------------------------ */

class FakeTransactionStore implements TransactionStore {
  records = new Map<TransactionId, TransactionRecord>();
  readonly transitionCalls: TransitionTransactionInput[] = [];
  /** Make the next N transitions return a version_conflict first (simulating a concurrent write). */
  conflictsBeforeApply = 0;

  seed(status: TransactionRecord['status']): TransactionRecord {
    const record: TransactionRecord = {
      transactionId: TX_ID,
      projectId: 'default',
      chain: CHAIN,
      requestFingerprint: 'f'.repeat(64),
      status,
      stateVersion: dec('0'),
      from: FROM,
      to: TO,
      nonce: dec('42'),
      unsignedPayload: UNSIGNED.payload,
      payloadEncoding: 'hex',
      createdAt: iso(1_700_000_000_000),
      updatedAt: iso(1_700_000_000_000),
    };
    this.records.set(TX_ID, record);
    return record;
  }

  async create({ record }: { record: TransactionRecord }) {
    this.records.set(record.transactionId, record);
    return { kind: 'created' as const, record };
  }

  async get(transactionId: TransactionId): Promise<TransactionRecord | null> {
    return this.records.get(transactionId) ?? null;
  }

  async getByHash(chain: ChainId, txHash: string): Promise<TransactionRecord | null> {
    return [...this.records.values()].find((record) => record.chain === chain &&
      (record.txHash === txHash || record.expectedHash === txHash)) ?? null;
  }

  async transition(input: TransitionTransactionInput): Promise<TransitionTransactionResult> {
    this.transitionCalls.push(input);
    const current = this.records.get(input.transactionId);
    if (current === undefined) return { kind: 'not_found' };

    if (this.conflictsBeforeApply > 0) {
      this.conflictsBeforeApply -= 1;
      // Simulate "another executor wrote a version first": the version has advanced.
      const bumped: TransactionRecord = {
        ...current,
        stateVersion: dec((BigInt(current.stateVersion) + 1n).toString(10)),
      };
      this.records.set(input.transactionId, bumped);
      return { kind: 'version_conflict', current: bumped };
    }

    if (current.stateVersion !== input.expectedVersion) {
      return { kind: 'version_conflict', current };
    }
    if (current.status !== input.expectedStatus) {
      return { kind: 'status_conflict', current };
    }
    const patch = input.patch ?? {};
    const { blockRef: patchBlockRef, canonicalBlockHash: patchBlockHash, ...otherPatch } = patch;
    const { blockRef: currentBlockRef, canonicalBlockHash: currentBlockHash, ...currentWithoutAnchors } = current;
    const next: TransactionRecord = {
      ...currentWithoutAnchors,
      ...otherPatch,
      ...(patchBlockRef === null ? {} : patchBlockRef !== undefined
        ? { blockRef: patchBlockRef }
        : currentBlockRef !== undefined ? { blockRef: currentBlockRef } : {}),
      ...(patchBlockHash === null ? {} : patchBlockHash !== undefined
        ? { canonicalBlockHash: patchBlockHash }
        : currentBlockHash !== undefined ? { canonicalBlockHash: currentBlockHash } : {}),
      status: input.toStatus,
      stateVersion: dec((BigInt(current.stateVersion) + 1n).toString(10)),
      updatedAt: iso(1_700_000_001_000),
    };
    this.records.set(input.transactionId, next);
    return { kind: 'applied', record: next };
  }

  async listRecoverable(): Promise<readonly TransactionRecord[]> {
    return [...this.records.values()];
  }
}

/* ------------------------------------------------------------------ */
/* Test doubles: chain port                                                       */
/* ------------------------------------------------------------------ */

class FakeChainPort implements TransactionChainPort {
  readonly simulateCalls: ChainSimulateInput[] = [];
  result: SimulationResult = { success: true, estimatedCost: dec('21000') };
  error?: Error;

  async getPendingNonce(): Promise<never> {
    throw new Error('B05 must not read the pending nonce');
  }

  async build(): Promise<never> {
    throw new Error('B05 must not reconstruct the transaction');
  }

  async simulate(input: ChainSimulateInput): Promise<SimulationResult> {
    this.simulateCalls.push(input);
    if (this.error !== undefined) throw this.error;
    return this.result;
  }
}

/* ------------------------------------------------------------------ */
/* Assembly                                                               */
/* ------------------------------------------------------------------ */

interface Harness {
  engine: TransactionEngine;
  store: FakeTransactionStore;
  chain: FakeChainPort;
  releasedNonces: string[];
}

function harness(): Harness {
  const store = new FakeTransactionStore();
  const chain = new FakeChainPort();
  const releasedNonces: string[] = [];
  const engine = new TransactionEngine({
    stores: {
      transaction: store,
      // B05 does not touch idempotency or nonces; fail the test immediately if it is ever called.
      idempotency: {
        begin: async () => {
          throw new Error('B05 must not touch idempotency');
        },
        complete: async () => {
          throw new Error('B05 must not touch idempotency');
        },
        get: async () => null,
        pruneExpired: async () => 0,
      },
      nonce: {
        reserve: async () => {
          throw new Error('B05 must not touch the nonce lease');
        },
        markBroadcast: async () => {
          throw new Error('B05 must not touch the nonce lease');
        },
        markConsumed: async () => {
          throw new Error('B05 must not touch the nonce lease');
        },
        releaseIfSafe: async (ref) => {
          releasedNonces.push(ref.nonce);
          return { kind: 'not_found' as const };
        },
        releaseExpiredOrphaned: async () => {
          throw new Error('B05 must not touch the nonce lease');
        },
      },
    },
    chain,
  });
  return { engine, store, chain, releasedNonces };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('AUTH-04 simulation owner isolation', () => {
  it('denies another project before RPC and state writes', async () => {
    const h = harness();
    h.store.seed('built');
    await expect(h.engine.simulate({
      transactionId: TX_ID, unsignedTransaction: UNSIGNED,
      requesterProjectId: 'another-project', authorizedChains: [CHAIN],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
    expect(h.store.transitionCalls).toHaveLength(0);
  });

  it('denies the correct project on a foreign chain', async () => {
    const h = harness();
    h.store.seed('built');
    await expect(h.engine.simulate({
      transactionId: TX_ID, unsignedTransaction: UNSIGNED,
      requesterProjectId: 'default', authorizedChains: ['solana-devnet' as ChainId],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('accepts correct project and chain', async () => {
    const h = harness(); h.store.seed('built');
    const ok = await h.engine.simulate({
      transactionId: TX_ID, unsignedTransaction: UNSIGNED,
      requesterProjectId: 'default', authorizedChains: [CHAIN],
    });
    expect(ok.status).toBe('simulated');
    expect(h.chain.simulateCalls).toHaveLength(1);
  });
});

describe('TransactionEngine.simulate (DFR-M1-B05)', () => {
  it('successful simulation: built becomes simulated; both the persisted state and the observation result are updated', async () => {
    const h = harness();
    h.store.seed('built');

    const result = await h.engine.simulate({
      transactionId: TX_ID,
      unsignedTransaction: UNSIGNED,
      requestId: REQUEST_ID,
    });

    expect(result.transactionId).toBe(TX_ID);
    expect(result.status).toBe('simulated');
    expect(result.simulation.success).toBe(true);
    expect(result.simulation.estimatedCost).toBe('21000');
    expect((await h.store.get(TX_ID))?.status).toBe('simulated');
    // The port must receive the sender (the payload itself contains no from; EVM needs it to cover balance/allowance checks).
    expect(h.chain.simulateCalls[0]?.from).toEqual(FROM);
    expect(h.chain.simulateCalls[0]?.unsigned).toEqual(UNSIGNED);
  });

  it('failed simulation: built becomes reverted, throws DFR_TRANSACTION_REVERTED with revertReason', async () => {
    const h = harness();
    h.store.seed('built');
    h.chain.result = {
      success: false,
      revertReason: 'execution reverted: insufficient allowance',
      estimatedCost: dec('21000'),
    };

    await expect(
      h.engine.simulate({
        transactionId: TX_ID,
        unsignedTransaction: UNSIGNED,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'DFR_TRANSACTION_REVERTED',
      details: { transactionId: TX_ID, revertReason: 'execution reverted: insufficient allowance' },
    });

    const record = await h.store.get(TX_ID);
    expect(record?.status).toBe('reverted');
    expect(record?.errorCode).toBe('DFR_TRANSACTION_REVERTED');
    expect(h.releasedNonces).toEqual(['42']);
  });

  it('TX-01: simulated-state failure also attempts owned nonce release', async () => {
    const h = harness();
    h.store.seed('simulated');
    h.chain.result = { success: false, revertReason: 'preflight reverted' };
    await expect(h.engine.simulate({
      transactionId: TX_ID,
      unsignedTransaction: UNSIGNED,
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REVERTED' });
    expect((await h.store.get(TX_ID))?.status).toBe('reverted');
    expect(h.releasedNonces).toEqual(['42']);
  });

  it('after reverted, broadcast is unreachable at the state-machine level (broadcast blocked)', async () => {
    const h = harness();
    h.store.seed('built');
    h.chain.result = { success: false, revertReason: 'execution reverted' };

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REVERTED' });

    // This is the mechanical evidence for "a failed simulation must not broadcast": the terminal state has no outbound edges.
    expect(canTransition({ from: 'reverted', event: 'sign' })).toBe(false);
    expect(canTransition({ from: 'reverted', event: 'broadcast.accepted' })).toBe(false);
    expect(transition({ from: 'reverted', event: 'broadcast.accepted' }).ok).toBe(false);
  });

  it('simulating an already-reverted transaction returns DFR_VALIDATION_FAILED (without calling the chain)', async () => {
    const h = harness();
    h.store.seed('reverted');

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED, requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('reject when the payload differs from the build-persisted record, without calling the chain at all', async () => {
    const h = harness();
    h.store.seed('built');
    const tampered: UnsignedTransaction = { ...UNSIGNED, payload: '0x02f9deadbeef' };

    await expect(
      h.engine.simulate({
        transactionId: TX_ID,
        unsignedTransaction: tampered,
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: 'DFR_VALIDATION_FAILED',
      details: { fields: ['unsignedTransaction.payload'] },
    });
    expect(h.chain.simulateCalls).toHaveLength(0);
    expect((await h.store.get(TX_ID))?.status).toBe('built');
  });

  it('reject when the payload chain differs from the record', async () => {
    const h = harness();
    h.store.seed('built');
    const foreign: UnsignedTransaction = { ...UNSIGNED, chain: 'base-sepolia' as ChainId };

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: foreign }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('reject when the payload meta.requiresNonce differs from the record nonce', async () => {
    const h = harness();
    h.store.seed('built');
    const wrongNonce: UnsignedTransaction = {
      ...UNSIGNED,
      meta: { ...UNSIGNED.meta, requiresNonce: dec('43') },
    };

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: wrongNonce }),
    ).rejects.toMatchObject({
      code: 'DFR_VALIDATION_FAILED',
      details: { fields: ['unsignedTransaction.meta.requiresNonce'] },
    });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('an unknown transactionId returns DFR_TRANSACTION_NOT_FOUND', async () => {
    const h = harness();
    await expect(
      h.engine.simulate({ transactionId: 'txn_missing' as TransactionId, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_NOT_FOUND' });
    expect(h.chain.simulateCalls).toHaveLength(0);
  });

  it('a transaction already in signing/broadcast does not allow simulate again', async () => {
    const h = harness();
    h.store.seed('signed');
    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    expect(h.chain.simulateCalls).toHaveLength(0);
    expect((await h.store.get(TX_ID))?.status).toBe('signed');
  });

  it('repeat simulate (already simulated) succeeds without changing state, only updating the observation', async () => {
    const h = harness();
    h.store.seed('simulated');
    h.chain.result = { success: true, estimatedCost: dec('21500') };

    const result = await h.engine.simulate({
      transactionId: TX_ID,
      unsignedTransaction: UNSIGNED,
    });

    expect(result.status).toBe('simulated');
    expect(result.simulation.estimatedCost).toBe('21500');
    const record = await h.store.get(TX_ID);
    expect(record?.status).toBe('simulated');
    // No state transition: no transition call should be produced.
    expect(h.store.transitionCalls).toHaveLength(0);
  });

  it('repeat simulate (already simulated) failing moves to reverted, equally blocking broadcast', async () => {
    const h = harness();
    h.store.seed('simulated');
    h.chain.result = { success: false, revertReason: 'execution reverted: state changed' };

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REVERTED' });

    expect((await h.store.get(TX_ID))?.status).toBe('reverted');
    expect(canTransition({ from: 'reverted', event: 'broadcast.accepted' })).toBe(false);
  });

  it('on a CAS version conflict, re-read and retry automatically, succeeding in the end', async () => {
    const h = harness();
    h.store.seed('built');
    h.store.conflictsBeforeApply = 1;

    const result = await h.engine.simulate({
      transactionId: TX_ID,
      unsignedTransaction: UNSIGNED,
    });

    expect(result.status).toBe('simulated');
    expect(h.store.transitionCalls).toHaveLength(2);
    expect((await h.store.get(TX_ID))?.status).toBe('simulated');
  });

  it('when the chain port throws a non-revert error, the state stays built and the error is rethrown verbatim', async () => {
    const h = harness();
    h.store.seed('built');
    h.chain.error = createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId: REQUEST_ID,
      chain: CHAIN,
      message: 'endpoint down',
    });

    await expect(
      h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED }),
    ).rejects.toMatchObject({ code: 'DFR_PROVIDER_UNAVAILABLE' });

    expect((await h.store.get(TX_ID))?.status).toBe('built');
    expect(h.store.transitionCalls).toHaveLength(0);
  });

  it('simulate touches neither idempotency nor nonce, and does not write signedPayload', async () => {
    const h = harness();
    h.store.seed('built');
    await h.engine.simulate({ transactionId: TX_ID, unsignedTransaction: UNSIGNED });

    const record = (await h.store.get(TX_ID)) as unknown as Record<string, unknown>;
    expect(Object.keys(record)).not.toContain('signedPayload');
    expect(JSON.stringify(record)).not.toContain('"signedPayload"');
  });
});
