// Composition-root readiness assembly test (DFR-M1-E02).
//
// Unit tests cover the Gateway's `/readyz` logic; what is added here is the **wiring**: a real `startGateway`
// in M1 (with a transaction store) must wire the database probe into `/readyz`, or the orchestrator will assume
// "HTTP is up, so it is ready", while the database is actually unreachable.
import { describe, expect, it, vi } from 'vitest';
import type { TransactionStores } from '@dfr/core';
import { hashSecret } from '../src/index.js';
import { startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'ReadyKey';
const SECRET = 'readinessWiringSecret0123456789ab';
const PEPPER = 'readiness-wiring-pepper';

const M1_ENV = {
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

function persistence(healthCheck: () => Promise<void>): GatewayPersistence {
  // startGateway runs one RecoveryCoordinator round before listening; the four Stores are given
  // minimal no-op implementations here, so the test only focuses on readiness wiring and does not repeat the recovery semantics already covered by the DB gates.
  return {
    stores: {
      transaction: {
        listRecoverable: async () => [],
      } as unknown as TransactionStores['transaction'],
      idempotency: {
        pruneExpired: async () => 0,
      } as unknown as TransactionStores['idempotency'],
      nonce: {
        releaseExpiredOrphaned: async () => 0,
      } as unknown as TransactionStores['nonce'],
      tracker: {
        acquire: async () => ({ kind: 'held_by_other' }),
        release: async () => ({ kind: 'released' }),
      } as unknown as TransactionStores['tracker'],
    },
    healthCheck,
    close: vi.fn(async () => undefined),
  };
}

async function withGateway(
  healthCheck: () => Promise<void>,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const app = await startGateway(M1_ENV, async () => persistence(healthCheck));
  try {
    await body(`http://127.0.0.1:${app.port}`);
  } finally {
    await app.close();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe('startGateway readiness assembly (DFR-M1-E02)', () => {
  it('after M1 startup, /readyz reflects database reachability (stores=ok)', async () => {
    await withGateway(async () => undefined, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/readyz`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['status']).toBe('ready');
      expect(body['stores']).toBe('ok');
      // Readiness details must faithfully reflect each enabled chain's Provider availability.
      // ethereum-sepolia: two endpoints resolved from env → 2/2.
      // base-sepolia: enabled under M1 but this test provides no endpoint env → 0/0 (the configuration gap is explicitly exposed,
      // not papered over as "ready"). Overall it is still ready, because at least one chain has an available Provider.
      expect(body['chains']).toEqual([
        { chain: 'ethereum-sepolia', providers: 2, available: 2 },
        { chain: 'base-sepolia', providers: 0, available: 0 },
      ]);
    });
  });

  it('when the database probe fails, /readyz is 503 but /healthz stays 200', async () => {
    await withGateway(
      async () => {
        throw new Error('connect ECONNREFUSED 10.1.2.3:5432');
      },
      async (baseUrl) => {
        const ready = await fetch(`${baseUrl}/readyz`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toMatchObject({ status: 'not_ready', stores: 'unavailable' });

        const live = await fetch(`${baseUrl}/healthz`);
        expect(live.status).toBe(200);
      },
    );
  });

  it('when the database fails at runtime, business routes are rejected; traffic is admitted again after recovery', async () => {
    let databaseUp = true;
    await withGateway(
      async () => {
        if (!databaseUp) throw new Error('database unavailable');
      },
      async (baseUrl) => {
        const headers = { 'X-DFR-Key': `dfr_${KEY_ID}_${SECRET}` };
        expect((await fetch(`${baseUrl}/v1/chains`, { headers })).status).toBe(200);

        databaseUp = false;
        expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
        expect((await fetch(`${baseUrl}/v1/chains`, { headers })).status).toBe(503);

        databaseUp = true;
        expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
        expect((await fetch(`${baseUrl}/v1/chains`, { headers })).status).toBe(200);
      },
    );
  });
});
