/**
 * Store-call observation contract test (the remaining store.read / store.write spans of observability-spec chapter 4).
 *
 * Authoritative source: docs/architecture/observability-spec-v0.1.md, chapter 4, span hierarchy —
 * below `core.operation`, besides `adapter.call`, there are also `store.read` / `store.write`.
 * The Gateway and the Provider/Adapter layers already have logging; the transaction engine's Store calls previously had no observation at all.
 *
 * This test asserts:
 *   1. every Store call in the build orchestration produces a record, with the right store/operation/kind;
 *   2. failed calls carry a stable `DFR_*` error code (or a fixed fallback code), without the original exception;
 *   3. records contain **no** business values such as addresses, payloads, or nonces (observation must not become a leak surface);
 *   4. a throwing observation outlet does not affect the business result.
 */
import { describe, expect, it } from 'vitest';
import {
  READ_OPERATIONS,
  TransactionEngine,
  WRITE_OPERATIONS,
  storeCallKind,
  type StoreCallRecord,
} from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia' as never;

const REQUEST = {
  chain: CHAIN,
  from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
  to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
  value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' },
} as never;

function makeEngine(records: StoreCallRecord[], overrides: { failCreate?: boolean } = {}) {
  const stores = createInMemoryTransactionStores();
  if (overrides.failCreate === true) {
    stores.transaction.create = async () => {
      const error = new Error('insert failed: relation "transactions" does not exist');
      throw error;
    };
  }
  const engine = new TransactionEngine({
    stores,
    chain: {
      getPendingNonce: async () => '7' as never,
      build: async ({ request }: never) => ({
        schemaVersion: '1',
        chain: (request as { chain: unknown }).chain,
        payload: '0x02f8',
        meta: { encoding: 'hex', requiresNonce: '7' },
      }),
    } as never,
    newTransactionId: () => 'txn_store_call' as never,
    onStoreCall: (record) => records.push(record),
  });
  return engine;
}

describe('TransactionEngine Store-call observation (observability-spec §4)', () => {
  it('build orchestration produces a store-call record per call, distinguishing read / write', async () => {
    const records: StoreCallRecord[] = [];
    const engine = makeEngine(records);

    await engine.build({ request: REQUEST, idempotencyKey: 'store-call-0001' });

    // build order: idempotency begin(write) → nonce reserve(write) → transaction create(write) → idempotency complete(write)
    const pairs = records.map((r) => `${r.store}.${r.operation}:${r.kind}`);
    expect(pairs).toEqual([
      'idempotency.begin:write',
      'nonce.reserve:write',
      'transaction.create:write',
      'idempotency.complete:write',
    ]);
    for (const record of records) {
      expect(record.status).toBe('success');
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(record.latencyMs)).toBe(true);
    }
  });

  it('a failed call carries a stable error code, without the original exception text', async () => {
    const records: StoreCallRecord[] = [];
    const engine = makeEngine(records, { failCreate: true });

    await expect(
      engine.build({ request: REQUEST, idempotencyKey: 'store-call-0002' }),
    ).rejects.toBeDefined();

    const failed = records.filter((r) => r.status === 'error');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.store).toBe('transaction');
    expect(failed[0]?.operation).toBe('create');
    // A non-DFR exception normalizes to a fixed fallback code, without echoing the driver text.
    expect(failed[0]?.errorCode).toBe('DFR_INTERNAL_ERROR');
    expect(JSON.stringify(records)).not.toContain('relation "transactions" does not exist');
  });

  it('records contain no business values such as address / payload / nonce (observation is not a leak surface)', async () => {
    const records: StoreCallRecord[] = [];
    const engine = makeEngine(records);
    await engine.build({ request: REQUEST, idempotencyKey: 'store-call-0003' });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('0x1111111111111111111111111111111111111111');
    expect(serialized).not.toContain('0x2222222222222222222222222222222222222222');
    expect(serialized).not.toContain('0x02f8');
    // The field names themselves should not contain these either.
    for (const record of records) {
      expect(Object.keys(record)).not.toContain('address');
      expect(Object.keys(record)).not.toContain('payload');
      expect(Object.keys(record)).not.toContain('nonce');
    }
  });

  it('a throwing observation outlet does not affect the business result', async () => {
    const stores = createInMemoryTransactionStores();
    const engine = new TransactionEngine({
      stores,
      chain: {
        getPendingNonce: async () => '7' as never,
        build: async ({ request }: never) => ({
          schemaVersion: '1',
          chain: (request as { chain: unknown }).chain,
          payload: '0x02f8',
          meta: { encoding: 'hex', requiresNonce: '7' },
        }),
      } as never,
      newTransactionId: () => 'txn_store_call_err' as never,
      onStoreCall: () => {
        throw new Error('sink exploded');
      },
    });

    await expect(
      engine.build({ request: REQUEST, idempotencyKey: 'store-call-0004' }),
    ).resolves.toMatchObject({ status: 'built' });
  });

  it('zero overhead and no error when no outlet is injected', async () => {
    const stores = createInMemoryTransactionStores();
    const engine = new TransactionEngine({
      stores,
      chain: {
        getPendingNonce: async () => '7' as never,
        build: async ({ request }: never) => ({
          schemaVersion: '1',
          chain: (request as { chain: unknown }).chain,
          payload: '0x02f8',
          meta: { encoding: 'hex', requiresNonce: '7' },
        }),
      } as never,
      newTransactionId: () => 'txn_store_call_noop' as never,
    });
    await expect(
      engine.build({ request: REQUEST, idempotencyKey: 'store-call-0005' }),
    ).resolves.toBeDefined();
  });
});

/** A minimal SequencingStore test double: only providing real method names for the "every method is registered" guard. */
function sequencingPort(): object {
  return {
    reserve: async () => ({ kind: 'reserved', lease: {} }),
    markConsumed: async () => ({ kind: 'not_found' }),
    releaseIfSafe: async () => ({ kind: 'not_found' }),
    releaseExpiredOrphaned: async () => 0,
  };
}

describe('Store read/write classification coverage guard', () => {
  it('every method of every port is explicitly classified (a new method fails this test)', () => {
    // The classification sets are maintained by hand; if a new port method is not registered, it falls into the "unregistered means write" fallback,
    // silently reporting a read as a write. This assertion turns "forgot to register" into a red light.
    const stores = createInMemoryTransactionStores();
    const ports: [string, object][] = [
      ['transaction', stores.transaction],
      ['idempotency', stores.idempotency],
      ['nonce', stores.nonce],
      // M3: the Solana blockhash ordering-lease port (reserve/markConsumed/releaseIfSafe are already registered
      // in WRITE_OPERATIONS, in the same classification as nonce).
      ['sequencing', sequencingPort()],
      ['tracker', stores.tracker],
    ];
    const unclassified: string[] = [];
    for (const [portName, port] of ports) {
      for (const key of Object.keys(port)) {
        const value = (port as Record<string, unknown>)[key];
        if (typeof value !== 'function') continue;
        if (!READ_OPERATIONS.has(key) && !WRITE_OPERATIONS.has(key)) {
          unclassified.push(`${portName}.${key}`);
        }
      }
    }
    expect(
      unclassified,
      'Store port has an unregistered read/write classification: add it to READ_OPERATIONS or WRITE_OPERATIONS',
    ).toEqual([]);
  });

  it('the two classification sets do not overlap (one method cannot be both read and write)', () => {
    const both = [...READ_OPERATIONS].filter((op) => WRITE_OPERATIONS.has(op));
    expect(both).toEqual([]);
  });

  it('an unregistered method is conservatively treated as a write, not a default read', () => {
    // Verify the fallback direction directly: reporting a real write as a read would undercount write pressure, which is more dangerous.
    expect(storeCallKind('transaction', 'someBrandNewMethod')).toBe('write');
    expect(storeCallKind('transaction', 'get')).toBe('read');
    expect(storeCallKind('transaction', 'transition')).toBe('write');
  });
});
