/**
 * TransactionEngine broadcast timeout and `unknown` resolution (DFR-M1-C03b).
 *
 * Authoritative sources: ADR-019 (Accepted), transaction-lifecycle §3.1/§3.2, m1-api-contract §5.
 *
 * This task closes TODO-006: when a broadcast result is indeterminate, it must be judged **neither** success nor failure;
 * first land on `unknown`, then resolve by on-chain observation to `pending / included / replaced`;
 * when nothing is found and the nonce is unoccupied, **stay `unknown`** (mempool propagation is asynchronous;
 * "not found right now" is not "already dropped" — `unknown → dropped` is left to M1-D03's dropTimeoutMs window).
 *
 * All with in-memory test doubles: only orchestration, classification, and state facts are verified, not SQL.
 */
import { describe, expect, it } from 'vitest';
import { createDfrError, isDfrError } from '@dfr/errors';
import type {
  AccountRef,
  BlockRef,
  BroadcastResult,
  ChainId,
  DecimalUint,
  Iso8601,
  RequestId,
  SignedTransaction,
  TransactionId,
  TransactionStatus,
  UnsignedTransaction,
} from '@dfr/types';
import {
  TransactionEngine,
  classifyBroadcastFailure,
  resolveUnknownOutcome,
  type ChainBroadcastInput,
  type ChainBroadcastObservation,
  type ChainObserveInput,
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
const TX_ID = 'txn_test_c03b' as TransactionId;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;

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

/* ------------------------------ Test doubles ------------------------------ */

class FakeTransactionStore implements TransactionStore {
  records = new Map<TransactionId, TransactionRecord>();
  readonly transitionCalls: TransitionTransactionInput[] = [];
  failOnTransitionReason?: string;

  seed(status: TransactionStatus): TransactionRecord {
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
    if (this.failOnTransitionReason === input.reason) throw new Error('DB connection interrupted');
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

interface PortOptions {
  broadcastError?: unknown;
  broadcastResult?: BroadcastResult;
  observation?: ChainBroadcastObservation;
  observeError?: unknown;
  /** true means observe is not wired up at all (simulating an old deployment). */
  withoutObserve?: boolean;
}

class FakeChainPort implements TransactionChainPort {
  readonly broadcastCalls: ChainBroadcastInput[] = [];
  readonly observeCalls: ChainObserveInput[] = [];
  private readonly options: PortOptions;

  constructor(options: PortOptions = {}) {
    this.options = options;
    if (options.withoutObserve) {
      delete (this as { observe?: unknown }).observe;
    }
  }

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
    this.broadcastCalls.push(input);
    if (this.options.broadcastError !== undefined) throw this.options.broadcastError;
    return (
      this.options.broadcastResult ?? {
        ref: { kind: 'hash', hash: TX_HASH },
        status: 'broadcast',
        accepted: true,
        observedAt: iso(1_700_000_002_000),
      }
    );
  }

  async observe(input: ChainObserveInput): Promise<ChainBroadcastObservation> {
    this.observeCalls.push(input);
    if (this.options.observeError !== undefined) throw this.options.observeError;
    return this.options.observation ?? { kind: 'absent' };
  }
}

function makeEngine(port: TransactionChainPort, stores: FakeTransactionStore): TransactionEngine {
  return new TransactionEngine({
    stores: {
      transaction: stores,
      idempotency: { begin: async () => ({ kind: 'acquired', ownerToken: 't' }), complete: async () => ({ kind: 'completed' }) } as never,
      nonce: {} as never,
    },
    chain: port,
  });
}

const TIMEOUT = () =>
  createDfrError('DFR_PROVIDER_TIMEOUT', {
    requestId: REQUEST_ID,
    message: 'Broadcast request timed out',
    chain: CHAIN,
    details: { method: 'eth_sendRawTransaction' },
  });

async function run(port: PortOptions, status: TransactionStatus = 'simulated') {
  const stores = new FakeTransactionStore();
  stores.seed(status);
  const fake = new FakeChainPort(port);
  const error = await makeEngine(fake, stores)
    .broadcast({ transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID })
    .then(() => undefined, (err: unknown) => err);
  return { stores, port: fake, error, record: stores.records.get(TX_ID)! };
}

/* ------------------------------ Tests ------------------------------ */

describe('Broadcast failure classification (ADR-019, section 3, pure function)', () => {
  it('TX-02: peer rejection cannot prove an already-signed transaction never propagated', () => {
    const classify = (code: never) => {
      const err = createDfrError(code, { requestId: REQUEST_ID, message: 'x', chain: CHAIN });
      return classifyBroadcastFailure(err);
    };
    expect(classify('DFR_TRANSACTION_REJECTED' as never)).toBe('indeterminate');
    expect(classify('DFR_INSUFFICIENT_FUNDS' as never)).toBe('indeterminate');
    expect(classify('DFR_VALIDATION_FAILED' as never)).toBe('indeterminate');
    // A locally verified, expired Solana blockhash is the only exception.
    expect(classify('DFR_BLOCKHASH_EXPIRED' as never)).toBe('rejected');
  });

  it('Provider timeout / unavailable / circuit breaker / nonce conflict are all indeterminate, not rejections', () => {
    for (const code of [
      'DFR_PROVIDER_TIMEOUT',
      'DFR_PROVIDER_UNAVAILABLE',
      'DFR_PROVIDER_CIRCUIT_OPEN',
      'DFR_NONCE_CONFLICT',
    ] as const) {
      const err = createDfrError(code, { requestId: REQUEST_ID, message: 'x', chain: CHAIN });
      expect(classifyBroadcastFailure(err), code).toBe('indeterminate');
    }
  });

  it('Non-DfrError values are always treated as indeterminate (never guessed, never treated as a provable rejection)', () => {
    expect(classifyBroadcastFailure(new Error('boom'))).toBe('indeterminate');
  });

  it.each([
    ['already known', 'DFR_TRANSACTION_REJECTED', 'indeterminate'],
    ['underpriced', 'DFR_PROVIDER_UNAVAILABLE', 'indeterminate'],
    ['replacement transaction underpriced', 'DFR_PROVIDER_UNAVAILABLE', 'indeterminate'],
  ] as const)('%s failure is classified as %s by the matrix', (_label, code, expected) => {
    const err = createDfrError(code, { requestId: REQUEST_ID, message: 'provider response', chain: CHAIN });
    expect(classifyBroadcastFailure(err)).toBe(expected);
  });
});

describe('On-chain observation → unknown resolution (ADR-019, section 2, pure function)', () => {
  it.each([
    ['pending', 'mempool.entered'],
    ['included', 'included'],
    ['replaced', 'replaced'],
  ] as const)('%s observation resolves to the %s event', (kind, event) => {
    expect(resolveUnknownOutcome({ kind } as ChainBroadcastObservation)).toBe(event);
  });

  it('an absent observation resolves to no event (stay unknown; wait for D03's dropTimeoutMs window)', () => {
    expect(resolveUnknownOutcome({ kind: 'absent' })).toBeNull();
  });
});

describe('TransactionEngine broadcast timeout (DFR-M1-C03b)', () => {
  it('timeout with nothing found → land on unknown and rethrow the original error (neither success nor failure)', async () => {
    const { record, error, port, stores } = await run({ broadcastError: TIMEOUT() });

    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(record.status).toBe('unknown');
    // State edge: sign → broadcast.indeterminate (no rejected).
    expect(stores.transitionCalls.map((c) => c.reason)).toEqual([
      'sign',
      'broadcast.indeterminate',
    ]);
    // The query uses expectedHash and the record's from/nonce.
    expect(port.observeCalls).toHaveLength(1);
    expect(port.observeCalls[0]).toMatchObject({
      txHash: TX_HASH,
      from: FROM,
      nonce: '42',
    });
    // Broadcast exactly once: never auto-resend after a timeout.
    expect(port.broadcastCalls).toHaveLength(1);
  });

  it('timeout but the query finds it in the mempool → resolve to pending', async () => {
    const { record, error } = await run({
      broadcastError: TIMEOUT(),
      observation: { kind: 'pending', txHash: TX_HASH },
    });
    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(record.status).toBe('pending');
  });

  it('timeout but the query finds it on-chain → resolve to included and persist the block height/hash anchor', async () => {
    const blockRef: BlockRef = { kind: 'number', number: dec('18000000') };
    const { record } = await run({
      broadcastError: TIMEOUT(),
      observation: {
        kind: 'included',
        txHash: TX_HASH,
        blockRef,
        canonicalBlockHash: '0x' + '12'.repeat(32),
      },
    });
    expect(record.status).toBe('included');
    expect(record.txHash).toBe(TX_HASH);
    expect(record.blockRef).toEqual(blockRef);
    expect(record.canonicalBlockHash).toBe('0x' + '12'.repeat(32));
  });

  it('timeout with the nonce already consumed by someone else → resolve to replaced (terminal state)', async () => {
    const { record } = await run({
      broadcastError: TIMEOUT(),
      observation: { kind: 'replaced', nonce: dec('42'), byTxHash: OTHER_HASH },
    });
    expect(record.status).toBe('replaced');
  });

  it('when the query itself fails, stay unknown; do not let a query failure change the classification', async () => {
    const { record, error } = await run({
      broadcastError: TIMEOUT(),
      observeError: createDfrError('DFR_PROVIDER_UNAVAILABLE', {
        requestId: REQUEST_ID,
        message: 'Query unavailable',
        chain: CHAIN,
      }),
    });
    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(record.status).toBe('unknown');
  });

  it('deployment without observe wired up → stop at unknown (pretend neither dropped nor failed)', async () => {
    const { record, error } = await run({ broadcastError: TIMEOUT(), withoutObserve: true });
    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(record.status).toBe('unknown');
  });

  it('TX-02: peer may reject signed hash but another peer already included it; never terminal-fail', async () => {
    const { record, port, stores, error } = await run({
      broadcastError: createDfrError('DFR_INSUFFICIENT_FUNDS', {
        requestId: REQUEST_ID,
        message: 'Insufficient balance',
        chain: CHAIN,
      }),
      observation: { kind: 'included', txHash: TX_HASH },
    });
    expect(isDfrError(error) && error.code).toBe('DFR_INSUFFICIENT_FUNDS');
    expect(record.status).toBe('included');
    expect(record.expectedHash).toBe(TX_HASH);
    expect(record.txHash).toBe(TX_HASH);
    expect(port.observeCalls).toHaveLength(1);
    expect(port.broadcastCalls).toHaveLength(1);
    expect(stores.transitionCalls.map((t) => t.reason)).toEqual([
      'sign', 'broadcast.indeterminate', 'included',
    ]);
  });

  it.each(['DFR_TRANSACTION_REJECTED', 'DFR_VALIDATION_FAILED', 'DFR_INSUFFICIENT_FUNDS'] as const)(
    'TX-02: signed %s error with absent chain read remains unknown and retains expectedHash',
    async (code) => {
      const { record, error, port } = await run({
        broadcastError: createDfrError(code, {
          requestId: REQUEST_ID,
          message: 'peer rejected',
          chain: CHAIN,
        }),
        observation: { kind: 'absent' },
      });
      expect(isDfrError(error) && error.code).toBe(code);
      expect(record.status).toBe('unknown');
      expect(record.expectedHash).toBe(TX_HASH);
      expect(port.observeCalls).toHaveLength(1);
      expect(port.broadcastCalls).toHaveLength(1);
    },
  );

  it('TX-02: generic EVM record may not use a forged Solana blockhash-expired error to terminal-fail', async () => {
    const { record, port } = await run({
      broadcastError: createDfrError('DFR_BLOCKHASH_EXPIRED', {
        requestId: REQUEST_ID,
        message: 'invalid exception on EVM',
        chain: CHAIN,
      }),
      observation: { kind: 'absent' },
    });
    expect(record.status).toBe('unknown');
    expect(record.expectedHash).toBe(TX_HASH);
    expect(port.observeCalls).toHaveLength(1);
  });

  it('nonce too low (DFR_NONCE_CONFLICT) takes the indeterminate path; it is not judged failed directly', async () => {
    const { record, port } = await run({
      broadcastError: createDfrError('DFR_NONCE_CONFLICT', {
        requestId: REQUEST_ID,
        message: 'nonce conflict',
        chain: CHAIN,
      }),
      observation: { kind: 'replaced', nonce: dec('42') },
    });
    expect(record.status).toBe('replaced');
    expect(port.observeCalls).toHaveLength(1);
  });

  it('unknown is not terminal: later observations can keep resolving it (the premise of the D03 recovery scan)', async () => {
    const first = await run({ broadcastError: TIMEOUT() });
    expect(first.record.status).toBe('unknown');
    expect(first.stores.transitionCalls.some((c) => c.toStatus === 'pending')).toBe(false);

    // When the same record is "observed again" (simulating a recovery scan), it can still advance along unknown → included.
    const engine = makeEngine(
      new FakeChainPort({
        observation: { kind: 'included', txHash: `0x${'aa'.repeat(32)}` },
      }),
      first.stores,
    );
    const resolved = await engine.resolveIndeterminate({
      transactionId: TX_ID,
      requestId: REQUEST_ID,
    });
    expect(resolved?.status).toBe('included');
  });

  it('re-observation on the recovery path finds absent and the timeout has passed → dropped (ADR-023 fills this trigger-less edge)', async () => {
    const first = await run({ broadcastError: TIMEOUT() });
    expect(first.record.status).toBe('unknown');

    // The default observation is absent; with no `dropClock` injected the real clock is used, while the record's updatedAt is fixed
    // test time → the silence far exceeds dropTimeoutMs, so it should be judged dropped.
    const engine = makeEngine(new FakeChainPort({}), first.stores);
    const resolved = await engine.resolveIndeterminate({
      transactionId: TX_ID,
      requestId: REQUEST_ID,
    });
    expect(resolved?.status).toBe('dropped');
  });

  it('an absent observation inside the same broadcast request never judges dropped (the ADR-019 line-142 constraint must not be broken by ADR-023)', async () => {
    // This is the constraint most easily broken by "adding timeout handling on the side": mempool propagation is asynchronous,
    // and not finding it right now inside the request does not mean it is dropped.
    const { record } = await run({ broadcastError: TIMEOUT(), observation: { kind: 'absent' } });
    expect(record.status).toBe('unknown');
  });

  it('TX-02: broadcast RPC timeout is preserved if DB cannot persist indeterminate state', async () => {
    const stores = new FakeTransactionStore();
    stores.seed('simulated');
    stores.failOnTransitionReason = 'broadcast.indeterminate';
    const port = new FakeChainPort({ broadcastError: TIMEOUT() });
    const engine = makeEngine(port, stores);

    const error = await engine.broadcast({
      transactionId: TX_ID, signed: SIGNED, requestId: REQUEST_ID,
    }).then(() => undefined, (failure: unknown) => failure);
    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_TIMEOUT');
    expect(stores.records.get(TX_ID)).toMatchObject({
      status: 'signed', expectedHash: TX_HASH,
    });
    expect(port.broadcastCalls).toHaveLength(1);
  });

  it('the success path is unaffected (regression): accepted → broadcast, with no observation query', async () => {
    const { record, port } = await run({});
    expect(record.status).toBe('broadcast');
    expect(port.observeCalls).toHaveLength(0);
  });
});
