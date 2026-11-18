/**
 * M1-A batch integration acceptance (DFR-M1-A14).
 *
 * Prerequisite: `pnpm test:db` first establishes the empty-database contract with migration/schema tests,
 * then run this file separately to avoid Vitest dropping schemas in parallel across files.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresTransactionRuntime } from '../../packages/storage-postgres/src/index.js';
import type {
  ChainId,
  DecimalUint,
  Iso8601,
  TransactionId,
} from '../../packages/types/src/index.js';

const DATABASE_URL = process.env['DFR_TRANSACTION_DATABASE_URL'];
const ENABLED = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;
const CHAIN = 'ethereum-sepolia' as ChainId;

type Runtime = Awaited<ReturnType<typeof createPostgresTransactionRuntime>>;
const opened: Runtime[] = [];

async function openRuntime(): Promise<Runtime> {
  const runtime = await createPostgresTransactionRuntime({ databaseUrl: DATABASE_URL! });
  opened.push(runtime);
  return runtime;
}

afterEach(async () => {
  while (opened.length > 0) {
    const runtime = opened.pop();
    if (runtime !== undefined) await runtime.close();
  }
});

describe.skipIf(!ENABLED)('M1-A PostgreSQL batch integration (DFR-M1-A14)', () => {
  it('the composition factory assembles four Stores (including the E5 quota Store), close can be called repeatedly', async () => {
    const runtime = await openRuntime();

    expect(runtime.stores.transaction).toBeTruthy();
    expect(runtime.stores.idempotency).toBeTruthy();
    expect(runtime.stores.nonce).toBeTruthy();
    expect(runtime.stores.tracker).toBeTruthy();
    expect(runtime.stores.providerQuota).toBeTruthy();
    expect(runtime.stores.sequencing).toBeTruthy();

    await runtime.close();
    opened.pop();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it('E5: two independent runtimes share the Provider daily quota; with a quota of 3, 8-way concurrency yields exactly 3 successes', async () => {
    const first = await openRuntime();
    const second = await openRuntime();
    const input = {
      providerId: `quota-${randomUUID()}`,
      chain: CHAIN,
      day: '2026-10-08',
      limit: 3,
    };

    const results = await Promise.all([
      ...Array.from({ length: 4 }, () => first.stores.providerQuota.consume(input)),
      ...Array.from({ length: 4 }, () => second.stores.providerQuota.consume(input)),
    ]);

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.filter((result) => !result.allowed)).toHaveLength(5);
    expect(await first.stores.providerQuota.usage(input)).toBe(3);
    expect(await second.stores.providerQuota.usage(input)).toBe(3);
  });

  it('Stores shared via the composition factory still keep concurrent idempotent single-winner behavior', async () => {
    const runtime = await openRuntime();
    const key = `a14-${randomUUID()}`;
    const scope = { projectId: 'default', chain: CHAIN, key };

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        runtime.stores.idempotency.begin({
          scope,
          fingerprint: 'f'.repeat(64),
          ownerToken: `owner-${index}-${randomUUID()}`,
          leaseTtlMs: 30_000,
        }),
      ),
    );

    expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'in_flight')).toHaveLength(11);
  });

  it('after closing and rebuilding the Pool, non-terminal transactions and tracker recovery queries are still visible', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const transactionId = `txn_a14_${suffix}` as TransactionId;
    const txHash = `0x${suffix.padEnd(64, '0')}`;
    const first = await openRuntime();
    const timestamp = new Date().toISOString() as Iso8601;

    const created = await first.stores.transaction.create({
      record: {
        transactionId,
        projectId: 'default',
        chain: CHAIN,
        requestFingerprint: 'a'.repeat(64),
        status: 'pending',
        stateVersion: '1' as DecimalUint,
        from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
        txHash,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    expect(created.kind).toBe('created');
    expect(
      await first.stores.tracker.acquire({
        chain: CHAIN,
        txHash,
        ownerToken: `tracker-${suffix}`,
        // Restart recovery can only take over expired leases; valid leases must keep single-flight.
        leaseTtlMs: -1,
      }),
    ).toMatchObject({ kind: 'acquired' });

    await first.close();
    opened.pop();

    const restarted = await openRuntime();
    const transactions = await restarted.stores.transaction.listRecoverable({ limit: 500 });
    const trackers = await restarted.stores.tracker.listRecoverable({ chain: CHAIN, limit: 500 });

    expect(transactions.map((record) => record.transactionId)).toContain(transactionId);
    expect(trackers.map((lease) => lease.txHash)).toContain(txHash);
  });
});
