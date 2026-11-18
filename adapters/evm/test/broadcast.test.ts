/**
 * EVM Adapter broadcast (DFR-M1-C02).
 *
 * Authoritative sources: m1-api-contract.md Sections 3/5, transaction-lifecycle.md §4.4,
 * error-spec §5.1, ADR-016.
 *
 * This file focuses on **fund safety**, not feature coverage:
 *   1. `eth_sendRawTransaction` must be tagged `non-idempotent-write`, so the Provider layer never retries it automatically;
 *   2. One broadcast call means **exactly one** transport call; failures never switch Provider and resend;
 *   3. `already known` / `already exists` are idempotent successes, not errors;
 *   4. Other failures are rethrown as-is (C03 decides the state rollback), never faked as accepted;
 *   5. When local validation fails (unsigned / chain mismatch / expectedHash mismatch / abnormal hash returned by the endpoint),
 *      **no broadcast must be sent**.
 *
 * Real signatures use viem pure functions + test private keys derived at runtime (no private-key literals in the repo).
 */
import { describe, expect, it } from 'vitest';
import { keccak256, serializeTransaction, toBytes, toRlp } from 'viem';
import { privateKeyToAddress, signTransaction } from 'viem/accounts';
import { EvmAdapter } from '@dfr/adapter-evm';
import { createDfrError, isDfrError } from '@dfr/errors';
import type {
  AdapterContext,
  Chain,
  ChainId,
  ProviderCall,
  ProviderContext,
  ProviderHandle,
  ProviderRouter,
  SignedTransaction,
  UnsignedTransaction,
} from '@dfr/types';

const SEPOLIA = 'ethereum-sepolia' as ChainId;
const OTHER_CHAIN = 'base-sepolia' as ChainId;
const CHAIN_ID = 11155111;
const TO = '0x2222222222222222222222222222222222222222' as const;
const VALUE = 1000n;

const chain: Chain = {
  id: SEPOLIA,
  displayName: 'Ethereum Sepolia',
  family: 'evm',
  network: 'testnet',
  externalChainId: '11155111',
  adapter: { id: 'evm', version: '^0.1.0' },
  finality: { kind: 'checkpoint', finalizedTag: true },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.broadcast'],
};

/** Derived at runtime: no private-key literals appear in the repo. */
const TEST_KEY = keccak256(toBytes('dfr-m1-c02-signer'));

interface Recorded {
  method: string;
  idempotency: string;
  params: readonly unknown[];
}

interface StubRouterOptions {
  /** Response to eth_sendRawTransaction; the default success returns the real hash. */
  send?: (recorded: Recorded) => unknown;
  onSend?: (recorded: Recorded) => void;
  /** Response to eth_getTransactionByHash (observation path). */
  observe?: () => unknown;
  /** Response to eth_getTransactionCount (the observation path uses it to tell replaced from absent). */
  latestNonce?: () => unknown;
}

/** Record all calls, and allow custom responses to be injected for broadcast (success / JSON-RPC error / network error). */
function createStubRouter(
  options: StubRouterOptions = {},
): { router: ProviderRouter; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const handle: ProviderHandle = {
    id: 'stub-primary' as never,
    chain: SEPOLIA,
    async request<T>(call: ProviderCall, _ctx: ProviderContext): Promise<T> {
      const recorded: Recorded = {
        method: call.method,
        idempotency: call.idempotency,
        params: call.params,
      };
      calls.push(recorded);
      if (call.method === 'eth_chainId') return '0xaa36a7' as T;
      if (call.method === 'eth_getTransactionByHash') {
        if (options.observe !== undefined) return options.observe() as T;
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'stub has no observation response configured',
          chain: SEPOLIA,
        });
      }
      if (call.method === 'eth_getTransactionCount') {
        if (options.latestNonce !== undefined) return options.latestNonce() as T;
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'stub has no nonce response configured',
          chain: SEPOLIA,
        });
      }
      if (call.method === 'eth_sendRawTransaction') {
        options.onSend?.(recorded);
        if (options.send !== undefined) return options.send(recorded) as T;
        // A real endpoint returns the transaction hash = keccak256(signed payload).
        return keccak256(call.params[0] as `0x${string}`) as T;
      }
      throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
        requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
        message: `stub does not implement method ${call.method}`,
        chain: SEPOLIA,
      });
    },
  };
  return {
    router: {
      chain: SEPOLIA,
      async acquire(): Promise<ProviderHandle> {
        return handle;
      },
    },
    calls,
  };
}

function context(router: ProviderRouter): AdapterContext {
  return {
    chain: SEPOLIA,
    network: 'testnet',
    providers: router,
    signal: new AbortController().signal,
    requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  };
}

function unsignedStub(payload: string, chainId = SEPOLIA): UnsignedTransaction {
  return {
    schemaVersion: '1',
    chain: chainId,
    payload,
    meta: { encoding: 'hex', requiresNonce: '1' as never },
  };
}

/** Build a really signed transaction and return the SignedTransaction the Adapter needs. */
async function makeSigned(
  overrides: Partial<{ value: bigint; nonce: number; data: `0x${string}` }> = {},
  chainId = CHAIN_ID,
): Promise<SignedTransaction> {
  const signedPayload = await signTransaction({
    privateKey: TEST_KEY,
    transaction: {
      chainId,
      nonce: overrides.nonce ?? 1,
      to: TO,
      value: overrides.value ?? VALUE,
      data: overrides.data ?? '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    },
  });
  return {
    schemaVersion: '1',
    chain: SEPOLIA,
    unsigned: unsignedStub('0x02placeholder', SEPOLIA),
    signedPayload,
    expectedHash: keccak256(signedPayload as `0x${string}`),
    signerRef: 'external:test',
  };
}

describe('EVM Adapter broadcast (DFR-M1-C02)', () => {
  const adapter = new EvmAdapter({ chain });

  it('exactly one eth_sendRawTransaction, tagged non-idempotent-write', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();

    const result = await adapter.broadcast(context(router), signed);

    const sends = calls.filter((c) => c.method === 'eth_sendRawTransaction');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.idempotency).toBe('non-idempotent-write');
    expect(sends[0]?.params).toEqual([signed.signedPayload]);
    expect(result.accepted).toBe(true);
    expect(result.status).toBe('broadcast');
    expect(result.ref).toEqual({ kind: 'hash', hash: signed.expectedHash });
    expect(result.providerId).toBe('stub-primary');
    expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('sends no probe calls other than chainId (avoids extra round trips)', async () => {
    const { router, calls } = createStubRouter();
    await adapter.broadcast(context(router), await makeSigned());
    expect(calls.map((c) => c.method)).toEqual(['eth_sendRawTransaction']);
  });

  it('chainId in the signed payload differs from the bound chain → DFR_CHAIN_MISMATCH, no broadcast sent', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned({}, 84532); // Base Sepolia

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_CHAIN_MISMATCH');
    expect(calls).toEqual([]);
  });

  it('SignedTransaction.chain differs from the Adapter bound chain → DFR_CHAIN_MISMATCH, no broadcast sent', async () => {
    const { router, calls } = createStubRouter();
    const signed = { ...(await makeSigned()), chain: OTHER_CHAIN };

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_CHAIN_MISMATCH');
    expect(calls).toEqual([]);
  });

  it('expectedHash differs from the recomputed payload hash → DFR_TRANSACTION_REJECTED, no broadcast sent', async () => {
    const { router, calls } = createStubRouter();
    const signed = { ...(await makeSigned()), expectedHash: `0x${'ab'.repeat(32)}` };

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(isDfrError(error) && error.details?.['reason']).toBe('expected_hash_mismatch');
    expect(calls).toEqual([]);
  });

  it('structurally valid but unsigned payload → DFR_TRANSACTION_REJECTED(not_signed), no broadcast sent', async () => {
    const { router, calls } = createStubRouter();
    // A genuinely unsigned payload (not malformed RLP): only then must the rejection come from the not_signed branch,
    // rather than being incidentally blocked by a decode failure or the expectedHash branch.
    const unsignedPayload = serializeTransaction({
      chainId: CHAIN_ID,
      nonce: 1,
      to: TO,
      value: VALUE,
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    });
    const signed: SignedTransaction = {
      schemaVersion: '1',
      chain: SEPOLIA,
      unsigned: unsignedStub(unsignedPayload),
      signedPayload: unsignedPayload,
      // The hash is correct, so the only possible rejection reason is "unsigned".
      expectedHash: keccak256(unsignedPayload),
    };

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(isDfrError(error) && error.details?.['reason']).toBe('not_signed');
    expect(calls).toEqual([]);
  });

  it('the no-record-truth path must also reject signatures whose sender cannot be recovered', async () => {
    const { router, calls } = createStubRouter();
    const payload = `0x02${toRlp([
      '0xaa36a7', '0x01', '0x01', '0x02', '0x5208', TO, '0x', '0x', [],
      '0x', `0x${'ff'.repeat(32)}`, '0x01',
    ]).slice(2)}`;
    const signed: SignedTransaction = {
      schemaVersion: '1',
      chain: SEPOLIA,
      unsigned: unsignedStub(payload),
      signedPayload: payload,
      expectedHash: keccak256(payload as `0x${string}`),
    };
    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(calls).toEqual([]);
  });

  it('malformed payload → DFR_TRANSACTION_REJECTED(invalid_payload), no broadcast sent', async () => {
    const { router, calls } = createStubRouter();
    const signed: SignedTransaction = {
      schemaVersion: '1',
      chain: SEPOLIA,
      unsigned: unsignedStub('0x02f86b0180808080942222222222222222222222222222222222222280c0'),
      signedPayload: '0x02f86b0180808080942222222222222222222222222222222222222280c0',
      expectedHash: `0x${'ab'.repeat(32)}`,
    };

    const error = await adapter.broadcast(context(router), signed).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(isDfrError(error) && error.details?.['reason']).toBe('invalid_payload');
    expect(calls).toEqual([]);
  });

  it('"already known" is an idempotent success (accepted=true), not an error', async () => {
    const { router, calls } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Provider returned a JSON-RPC error',
          chain: SEPOLIA,
          chainError: { code: '-32000', message: 'already known' },
        });
      },
    });
    const signed = await makeSigned();

    const result = await adapter.broadcast(context(router), signed);

    expect(result.accepted).toBe(true);
    expect(result.ref).toEqual({ kind: 'hash', hash: signed.expectedHash });
    // An idempotent success is still a single call: no extra query or resend just because it "already exists".
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('"already exists" is likewise treated as an idempotent success', async () => {
    const { router } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Provider returned a JSON-RPC error',
          chain: SEPOLIA,
          chainError: { code: '-32000', message: 'Transaction already exists' },
        });
      },
    });
    const result = await adapter.broadcast(context(router), await makeSigned());
    expect(result.accepted).toBe(true);
  });

  it('other JSON-RPC failures are rethrown as-is, without resending (underpriced)', async () => {
    const { router, calls } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Provider returned a JSON-RPC error',
          chain: SEPOLIA,
          chainError: { code: '-32000', message: 'replacement transaction underpriced' },
        });
      },
    });

    const error = await adapter.broadcast(context(router), await makeSigned()).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_UNAVAILABLE');
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('nonce too low stays DFR_NONCE_CONFLICT (not swallowed as success, not resent)', async () => {
    const { router, calls } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_NONCE_CONFLICT', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'nonce conflict (eth_sendRawTransaction)',
          chain: SEPOLIA,
          chainError: { code: '-32000', message: 'nonce too low' },
        });
      },
    });

    const error = await adapter.broadcast(context(router), await makeSigned()).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_NONCE_CONFLICT');
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('retryable-class errors are not resent either (the non-idempotent-write classification is the reason not to resend)', async () => {
    const { router, calls } = createStubRouter({
      send: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Provider returned HTTP 503',
          chain: SEPOLIA,
          details: { status: 503, method: 'eth_sendRawTransaction' },
        });
      },
    });

    const error = await adapter.broadcast(context(router), await makeSigned()).then(
      () => undefined,
      (err: unknown) => err,
    );

    // DFR_PROVIDER_UNAVAILABLE is "retryable" for reads; but broadcast must never resend because of it.
    expect(isDfrError(error) && error.retryable).toBe(true);
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
    // This cross-checks packages/provider/test/provider.test.ts:
    // "broadcast-class (non-idempotent-write) never retries automatically":
    // the Adapter declares the class → the Manager refuses retries and failover by class.
  });

  it('recorded ground truth matches (C03a): expectedFrom matches the signer, unsigned payload matches field by field → allowed', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();
    const unsigned = serializeTransaction({
      chainId: CHAIN_ID,
      nonce: 1,
      to: TO,
      value: VALUE,
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    });

    const result = await adapter.broadcast(context(router), signed, {
      expectedFrom: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      expectedUnsignedPayload: unsigned,
    });

    expect(result.accepted).toBe(true);
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('signer differs from the recorded from → sender_mismatch, no broadcast sent', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();
    const unsigned = serializeTransaction({
      chainId: CHAIN_ID,
      nonce: 1,
      to: TO,
      value: VALUE,
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    });

    const error = await adapter
      .broadcast(context(router), signed, {
        // A different account: must be rejected even if every field matches (the nonce was reserved for the previous account).
        expectedFrom: { chain: SEPOLIA, address: `0x${'9'.repeat(40)}` },
        expectedUnsignedPayload: unsigned,
      })
      .then(() => undefined, (err: unknown) => err);

    expect(isDfrError(error) && error.code).toBe('DFR_TRANSACTION_REJECTED');
    expect(isDfrError(error) && error.details?.['reason']).toBe('sender_mismatch');
    expect(calls).toEqual([]);
  });

  it('recorded unsigned payload fields differ from the signed payload → unsigned_payload_mismatch, no broadcast sent', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();
    const tampered = serializeTransaction({
      chainId: CHAIN_ID,
      nonce: 1,
      to: TO,
      value: VALUE + 1n, // amount was changed
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 3000000000n,
      maxPriorityFeePerGas: 1000000000n,
      type: 'eip1559',
    });

    const error = await adapter
      .broadcast(context(router), signed, {
        expectedFrom: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
        expectedUnsignedPayload: tampered,
      })
      .then(() => undefined, (err: unknown) => err);

    expect(isDfrError(error) && error.details?.['reason']).toBe('unsigned_payload_mismatch');
    expect(calls).toEqual([]);
  });

  it('only half the recorded ground truth given → invalid_expectation, no broadcast sent', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();

    const error = await adapter
      .broadcast(context(router), signed, {
        expectedFrom: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
        // expectedUnsignedPayload deliberately omitted: half a ground truth must not count as "verified".
      })
      .then(() => undefined, (err: unknown) => err);

    expect(isDfrError(error) && error.details?.['reason']).toBe('invalid_expectation');
    expect(calls).toEqual([]);
  });

  it('endpoint txHash differs from the recomputed payload hash → DFR_PROVIDER_INVALID_RESPONSE (fail-closed)', async () => {
    const { router } = createStubRouter({ send: () => `0x${'cd'.repeat(32)}` });

    const error = await adapter.broadcast(context(router), await makeSigned()).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(isDfrError(error) && error.code).toBe('DFR_PROVIDER_INVALID_RESPONSE');
  });

  it('observation: expectedHash finds an unconfirmed transaction → pending', async () => {
    const { router } = createStubRouter({
      observe: () => ({
        hash: `0x${'ab'.repeat(32)}`,
        blockNumber: null,
        blockHash: null,
        from: privateKeyToAddress(TEST_KEY),
        to: TO,
        value: '0x3e8',
        nonce: '0x1',
        gasPrice: '0x1',
      }),
    });

    const observation = await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '1' as never,
    });

    expect(observation).toEqual({ kind: 'pending', txHash: `0x${'ab'.repeat(32)}` });
  });

  it('observation: confirmed transaction found → included with a block reference', async () => {
    const { router } = createStubRouter({
      observe: () => ({
        hash: `0x${'ab'.repeat(32)}`,
        blockNumber: '0x112a880',
        blockHash: `0x${'11'.repeat(32)}`,
        from: privateKeyToAddress(TEST_KEY),
        to: TO,
        value: '0x3e8',
        nonce: '0x1',
        gasPrice: '0x1',
      }),
    });

    const observation = await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '1' as never,
    });

    expect(observation.kind).toBe('included');
    expect(observation).toMatchObject({
      blockRef: { kind: 'number', number: '18000000' },
      canonicalBlockHash: `0x${'11'.repeat(32)}`,
    });
  });

  it('observation: not found and on-chain nonce already passed → replaced (not dropped)', async () => {
    const { router } = createStubRouter({
      observe: () => null,
      latestNonce: () => '0x2b', // 43 > 42: that nonce was already consumed by someone else
    });

    const observation = await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '42' as never,
    });

    expect(observation).toEqual({ kind: 'replaced', nonce: '42' });
  });

  it('observation: not found and nonce not consumed → absent (stays unknown, not judged dropped)', async () => {
    const { router } = createStubRouter({ observe: () => null, latestNonce: () => '0x2a' });

    const observation = await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '42' as never,
    });

    expect(observation).toEqual({ kind: 'absent' });
  });

  it('observation is read-only: no eth_sendRawTransaction is sent', async () => {
    const { router, calls } = createStubRouter({ observe: () => null, latestNonce: () => '0x2a' });

    await adapter.observeBroadcast(context(router), {
      chain: SEPOLIA,
      txHash: `0x${'ab'.repeat(32)}`,
      from: { chain: SEPOLIA, address: privateKeyToAddress(TEST_KEY) },
      nonce: '42' as never,
    });

    expect(calls.map((c) => c.method)).toEqual(['eth_getTransactionByHash', 'eth_getTransactionCount']);
    expect(calls.every((c) => c.idempotency === 'safe-read')).toBe(true);
  });

  it('rebroadcast option passes through to the result (back-edge marker from dropped → broadcast)', async () => {
    const { router, calls } = createStubRouter();
    const signed = await makeSigned();
    const result = await adapter.broadcast(context(router), signed, {
      rebroadcast: true,
      idempotencyKey: 'idem-key-12345678',
    });
    expect(result.rebroadcast).toBe(true);
    // The idempotency key is upper-layer semantics: the Adapter must not stuff it into JSON-RPC params (it would leak into the on-chain request).
    const send = calls.find((c) => c.method === 'eth_sendRawTransaction');
    expect(send?.params).toEqual([signed.signedPayload]);
  });

  it('broadcast does not change from semantics: the payload was really signed by that account (C01 binds the same ground truth)', async () => {
    const { parseSignedTransaction } = await import('@dfr/adapter-evm');
    const { privateKeyToAddress } = await import('viem/accounts');
    const signed = await makeSigned();
    const parsed = await parseSignedTransaction(SEPOLIA, signed.signedPayload);
    expect(parsed.from.address).toBe(privateKeyToAddress(TEST_KEY).toLowerCase());
    expect(parsed.txHash).toBe(signed.expectedHash);
  });
});
