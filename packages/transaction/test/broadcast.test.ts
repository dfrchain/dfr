/**
 * TransactionEngine broadcast contract test (DFR-M1-C03a).
 *
 * Authoritative sources: transaction-lifecycle §3.1/§4.4, m1-api-contract §3/§5,
 * ADR-019's "decidable paths" boundary (C03b already covers the unknown path; see broadcast-unknown.test.ts).
 *
 * This task **deliberately excludes** `unknown` (that is C03b, awaiting the ADR-019 decision):
 * any broadcast failure only leaves the transaction at `signed` and rethrows verbatim; it never advances it to `failed`/`unknown` on its own.
 *
 * All with in-memory test doubles: only orchestration and state facts are verified, not SQL.
 */
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import type {
  AccountRef,
  BroadcastOptions,
  BroadcastResult,
  ChainId,
  DecimalUint,
  Iso8601,
  RequestId,
  SignedTransaction,
  SequencingToken,
  TransactionId,
  TransactionStatus,
  UnsignedTransaction,
} from '@dfr/types';
import {
  TransactionEngine,
  type ChainBroadcastInput,
  type TransactionChainPort,
  type TransactionRecord,
  type TransactionStore,
  type TransitionTransactionInput,
  type TransitionTransactionResult,
  type SequencingStore,
} from '../src/index.js';

function consumedSequencingStore(): SequencingStore {
  return {
    reserve: async () => { throw new Error('not used'); },
    markConsumed: async (ref) => ({
      kind: 'updated',
      lease: {
        chain: CHAIN,
        account: ref.account,
        token: { kind: 'blockhash', value: ref.tokenValue, lastValidBlockHeight: dec('100') },
        transactionId: ref.transactionId,
        status: 'consumed',
        expiresAt: iso(1_700_000_000_000),
      },
    }),
    releaseIfSafe: async () => { throw new Error('not used'); },
    releaseExpiredOrphaned: async () => 0,
  };
}

const CHAIN = 'ethereum-sepolia' as ChainId;
const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };
const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };
const REQUEST_ID = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;
const TX_ID = 'txn_test_c03a' as TransactionId;
const TX_HASH = `0x${'ab'.repeat(32)}`;

const dec = (value: string): DecimalUint => value as DecimalUint;
const iso = (ms: number): Iso8601 => new Date(ms).toISOString() as Iso8601;

const UNSIGNED: UnsignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN,
  payload: '0x02f8c0',
  meta: { encoding: 'hex', requiresNonce: dec('42'), chainIdForSigning: '11155111' },
};

const SIGNED: SignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN,
  unsigned: UNSIGNED,
  signedPayload: '0x02f8c1de' + 'ad'.repeat(40),
  expectedHash: TX_HASH,
  signerRef: 'external:test',
};

/* ------------------------------------------------------------------ */
/* Test doubles: TransactionStore                                              */
/* ------------------------------------------------------------------ */

class FakeTransactionStore implements TransactionStore {
  records = new Map<TransactionId, TransactionRecord>();
  readonly transitionCalls: TransitionTransactionInput[] = [];

  seed(status: TransactionStatus, overrides: Partial<TransactionRecord> = {}): TransactionRecord {
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
      ...overrides,
    };
    this.records.set(TX_ID, record);
    return record;
  }

  async create(): Promise<never> {
    throw new Error('not used');
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
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Test doubles: chain port (only the methods C03a needs)                              */
/* ------------------------------------------------------------------ */

interface RecordedBroadcast extends ChainBroadcastInput {
  readonly callIndex: number;
}

class FakeChainPort implements TransactionChainPort {
  readonly broadcastCalls: RecordedBroadcast[] = [];
  readonly expiryChecks: SequencingToken[] = [];
  isSequencingExpired?: NonNullable<TransactionChainPort['isSequencingExpired']>;
  /** Make broadcast throw (timeout / unclassifiable failure). */
  broadcastError?: unknown;
  broadcastResult?: BroadcastResult;

  async getPendingNonce(): Promise<DecimalUint> {
    return dec('42');
  }

  async build(): Promise<UnsignedTransaction> {
    return UNSIGNED;
  }

  async simulate(): Promise<never> {
    throw new Error('not used');
  }

  async broadcast(input: ChainBroadcastInput): Promise<BroadcastResult> {
    this.broadcastCalls.push({ ...input, callIndex: this.broadcastCalls.length });
    if (this.broadcastError !== undefined) throw this.broadcastError;
    return (
      this.broadcastResult ?? {
        ref: { kind: 'hash', hash: TX_HASH },
        status: 'broadcast',
        accepted: true,
        providerId: 'mock-primary' as never,
        observedAt: iso(1_700_000_002_000),
      }
    );
  }
}

function makeEngine(
  port: TransactionChainPort,
  stores: FakeTransactionStore,
  sequencing?: SequencingStore,
): TransactionEngine {
  return new TransactionEngine({
    stores: {
      transaction: stores,
      idempotency: {
        async begin() {
          return { kind: 'acquired', ownerToken: 'token' };
        },
        async complete() {
          return { kind: 'completed' };
        },
      } as never,
      nonce: {} as never,
      ...(sequencing === undefined ? {} : { sequencing }),
    },
    chain: port,
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

describe('AUTH-04 broadcast owner isolation', () => {
  it('denies another project before signing and network broadcast', async () => {
    const store = new FakeTransactionStore();store.seed('simulated');
    const port = new FakeChainPort();
    await expect(makeEngine(port, store).broadcast({
      transactionId: TX_ID, signed: SIGNED,
      requesterProjectId: 'another-project', authorizedChains: [CHAIN],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(port.broadcastCalls).toHaveLength(0);
    expect(store.transitionCalls).toHaveLength(0);
    expect(store.records.get(TX_ID)?.status).toBe('simulated');
  });

  it('denies an unauthorized chain before network broadcast', async () => {
    const store = new FakeTransactionStore();store.seed('simulated');
    const port = new FakeChainPort();
    await expect(makeEngine(port, store).broadcast({
      transactionId: TX_ID, signed: SIGNED,
      requesterProjectId: 'default', authorizedChains: ['solana-devnet' as ChainId],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(port.broadcastCalls).toHaveLength(0);
    expect(store.transitionCalls).toHaveLength(0);
  });

  it('accepts correct project and chain', async () => {
    const store = new FakeTransactionStore();store.seed('simulated');
    const port = new FakeChainPort();
    const ok = await makeEngine(port, store).broadcast({
      transactionId: TX_ID, signed: SIGNED,
      requesterProjectId: 'default', authorizedChains: [CHAIN],
    });
    expect(ok.status).toBe('broadcast');
    expect(port.broadcastCalls).toHaveLength(1);
  });
});

describe('B43 signed Solana blockhash broadcast freshness (fail closed)', () => {
  const blockhash: SequencingToken = {
    kind: 'blockhash',
    value: '11111111111111111111111111111111',
    lastValidBlockHeight: dec('100'),
  };

  function seedBlockhash(stores: FakeTransactionStore): void {
    const withoutNonce = { ...stores.seed('simulated', { sequencingRef: blockhash }) };
    Reflect.deleteProperty(withoutNonce, 'nonce');
    stores.records.set(TX_ID, withoutNonce);
  }

  it('rejects an already-expired persisted blockhash before network send', async () => {
    const stores = new FakeTransactionStore();
    seedBlockhash(stores);
    const port = new FakeChainPort();
    port.isSequencingExpired = async (input) => {
      port.expiryChecks.push(input.token);
      return true;
    };

    await expect(makeEngine(port, stores, consumedSequencingStore()).broadcast({
      transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'DFR_BLOCKHASH_EXPIRED' });
    expect(port.expiryChecks).toEqual([blockhash]);
    expect(port.broadcastCalls).toHaveLength(0);
    expect(stores.records.get(TX_ID)?.status).toBe('failed');
    expect(stores.transitionCalls.map(c => c.reason)).toEqual(['sign', 'broadcast.rejected']);
  });

  it('refuses to broadcast if no blockhash expiry port is provided', async () => {
    const stores = new FakeTransactionStore();
    seedBlockhash(stores);
    const port = new FakeChainPort();

    await expect(makeEngine(port, stores, consumedSequencingStore()).broadcast({
      transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
    expect(port.broadcastCalls).toHaveLength(0);
    expect(stores.records.get(TX_ID)?.status).toBe('unknown');
  });

  it('keeps signed blockhash unknown and does not send on expiry RPC timeout', async () => {
    const stores = new FakeTransactionStore();
    seedBlockhash(stores);
    const port = new FakeChainPort();
    port.isSequencingExpired = async () => {
      throw createDfrError('DFR_PROVIDER_TIMEOUT', {
        requestId: REQUEST_ID, chain: CHAIN, message: 'block height query timed out',
      });
    };

    await expect(makeEngine(port, stores, consumedSequencingStore()).broadcast({
      transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'DFR_PROVIDER_TIMEOUT' });
    expect(port.broadcastCalls).toHaveLength(0);
    expect(stores.records.get(TX_ID)?.status).toBe('unknown');
  });

  it('permits an unexpired persisted blockhash for exactly one network send', async () => {
    const stores = new FakeTransactionStore();
    seedBlockhash(stores);
    const port = new FakeChainPort();
    port.isSequencingExpired = async (input) => {
      port.expiryChecks.push(input.token);
      return false;
    };

    const result = await makeEngine(port, stores, consumedSequencingStore()).broadcast({
      transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID,
    });
    expect(result.status).toBe('broadcast');
    expect(port.expiryChecks).toEqual([blockhash]);
    expect(port.broadcastCalls).toHaveLength(1);
  });

  it('does not introduce an expiry read for nonce-based EVM broadcast', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    const port = new FakeChainPort();
    port.isSequencingExpired = async () => {
      throw new Error('EVM nonce should never require Solana block-height preflight');
    };
    const result = await makeEngine(port, stores).broadcast({
      transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID,
    });
    expect(result.status).toBe('broadcast');
    expect(port.broadcastCalls).toHaveLength(1);
  });
});

describe('TransactionEngine broadcast (DFR-M1-C03a)', () => {
  it('simulated → signed → broadcast: called exactly once, persists public fields, never stores the signature text', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    const port = new FakeChainPort();
    const engine = makeEngine(port, stores);

    const result = await engine.broadcast({
      transactionId: TX_ID,
      signed: SIGNED,
      requestId: REQUEST_ID,
    });

    expect(result.status).toBe('broadcast');
    expect(result.txHash).toBe(TX_HASH);
    expect(result.accepted).toBe(true);

    // Single broadcast: the Adapter's capability declaration + the Provider policy guarantee no retry, and the engine itself does not loop either.
    expect(port.broadcastCalls).toHaveLength(1);

    // The record holds only public fields: expectedHash / txHash, no signature text.
    const record = stores.records.get(TX_ID)!;
    expect(record.status).toBe('broadcast');
    expect(record.expectedHash).toBe(TX_HASH);
    expect(record.txHash).toBe(TX_HASH);
    expect(Object.keys(record)).not.toContain('signedPayload');

    // The state edge is strictly sign → broadcast.accepted.
    expect(stores.transitionCalls.map((c) => c.reason)).toEqual(['sign', 'broadcast.accepted']);
    expect(stores.transitionCalls[0]?.patch).toEqual({ expectedHash: TX_HASH });
  });

  it('hands the record\'s from and unsigned payload to the port as ground truth (the client echo does not count)', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    const port = new FakeChainPort();

    await makeEngine(port, stores).broadcast({
      transactionId: TX_ID,
      signed: SIGNED,
      requestId: REQUEST_ID,
    });

    expect(port.broadcastCalls[0]?.expected).toEqual({
      from: FROM,
      unsignedPayload: UNSIGNED.payload,
    });
  });

  it('rebroadcast option is passed through to the port and the result', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    const port = new FakeChainPort();
    port.broadcastResult = {
      ref: { kind: 'hash', hash: TX_HASH },
      status: 'broadcast',
      accepted: true,
      rebroadcast: true,
      observedAt: iso(1_700_000_002_000),
    };
    const options: BroadcastOptions = { rebroadcast: false };

    const result = await makeEngine(port, stores).broadcast({
      transactionId: TX_ID,
      signed: SIGNED,
      options,
      requestId: REQUEST_ID,
    });

    expect(port.broadcastCalls[0]?.options).toEqual(options);
    expect(result.rebroadcast).toBe(true);
  });

  it('built (not simulated) refuses broadcast: nothing may go on-chain before simulation', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('built');
    const port = new FakeChainPort();

    const error = await makeEngine(port, stores)
      .broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID })
      .then(() => undefined, (err: unknown) => err);

    expect((error as { code?: string }).code).toBe('DFR_TRANSACTION_REJECTED');
    expect((error as { details?: Record<string, unknown> }).details?.['reason']).toBe(
      'simulation_required',
    );
    expect(port.broadcastCalls).toHaveLength(0);
  });

  it('reverted (simulation failed) refuses broadcast: the block cannot be bypassed', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('reverted');
    const port = new FakeChainPort();

    const error = await makeEngine(port, stores)
      .broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID })
      .then(() => undefined, (err: unknown) => err);

    expect((error as { code?: string }).code).toBe('DFR_TRANSACTION_REJECTED');
    expect((error as { details?: Record<string, unknown> }).details?.['reason']).toBe(
      'simulation_failed',
    );
    expect(port.broadcastCalls).toHaveLength(0);
    expect(stores.records.get(TX_ID)!.status).toBe('reverted');
  });

  it('signed (already broadcasting) refuses a repeat broadcast, avoiding a second submission', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('signed');
    const port = new FakeChainPort();

    const error = await makeEngine(port, stores)
      .broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID })
      .then(() => undefined, (err: unknown) => err);

    expect((error as { details?: Record<string, unknown> }).details?.['reason']).toBe(
      'invalid_status',
    );
    expect(port.broadcastCalls).toHaveLength(0);
  });

  it('client-echoed unsigned payload differs from the record → refuse and do not broadcast', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    const port = new FakeChainPort();
    const tampered: SignedTransaction = {
      ...SIGNED,
      unsigned: { ...UNSIGNED, payload: '0x02deadbeef' },
    };

    const error = await makeEngine(port, stores)
      .broadcast({ transactionId: TX_ID, signed: tampered, requestId: REQUEST_ID })
      .then(() => undefined, (err: unknown) => err);

    expect((error as { code?: string }).code).toBe('DFR_TRANSACTION_REJECTED');
    expect((error as { details?: Record<string, unknown> }).details?.['reason']).toBe(
      'unsigned_payload_mismatch',
    );
    expect(port.broadcastCalls).toHaveLength(0);
    expect(stores.records.get(TX_ID)!.status).toBe('simulated');
  });

  it('record chain differs from the signed payload chain → DFR_CHAIN_MISMATCH, no broadcast', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    const port = new FakeChainPort();
    const wrongChain: SignedTransaction = { ...SIGNED, chain: 'base-sepolia' as ChainId };

    const error = await makeEngine(port, stores)
      .broadcast({ transactionId: TX_ID, signed: wrongChain, requestId: REQUEST_ID })
      .then(() => undefined, (err: unknown) => err);

    expect((error as { code?: string }).code).toBe('DFR_CHAIN_MISMATCH');
    expect(port.broadcastCalls).toHaveLength(0);
  });

  it('port without a broadcast implementation → DFR_UNSUPPORTED_CAPABILITY (fail-closed, never silently skipped)', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    // A port implementing only build/simulate (no broadcast wired up): a minimal test double, avoiding prototype methods that cannot be deleted.
    const port: TransactionChainPort = {
      getPendingNonce: async () => dec('42'),
      build: async () => UNSIGNED,
      simulate: async () => {
        throw new Error('not used');
      },
    };

    const error = await makeEngine(port, stores)
      .broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID })
      .then(() => undefined, (err: unknown) => err);

    expect((error as { code?: string }).code).toBe('DFR_UNSUPPORTED_CAPABILITY');
    // The state must not advance just because "the implementation is missing".
    expect(stores.records.get(TX_ID)!.status).toBe('simulated');
  });

  it('broadcast timeout → indeterminate result: land on unknown, never judge failed / accepted (ADR-019 replaces C03a\'s "stay at signed")', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    const port = new FakeChainPort();
    port.broadcastError = createDfrError('DFR_PROVIDER_TIMEOUT', {
      requestId: REQUEST_ID,
      message: 'Broadcast request timed out',
      chain: CHAIN,
      details: { method: 'eth_sendRawTransaction' },
    });

    const error = await makeEngine(port, stores)
      .broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID })
      .then(() => undefined, (err: unknown) => err);

    expect((error as { code?: string }).code).toBe('DFR_PROVIDER_TIMEOUT');
    // Safety property: indeterminate ≠ failure (a terminal state is irreversible), and ≠ success.
    // After ADR-019 landed, the landing spot is unknown (not signed): signed cannot express "may already be sent".
    const record = stores.records.get(TX_ID)!;
    expect(record.status).toBe('unknown');
    expect(record.status).not.toBe('failed');
    expect(port.broadcastCalls).toHaveLength(1);
  });

  it('unknown transaction → DFR_TRANSACTION_NOT_FOUND', async () => {
    const stores = new FakeTransactionStore();
    const port = new FakeChainPort();

    const error = await makeEngine(port, stores)
      .broadcast({ transactionId: 'txn_missing' as TransactionId, signed: SIGNED, requestId: REQUEST_ID })
      .then(() => undefined, (err: unknown) => err);

    expect((error as { code?: string }).code).toBe('DFR_TRANSACTION_NOT_FOUND');
  });
});
