// broadcast idempotency contract test (TODO-013).
//
// Pre-review finding: gateway-spec §7.2 / openapi / m1-api-contract §4 / security-trust-model §5
// all claim broadcast is idempotent (store fingerprint + first response, same-body replay, different-body 409, `Idempotency-Replayed`),
// but the Gateway only validates key length, and `engine.broadcast` never touches the idempotency Store.
//
// This file locks that contract into behavior. **The strongest assertion is**: on a same-key same-body replay,
// **the Adapter is called only once** — that is the true funds-safety meaning of "idempotent" (no duplicate broadcast).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import {
  GatewayIdempotencyCoordinator,
  createGatewayServer,
  hashSecret,
  type StaticApiKeyConfig,
} from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia';
const KEY_ID = 'BcIdem01'; // exactly 8 characters
const SECRET = 'broadcastIdempotencySecret0123456789';
const PEPPER = 'bc-idem-pepper';
const EXPECTED_HASH = `0x${'ab'.repeat(32)}`;

const core = {
  listChains: () => [],
  readiness: () => ({ ready: false, chains: [] }),
  startHealthChecks: () => ({ started: [], skipped: [] }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

function auth(): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'bc-idem',
    scope: { chains: '*', capabilities: '*', allowWrite: true },
  };
}

const UNSIGNED = { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: {} };

function body(transactionId: string, hash = EXPECTED_HASH) {
  return {
    transactionId,
    signedTransaction: {
      schemaVersion: '1',
      chain: CHAIN,
      unsigned: UNSIGNED,
      signedPayload: '0x02f8signed',
      expectedHash: hash,
    },
  };
}

let server: Server | undefined;
let broadcastCalls = 0;
let baseUrl = '';

async function start(): Promise<void> {
  broadcastCalls = 0;
  const stores = createInMemoryTransactionStores();
  const engine = {
    broadcast: async () => {
      broadcastCalls += 1;
      return {
        transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
        status: 'broadcast',
        txHash: EXPECTED_HASH,
        accepted: true,
        observedAt: new Date().toISOString(),
      };
    },
  };
  server = createGatewayServer({
    core,
    auth: auth(),
    allowWrite: true,
    transactions: engine as never,
    // A real in-memory idempotency Store + the real C04 coordinator (never assembled before).
    idempotency: new GatewayIdempotencyCoordinator(stores.idempotency),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function post(
  payload: unknown,
  idempotencyKey: string,
): Promise<{ status: number; replayed: string | null; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/transactions/broadcast`, {
    method: 'POST',
    headers: {
      'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    replayed: response.headers.get('idempotency-replayed'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('broadcast idempotency (TODO-013)', () => {
  it('same key and body twice → both 202, but the Adapter is called only once, and the second carries Idempotency-Replayed', async () => {
    await start();
    const payload = body('txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN');

    const first = await post(payload, 'bc-idem-key-0001');
    expect(first.status).toBe(202);
    expect(first.replayed).toBeNull();
    expect(broadcastCalls).toBe(1);

    const second = await post(payload, 'bc-idem-key-0001');
    expect(second.status).toBe(202);
    // Key point: a replay must **not** broadcast again.
    expect(broadcastCalls).toBe(1);
    expect(second.replayed).toBe('true');
    expect(second.body['transactionId']).toBe(first.body['transactionId']);
  });

  it('same key, different body → 409 DFR_IDEMPOTENCY_CONFLICT, and no second broadcast', async () => {
    await start();
    await post(body('txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN'), 'bc-idem-key-0002');
    expect(broadcastCalls).toBe(1);

    // Reuse the same idempotency key with a different transactionId (different request body).
    const conflict = await post(body('txn_OTHER_ID'), 'bc-idem-key-0002');
    expect(conflict.status).toBe(409);
    expect(conflict.body['dfr_code']).toBe('DFR_IDEMPOTENCY_CONFLICT');
    expect(broadcastCalls).toBe(1);
  });

  it('different idempotency keys → each executes independently (idempotency keys do not cross-contaminate)', async () => {
    await start();
    const payload = body('txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN');
    await post(payload, 'bc-idem-key-0003');
    await post(payload, 'bc-idem-key-0004');
    expect(broadcastCalls).toBe(2);
  });

  it('without an assembled idempotency coordinator, no silent degradation: the key is still required, but no replay is done', async () => {
    // This case locks in that the behavioral difference of "assembled or not" is explicit: no coordinator means no replay guarantee.
    broadcastCalls = 0;
    const engine = {
      broadcast: async () => {
        broadcastCalls += 1;
        return { transactionId: 'txn_x', status: 'broadcast', txHash: EXPECTED_HASH, accepted: true, observedAt: new Date().toISOString() };
      },
    };
    server = createGatewayServer({ core, auth: auth(), allowWrite: true, transactions: engine as never });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const payload = body('txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN');
    await post(payload, 'bc-idem-key-0005');
    await post(payload, 'bc-idem-key-0005');
    // No coordinator → both requests really broadcast (this is the current honest behavior, not "pretend idempotency").
    expect(broadcastCalls).toBe(2);
  });
});

describe('real startGateway idempotency wiring (TODO-013)', () => {
  it('after M1 startup, broadcast idempotency is in effect: same key with a different body is blocked with 409 (proving the coordinator is assembled)', async () => {
    // Why "conflict" rather than "replay" verifies the wiring: replay requires the **first request to succeed** (so the first response is written),
    // while making the real startGateway engine broadcast successfully needs an available Provider + real signing — that is covered by
    // tests/e2e/m1-broadcast.e2e.test.ts. Here we only need to prove "the coordinator is really assembled":
    // `acquire` happens **before** the engine call, so the same key with a different body necessarily gets 409 (not the engine layer's 404).
    const { startGateway } = await import('../src/main.js');
    const stores = createInMemoryTransactionStores();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let app: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      app = await startGateway(
        {
          DFR_M0_API_KEY_ID: KEY_ID,
          DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
          DFR_M0_API_KEY_PEPPER: PEPPER,
          DFR_GATEWAY_PORT: '0',
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
        },
        async () => ({
          stores: {
            transaction: stores.transaction,
            idempotency: stores.idempotency,
            nonce: stores.nonce,
            tracker: stores.tracker,
          } as never,
          healthCheck: async () => undefined,
          close: async () => undefined,
        }),
      );
      const url = `http://127.0.0.1:${app.port}/v1/transactions/broadcast`;
      const headers = {
        'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
        'content-type': 'application/json',
        'idempotency-key': 'wire-idem-0001',
      };

      const first = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body('txn_wire_a')),
      });
      // The first request acquires execution rights, then fails at the engine layer because the record does not exist (404),
      // but the idempotency record is already established — which is exactly the premise of the conflict assertion below.
      expect(first.status).toBe(404);

      const second = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body('txn_wire_b')),
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { dfr_code?: string }).dfr_code).toBe(
        'DFR_IDEMPOTENCY_CONFLICT',
      );
    } finally {
      await app?.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);
});
