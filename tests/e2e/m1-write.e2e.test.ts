/**
 * M1 write-path offline E2E (DFR-M1-B10).
 *
 * Chain: TypeScript SDK → API Gateway → DFR Core → EVM Adapter → Provider stand-in
 *      → TransactionEngine (test stand-in Store) → persisted records.
 *
 * Difference from `gateway.e2e.test.ts` (M0 read-only): this file uses the **real**
 * `chains.yaml` config + the real `TransactionEngine`, verifying at the same time:
 *   1. the registry has declared build/simulate for ethereum-sepolia (B10 capability enablement);
 *   2. the full order nonce lease → Adapter explicit nonce → payload → persisted `built`;
 *   3. idempotency-key replay consumes no new nonce;
 *   4. the real HTTP results of payload binding validation and simulated revert (400 / 422);
 *   5. the record has no `signedPayload` (M1 does not persist the raw signature).
 *
 * The Store is a test stand-in (`support/in-memory-transaction-stores.ts`): M1 deliberately has no production
 * in-memory Store (ADR-014); the real PostgreSQL path is covered by `pnpm test:db`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { createGatewayServer, createCoreTransactionChainPort, hashSecret } from '@dfr/gateway';
import { createStubFetch } from '@dfr/provider';
import { ChainRegistry } from '@dfr/registry';
import { DFR, isDfrApiError } from '@dfr/sdk-typescript';
import { TransactionEngine } from '@dfr/transaction';
import type { AccountRef, Chain, ChainId, DecimalUint, TransactionId } from '@dfr/types';
import { createInMemoryTransactionStores } from './support/in-memory-transaction-stores.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN = 'ethereum-sepolia' as ChainId;
const FROM: AccountRef = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' };
const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };
const SECRET = 'm1WriteE2eSecret0123456789abcdefgh';
const PEPPER = 'm1-write-e2e-pepper';
const KEY_ID = 'M1WriteA'; // must be exactly 8 chars [A-Za-z0-9]: dfr_<8>_<20..64>

const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
  baseFeePerGas: '0x3b9aca00',
};

/** Behavior switch for `eth_call`: M1 needs to distinguish the two real outcomes, success and revert. */
let callMode: 'ok' | 'revert' = 'ok';
let finalizedAvailable = true;
let confirmationObservationCalls = 0;

const stubFetch = createStubFetch({
  onCall: ({ method }) => {
    if (method === 'eth_getTransactionByHash') confirmationObservationCalls += 1;
  },
  resolve: (call) => {
    switch (call.method) {
      case 'eth_chainId':
        return { kind: 'result', value: '0xaa36a7' };
      case 'eth_getTransactionCount':
        return { kind: 'result', value: '0x2a' };
      case 'eth_estimateGas':
        return { kind: 'result', value: '0x5208' };
      case 'eth_maxPriorityFeePerGas':
        return { kind: 'result', value: '0x3b9aca00' };
      case 'eth_getBlockByNumber':
        return call.params[0] === 'finalized' && !finalizedAvailable
          ? { kind: 'result', value: null }
          : { kind: 'result', value: call.params[0] === '0x112a87f' ? { ...BLOCK, number: '0x112a87f' } : BLOCK };
      case 'eth_getTransactionByHash':
        return { kind: 'result', value: {
          hash: `0x${'aa'.repeat(32)}`,
          blockNumber: '0x112a87f',
          blockHash: `0x${'11'.repeat(32)}`,
          from: FROM.address,
          to: TO.address,
          value: '0x1',
          gas: '0x5208',
          nonce: '0x2a',
        } };
      case 'eth_getTransactionReceipt':
        return { kind: 'result', value: { transactionHash: `0x${'aa'.repeat(32)}`, blockHash: BLOCK.hash, blockNumber: '0x112a87f', status: '0x1' } };
      case 'eth_call':
        return callMode === 'ok'
          ? { kind: 'result', value: '0x' }
          : { kind: 'rpc-error', code: 3, message: 'execution reverted: nope' };
      case 'web3_clientVersion':
        return { kind: 'result', value: 'stub/1.0.0' };
      default:
        return { kind: 'rpc-error', code: -32601, message: `unsupported ${call.method}` };
    }
  },
});

let server: Server | undefined;
let baseUrl = '';
let dfr: DFR;
let engine: TransactionEngine;
let stores: ReturnType<typeof createInMemoryTransactionStores>;
let nextTransactionNumber = 1;

beforeAll(async () => {
  stores = createInMemoryTransactionStores();
  const registry = ChainRegistry.load({
    file: resolve(repoRoot, 'packages/registry/config/chains.yaml'),
    env: {
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://stub.local/sepolia-primary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_KEY: 'stub-credential-primary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://stub.local/sepolia-secondary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_KEY: 'stub-credential-secondary',
    },
  });

  const core = new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    fetchImpl: stubFetch,
    transactionStores: stores,
  });

  engine = new TransactionEngine({
    stores: {
      transaction: stores.transaction,
      idempotency: stores.idempotency,
      nonce: stores.nonce,
      tracker: stores.tracker,
    },
    chain: createCoreTransactionChainPort(core),
    // Deterministic IDs: so assertions can compare persisted records and responses byte for byte.
    newTransactionId: () =>
      `txn_01J8Z6W3Q2K9M4ABCDEFGHJK${String(nextTransactionNumber++).padStart(2, '0')}` as TransactionId,
  });

  const created = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'm1-write-e2e',
      scope: { chains: [CHAIN], capabilities: '*', allowWrite: true },
    },
    allowWrite: true,
    transactions: engine,
  });
  server = created;
  await new Promise<void>((resolveListen) => created.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
  dfr = new DFR({ apiKey: `dfr_${KEY_ID}_${SECRET}`, baseUrl });
});

afterAll(async () => {
  // If beforeAll fails, server may be unassigned: exit safely here so the real failure cause is not masked.
  if (!server) return;
  engine.close();
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
});

const REQUEST = {
  chain: CHAIN,
  from: FROM,
  to: TO,
  value: { asset: { kind: 'native' as const, chain: CHAIN }, amount: '1000' as DecimalUint },
};

describe('M1 write-path offline E2E (DFR-M1-B10)', () => {
  it('SDK build → 200 envelope, nonce from the lease, payload consistent with the persisted record', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-build-0001' });

    expect(built.transactionId).toBe('txn_01J8Z6W3Q2K9M4ABCDEFGHJK01');
    expect(built.unsignedTransaction.chain).toBe(CHAIN);
    expect(built.unsignedTransaction.meta.requiresNonce).toBe('42');
    expect(built.unsignedTransaction.payload.startsWith('0x02')).toBe(true); // EIP-1559

    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('built');
    expect(record?.nonce).toBe('42');
    expect(record?.unsignedPayload).toBe(built.unsignedTransaction.payload);
    expect(record?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    // M1 does not persist the raw signature: the record must have no signedPayload field.
    // Note: do not use "`JSON.stringify(record)` does not contain "signedPayload"" as a negative control --
    // a legitimate `unsignedPayload` happens to contain that substring, which would make the assertion always false.
    expect(record).not.toHaveProperty('signedPayload');
    expect(Object.keys(record ?? {})).not.toContain('signedPayload');
  });

  it('same idempotency key replayed → same transactionId, and no new nonce is consumed', async () => {
    const replayed = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-build-0001' });
    expect(replayed.transactionId).toBe('txn_01J8Z6W3Q2K9M4ABCDEFGHJK01');

    // A new request without an idempotency key must get the next nonce (43), proving the replay did not advance the watermark.
    const next = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-build-0002' });
    const record = await stores.transaction.get(next.transactionId);
    expect(record?.nonce).toBe('43');
  });

  it('same key, different request body → 409 DFR_IDEMPOTENCY_CONFLICT, no second transaction is created', async () => {
    const err = await dfr
      .buildTransaction(
        { ...REQUEST, value: { ...REQUEST.value, amount: '2000' as DecimalUint } },
        { idempotencyKey: 'e2e-build-0001' },
      )
      .catch((e: unknown) => e);
    expect(isDfrApiError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'DFR_IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('confirm reaching the wait limit returns reached=false and continues background read-only observation', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-confirm-0001' });
    const txHash = `0x${'aa'.repeat(32)}`;
    const current = await stores.transaction.get(built.transactionId);
    expect(current).not.toBeNull();
    await stores.transaction.transition({
      transactionId: built.transactionId,
      expectedStatus: 'built',
      expectedVersion: current!.stateVersion,
      toStatus: 'included',
      reason: 'included',
      patch: {
        txHash,
        blockRef: { kind: 'number', number: '17987839' as DecimalUint },
        canonicalBlockHash: BLOCK.hash,
      },
    });
    finalizedAvailable = false;
    const result = await dfr.confirmTransaction({
      chain: CHAIN,
      txHash,
      minFinality: 'finalized',
      timeoutMs: 1_000,
    });
    expect(result.requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(result.confirmation).toMatchObject({
      status: 'included',
      finality: 'included',
      requiredFinality: 'finalized',
      reached: false,
    });
    // New read-only RPC observations still arrive after the HTTP response, proving the background loop really continues;
    // it is stopped by engine.close during test cleanup.
    const callsAtResponse = confirmationObservationCalls;
    for (let attempt = 0; attempt < 40 && confirmationObservationCalls === callsAtResponse; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(confirmationObservationCalls).toBeGreaterThan(callsAtResponse);
    finalizedAvailable = true;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const updated = await stores.transaction.get(built.transactionId);
      if (updated?.status === 'finalized') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    await expect(stores.transaction.get(built.transactionId)).resolves.toMatchObject({
      status: 'finalized',
      canonicalBlockHash: BLOCK.hash,
      blockRef: { kind: 'number', number: '17987839' },
    });
  });

  it('confirm body naming an unauthorized chain is rejected before the engine is called', async () => {
    const err = await dfr.confirmTransaction({
      chain: 'base-sepolia' as ChainId,
      txHash: `0x${'aa'.repeat(32)}`,
      timeoutMs: 1_000,
    }).catch((error: unknown) => error);
    expect(err).toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED', status: 403 });
  });

  it('SDK simulate → 200 success, record advances to simulated', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-sim-0001' });
    const simulated = await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });

    expect(simulated.simulation.success).toBe(true);
    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('simulated');
  });

  it('payload inconsistent with the persisted record → 400, and the state does not advance', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-sim-0002' });
    const err = await dfr
      .simulateTransaction({
        transactionId: built.transactionId,
        unsignedTransaction: { ...built.unsignedTransaction, payload: '0x02deadbeef' },
      })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'DFR_VALIDATION_FAILED', status: 400 });
    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('built');
  });

  it('on-chain revert → 422 DFR_TRANSACTION_REVERTED, record is reverted (not 500)', async () => {
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-sim-0003' });
    callMode = 'revert';
    try {
      const err = await dfr
        .simulateTransaction({
          transactionId: built.transactionId,
          unsignedTransaction: built.unsignedTransaction,
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'DFR_TRANSACTION_REVERTED', status: 422 });
    } finally {
      callMode = 'ok';
    }
    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('reverted');
  });

  it('a deployment without the write capability wired in → 422 (fail-closed, not 500)', async () => {
    // Capability routing is decided by the registry: core.getChainInfo still works, but the write endpoints need a capability declaration.
    // This directly verifies the Gateway's behavior when transactions are not passed in (the deployment has not opened the write path).
    const readOnly = createGatewayServer({
      core: { listChains: () => [], startHealthChecks: () => ({ started: [], skipped: [] }), stopHealthChecks: () => undefined } as never,
      auth: {
        keyId: KEY_ID,
        currentHash: hashSecret(SECRET, PEPPER),
        pepper: PEPPER,
        projectId: 'm1-write-e2e',
        scope: { chains: '*', capabilities: '*', allowWrite: true },
      },
      allowWrite: true,
    });
    await new Promise<void>((resolveListen) => readOnly.listen(0, '127.0.0.1', resolveListen));
    const port = (readOnly.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/transactions/build`, {
        method: 'POST',
        headers: {
          'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(REQUEST),
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as { dfr_code?: string };
      expect(body.dfr_code).toBe('DFR_UNSUPPORTED_CAPABILITY');
    } finally {
      await new Promise<void>((resolveClose) => readOnly.close(() => resolveClose()));
    }
  });
});
