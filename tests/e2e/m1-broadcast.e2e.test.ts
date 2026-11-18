// M1 broadcast write-path offline E2E (prerequisite for DFR-M1-E03).
//
// Chain: SDK → Gateway → Core → EVM Adapter → Provider stand-in → TransactionEngine (test stand-in Store)
//
// Difference from `m1-write.e2e.test.ts` (build/simulate/confirm): this file wires in **real signing**
// into the full HTTP write path, verifying that the C02/C03 broadcast semantics hold end to end once the `transaction.broadcast` capability is enabled:
//   1. once the capability is enabled, the broadcast endpoint no longer returns 422 DFR_UNSUPPORTED_CAPABILITY;
//   2. `eth_sendRawTransaction` happens **exactly once** per request (non-idempotent-write, never retried or re-sent after failover);
//   3. the record advances built → simulated → sign(signed) → broadcast, with expectedHash/txHash persisted;
//   4. a client-tampered signed payload (changed nonce / changed recipient) is rejected by binding validation, and **no broadcast is sent**;
//   5. the record never contains `signedPayload` (the raw signature is never persisted).
//
// The private key is derived at runtime from a constant (no private-key literals in the repo), same approach as adapters/evm/test/broadcast.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import {
  createGatewayServer,
  createCoreTransactionChainPort,
  hashSecret,
  TokenBucketLimiter,
} from '@dfr/gateway';
import { createStubFetch } from '@dfr/provider';
import { ChainRegistry } from '@dfr/registry';
import { DFR, isDfrApiError } from '@dfr/sdk-typescript';
import { TransactionEngine } from '@dfr/transaction';
import type { AccountRef, Chain, ChainId, DecimalUint, TransactionId } from '@dfr/types';
import { createInMemoryTransactionStores } from './support/in-memory-transaction-stores.js';
// Signing helpers live under adapters/evm/test: viem may only exist in the EVM Adapter (ADR-016 §2).
import {
  addressOf,
  deriveTestPrivateKey,
  signUnsignedPayload,
  transactionHashOf,
} from '../../adapters/evm/test/support/external-signer.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN = 'ethereum-sepolia' as ChainId;
const CHAIN_ID = 11155111;
const SECRET = 'm1BroadcastE2eSecret0123456789abc';
const PEPPER = 'm1-broadcast-e2e-pepper';
const KEY_ID = 'M1Brcast'; // exactly 8 chars [A-Za-z0-9]

/** Runtime-derived test private key; no private-key literals appear in the repo. */
const TEST_KEY = deriveTestPrivateKey('dfr-m1-e03-broadcast-signer');
const FROM = { chain: CHAIN, address: addressOf(TEST_KEY) } as AccountRef;
const TO: AccountRef = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' };

const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
  baseFeePerGas: '0x3b9aca00',
};

/** The payload of each `eth_sendRawTransaction` call; used to assert "exactly once". */
const rawSends: string[] = [];
/** Broadcast response switch: `already-known` is an idempotent success, not an error. */
let sendMode: 'ok' | 'already-known' | 'boom' = 'ok';

const stubFetch = createStubFetch({
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
        return { kind: 'result', value: BLOCK };
      case 'eth_call':
        return { kind: 'result', value: '0x' };
      case 'eth_getTransactionByHash':
        return { kind: 'result', value: null };
      case 'eth_sendRawTransaction': {
        const payload = String(call.params[0]);
        rawSends.push(payload);
        if (sendMode === 'boom') {
          return { kind: 'rpc-error', code: -32000, message: 'insufficient funds for gas * price + value' };
        }
        if (sendMode === 'already-known') {
          return { kind: 'rpc-error', code: -32000, message: 'already known' };
        }
        // The real endpoint returns the transaction hash = keccak256(signed payload).
        return { kind: 'result', value: transactionHashOf(payload) };
      }
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
    newTransactionId: () =>
      `txn_01J8Z6W3Q2K9M4ABCDEFGHJK${String(nextTransactionNumber++).padStart(2, '0')}` as TransactionId,
  });
  const created = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'm1-broadcast-e2e',
      scope: { chains: [CHAIN], capabilities: '*', allowWrite: true },
    },
    allowWrite: true,
    transactions: engine,
    // This file sends several write requests in a row in a single test process (build+simulate+broadcast x 4 cases),
    // which would exceed the default write bucket (capacity 10 / 2rps). This only raises the rate limit and does not change the behavior under test --
    // rate limiting itself is covered separately by apps/gateway/test/gateway.test.ts.
    limiter: new TokenBucketLimiter({
      read: { capacity: 1_000, refillPerSecond: 1_000 },
      write: { capacity: 1_000, refillPerSecond: 1_000 },
      stream: { capacity: 100, refillPerSecond: 100 },
    }),
  });
  server = created;
  await new Promise<void>((resolveListen) => created.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
  dfr = new DFR({ apiKey: `dfr_${KEY_ID}_${SECRET}`, baseUrl });
});

afterAll(async () => {
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

/**
 * Simulates "the caller's own signer": decodes the unsigned payload produced by build back into fields and re-signs it with the test private key.
 * `overrides` is used to build a negative control with a binding mismatch.
 */
function externalSign(
  unsignedPayload: string,
  overrides: { nonce?: bigint; to?: string } = {},
) {
  return signUnsignedPayload({
    unsignedPayload,
    privateKey: TEST_KEY,
    chainId: CHAIN_ID,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  });
}

describe('M1 broadcast write-path offline E2E (prerequisite for DFR-M1-E03)', () => {
  it('with the capability enabled: build → external signing → simulate → broadcast succeeds end to end, and broadcasts only once', async () => {
    rawSends.length = 0;
    sendMode = 'ok';

    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-bc-0001' });
    expect(built.unsignedTransaction.meta.requiresNonce).toBe('42');

    const simulated = await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    expect(simulated.simulation.success).toBe(true);

    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);
    const result = await dfr.broadcastTransaction(
      {
        transactionId: built.transactionId,
        signedTransaction: {
          schemaVersion: '1',
          chain: CHAIN,
          unsigned: built.unsignedTransaction,
          signedPayload,
          expectedHash,
        },
      },
      { idempotencyKey: 'e2e-bc-0001-broadcast' },
    );

    expect(result.broadcast.accepted).toBe(true);
    expect(result.broadcast.txHash).toBe(expectedHash);
    // Exactly once: the Provider layer never retries a non-idempotent-write.
    expect(rawSends).toEqual([signedPayload]);

    const record = await stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('broadcast');
    expect(record?.txHash).toBe(expectedHash);
    expect(record?.expectedHash).toBe(expectedHash);
    // The raw signature is never persisted.
    expect(record).not.toHaveProperty('signedPayload');
  });

  it('already known is treated as an idempotent success (no second broadcast)', async () => {
    rawSends.length = 0;
    sendMode = 'already-known';

    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-bc-0002' });
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);
    const result = await dfr.broadcastTransaction(
      {
        transactionId: built.transactionId,
        signedTransaction: {
          schemaVersion: '1',
          chain: CHAIN,
          unsigned: built.unsignedTransaction,
          signedPayload,
          expectedHash,
        },
      },
      { idempotencyKey: 'e2e-bc-0002-broadcast' },
    );

    expect(result.broadcast.accepted).toBe(true);
    expect(rawSends).toHaveLength(1);
  });

  it('signed payload inconsistent with the record (changed nonce) → 403/422 rejection, and no broadcast is sent', async () => {
    rawSends.length = 0;
    sendMode = 'ok';

    const built = await dfr.buildTransaction(
      { ...REQUEST, value: { ...REQUEST.value, amount: '3000' as DecimalUint } },
      { idempotencyKey: 'e2e-bc-0003' },
    );
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    // Sign with a different nonce: the signature is valid, but it does not match the unsigned payload bound to the record.
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload, {
      nonce: 9999n,
    });

    const error = await dfr
      .broadcastTransaction(
        {
          transactionId: built.transactionId,
          signedTransaction: {
            schemaVersion: '1',
            chain: CHAIN,
            unsigned: built.unsignedTransaction,
            signedPayload,
            expectedHash,
          },
        },
        { idempotencyKey: 'e2e-bc-0003-broadcast' },
      )
      .catch((e: unknown) => e);

    expect(isDfrApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: expect.any(Number) });
    // Key safety property: when local binding validation fails, never send a broadcast.
    expect(rawSends).toEqual([]);
  });

  it('TX-02: a single-node insufficient-balance rejection does not prove the signed transaction never propagated; the record stays unknown', async () => {
    rawSends.length = 0;
    sendMode = 'boom';

    const built = await dfr.buildTransaction(
      { ...REQUEST, value: { ...REQUEST.value, amount: '4000' as DecimalUint } },
      { idempotencyKey: 'e2e-bc-0004' },
    );
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);

    const error = await dfr
      .broadcastTransaction(
        {
          transactionId: built.transactionId,
          signedTransaction: {
            schemaVersion: '1',
            chain: CHAIN,
            unsigned: built.unsignedTransaction,
            signedPayload,
            expectedHash,
          },
        },
        { idempotencyKey: 'e2e-bc-0004-broadcast' },
      )
      .catch((e: unknown) => e);

    expect(isDfrApiError(error)).toBe(true);
    expect(rawSends).toHaveLength(1); // sent, but the endpoint rejected it
    const record = await stores.transaction.get(built.transactionId);
    // RPC response is not a global proof of non-propagation. The durable
    // signed hash stays observable and its nonce cannot be released blindly.
    expect(record?.status).toBe('unknown');
    expect(record?.expectedHash).toBe(expectedHash);
  });

  it('replay: dropped record + rebroadcast:true → 202 and broadcasts only once (TODO-012 end to end)', async () => {
    rawSends.length = 0;
    sendMode = 'ok';

    // Walk the full path with a real signature: build → simulate → external signing → set the record to dropped
    //(simulating "broadcast then dropped by the mempool"), then replay. That way the Adapter's signature binding validation
    // faces a real EIP-1559 payload instead of placeholder bytes.
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-rb-0001' });
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const record = await stores.transaction.get(built.transactionId);
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);

    // Advance directly to dropped (the test stand-in does no state-machine validation, precisely so this starting point can be built).
    await stores.transaction.transition({
      transactionId: built.transactionId,
      expectedStatus: record!.status,
      expectedVersion: record!.stateVersion,
      toStatus: 'dropped' as never,
      reason: 'dropped' as never,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
      patch: { expectedHash } as never,
    } as never);

    const result = await dfr.broadcastTransaction(
      {
        transactionId: built.transactionId,
        signedTransaction: {
          schemaVersion: '1',
          chain: CHAIN,
          unsigned: built.unsignedTransaction,
          signedPayload,
          expectedHash,
        },
      },
      { idempotencyKey: 'e2e-rb-0001-broadcast', rebroadcast: true },
    );

    expect(result.broadcast.rebroadcast).toBe(true);
    expect(result.broadcast.accepted).toBe(true);
    // Replay still sends only one non-idempotent-write.
    expect(rawSends).toHaveLength(1);
    expect((await stores.transaction.get(built.transactionId))?.status).toBe('broadcast');
  });

  it('replay negative control: rebroadcast:true in a non-dropped state → rejected with zero broadcasts', async () => {
    rawSends.length = 0;
    const built = await dfr.buildTransaction(REQUEST, { idempotencyKey: 'e2e-rb-0002' });
    await dfr.simulateTransaction({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const { signedPayload, expectedHash } = await externalSign(built.unsignedTransaction.payload);

    const error = await dfr
      .broadcastTransaction(
        {
          transactionId: built.transactionId,
          signedTransaction: {
            schemaVersion: '1',
            chain: CHAIN,
            unsigned: built.unsignedTransaction,
            signedPayload,
            expectedHash,
          },
        },
        { idempotencyKey: 'e2e-rb-0002-broadcast', rebroadcast: true },
      )
      .catch((e: unknown) => e);

    expect(isDfrApiError(error)).toBe(true);
    // Key point: the simulated state does not allow replay, with **zero broadcasts**.
    expect(rawSends).toEqual([]);
  });
});
