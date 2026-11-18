// D04 standing reorg sweep composition-root wiring test (closes the D04/D05/D07 leftover runtime gap).
//
// Why a real startGateway is required: whether the scheduler is assembled and whether close() stops it can only be proven by
// a real composition root. Component-level behavior is covered by packages/transaction/test/reorg-scheduler.test.ts
// and reorg.test.ts; here we only prove "the production entry point really runs it".
import { describe, expect, it, vi } from 'vitest';
import type { TransactionStores } from '@dfr/core';
import { hashSecret } from '../src/index.js';
import { GatewayStartupError, startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'ReorgKey';
const SECRET = 'reorgSweepWiringSecret0123456789ab';
const PEPPER = 'reorg-sweep-pepper';

const BASE_ENV = {
  DFR_M0_API_KEY_ID: KEY_ID,
  DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
  DFR_M0_API_KEY_PEPPER: PEPPER,
  DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
  DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
  DFR_GATEWAY_PORT: '0',
  DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://stub.local/sepolia-primary',
  DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://stub.local/sepolia-secondary',
};

/** Record the number of listRecoverable calls: the only Store method a sweep touches (statuses=['included']). */
function countingPersistence() {
  // Explicitly annotate the input parameter types, so the test can assert the limit passed to the Store.
  const listRecoverable = vi.fn(async (_input: { limit: number; statuses?: readonly string[] }) => [] as never[]);
  const persistence: GatewayPersistence = {
    stores: {
      transaction: { listRecoverable } as unknown as TransactionStores['transaction'],
      idempotency: { pruneExpired: async () => 0 } as unknown as TransactionStores['idempotency'],
      nonce: { releaseExpiredOrphaned: async () => 0 } as unknown as TransactionStores['nonce'],
      tracker: {
        acquire: async () => ({ kind: 'held_by_other' }),
        release: async () => ({ kind: 'released' }),
      } as unknown as TransactionStores['tracker'],
    },
    healthCheck: async () => undefined,
    close: vi.fn(async () => undefined),
  };
  return { persistence, listRecoverable };
}

async function withGateway(
  env: NodeJS.ProcessEnv,
  persistence: GatewayPersistence,
  body: (app: Awaited<ReturnType<typeof startGateway>>) => Promise<void>,
): Promise<void> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const app = await startGateway(env, async () => persistence);
  try {
    await body(app);
  } finally {
    await app.close();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('D04 standing reorg sweep wiring (closing the release-blocking gap)', () => {
  it('after M1 startup, drives ReorgReconciler periodically at the configured interval', async () => {
    const { persistence, listRecoverable } = countingPersistence();
    await withGateway(
      { ...BASE_ENV, DFR_REORG_SWEEP_INTERVAL_MS: '1000', DFR_REORG_SWEEP_BATCH: '50' },
      persistence,
      async () => {
        // The startup-phase RecoveryCoordinator also calls listRecoverable; record the baseline first.
        const baseline = listRecoverable.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 1_400));
        expect(listRecoverable.mock.calls.length).toBeGreaterThan(baseline);
        // The batch cap must come from environment variables, not a hardcoded default.
        const sweep = listRecoverable.mock.calls.at(-1)?.[0];
        expect(sweep?.limit).toBe(50);
      },
    );
  }, 15_000);

  it('close() stops the sweep: no new listRecoverable calls after closing', async () => {
    const { persistence, listRecoverable } = countingPersistence();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const app = await startGateway(
        { ...BASE_ENV, DFR_REORG_SWEEP_INTERVAL_MS: '1000' },
        async () => persistence,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await app.close();
      const afterClose = listRecoverable.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      expect(listRecoverable.mock.calls.length).toBe(afterClose);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 15_000);

  it('an illegal sweep interval / batch cap fails closed, without silently falling back to defaults', async () => {
    const { persistence } = countingPersistence();
    await expect(
      startGateway({ ...BASE_ENV, DFR_REORG_SWEEP_INTERVAL_MS: 'abc' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
    await expect(
      startGateway({ ...BASE_ENV, DFR_REORG_SWEEP_INTERVAL_MS: '10' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
    await expect(
      startGateway({ ...BASE_ENV, DFR_REORG_SWEEP_BATCH: '501' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
  }, 15_000);
});
