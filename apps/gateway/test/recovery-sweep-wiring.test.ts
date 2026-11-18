// D03 recovery sweep composition-root wiring test (closes the residual gap recorded in TODO-009).
//
// Gap: `RecoveryCoordinator` (expired idempotency cleanup / orphaned nonce lease reclamation / unknown resolution)
// previously ran only one round at **startup**, so long-lived instances would never reclaim them again.
//
// This test uses a real `startGateway` to prove three things:
//   1. a recovery round runs first at startup (before listening on the port);
//   2. it then runs periodically per `DFR_RECOVERY_SWEEP_INTERVAL_MS`;
//   3. it stops after `close()`, no longer touching the Store.
// Component-level behavior is covered by packages/transaction/test/recovery-scheduler.test.ts and recovery.test.ts.
import { describe, expect, it, vi } from 'vitest';
import type { TransactionStores } from '@dfr/core';
import { hashSecret } from '../src/index.js';
import { GatewayStartupError, startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'RecovKey';
const SECRET = 'recoverySweepWiringSecret01234567ab';
const PEPPER = 'recovery-sweep-pepper';

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

/** Record pruneExpired's limit: the one method every recovery round must call. */
function countingPersistence() {
  const pruneExpired = vi.fn(async (_input: { limit: number }) => 0);
  const persistence: GatewayPersistence = {
    stores: {
      transaction: { listRecoverable: async () => [] as never[] } as unknown as TransactionStores['transaction'],
      idempotency: { pruneExpired } as unknown as TransactionStores['idempotency'],
      nonce: { releaseExpiredOrphaned: async () => 0 } as unknown as TransactionStores['nonce'],
      tracker: {
        acquire: async () => ({ kind: 'held_by_other' }),
        release: async () => ({ kind: 'released' }),
      } as unknown as TransactionStores['tracker'],
    },
    healthCheck: async () => undefined,
    close: vi.fn(async () => undefined),
  };
  return { persistence, pruneExpired };
}

function silenceStdio() {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return () => {
    stdout.mockRestore();
    stderr.mockRestore();
  };
}

describe('D03 recovery sweep wiring (closing the TODO-009 residual gap)', () => {
  it('runs one recovery round first at startup (before listening), honoring DFR_RECOVERY_BATCH_SIZE', async () => {
    const { persistence, pruneExpired } = countingPersistence();
    const restore = silenceStdio();
    try {
      const app = await startGateway(
        { ...BASE_ENV, DFR_RECOVERY_BATCH_SIZE: '37' },
        async () => persistence,
      );
      // By the time startGateway resolves, it has already listened: the startup round must have run.
      expect(pruneExpired).toHaveBeenCalledTimes(1);
      expect(pruneExpired.mock.calls[0]?.[0].limit).toBe(37);
      await app.close();
    } finally {
      restore();
    }
  }, 15_000);

  it('runs periodically per DFR_RECOVERY_SWEEP_INTERVAL_MS', async () => {
    const { persistence, pruneExpired } = countingPersistence();
    const restore = silenceStdio();
    try {
      const app = await startGateway(
        { ...BASE_ENV, DFR_RECOVERY_SWEEP_INTERVAL_MS: '1000' },
        async () => persistence,
      );
      const baseline = pruneExpired.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      expect(pruneExpired.mock.calls.length).toBeGreaterThan(baseline);
      await app.close();
    } finally {
      restore();
    }
  }, 15_000);

  it('close() stops the recovery sweep: the Store is no longer touched afterwards', async () => {
    const { persistence, pruneExpired } = countingPersistence();
    const restore = silenceStdio();
    try {
      const app = await startGateway(
        { ...BASE_ENV, DFR_RECOVERY_SWEEP_INTERVAL_MS: '1000' },
        async () => persistence,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await app.close();
      const afterClose = pruneExpired.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_400));
      expect(pruneExpired.mock.calls.length).toBe(afterClose);
    } finally {
      restore();
    }
  }, 15_000);

  it('an illegal recovery sweep interval / batch cap fails closed', async () => {
    const { persistence } = countingPersistence();
    await expect(
      startGateway({ ...BASE_ENV, DFR_RECOVERY_SWEEP_INTERVAL_MS: '10' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
    await expect(
      startGateway({ ...BASE_ENV, DFR_RECOVERY_BATCH_SIZE: '501' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
    await expect(
      startGateway({ ...BASE_ENV, DFR_RECOVERY_BATCH_SIZE: 'ten' }, async () => persistence),
    ).rejects.toBeInstanceOf(GatewayStartupError);
  }, 15_000);
});
