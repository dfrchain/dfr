// `Idempotency-Key` header length contract test (TODO-007 close-out).
//
// Authoritative sources: docs/api/openapi.yaml's `IdempotencyKey` (required, broadcast) and
// `IdempotencyKeyOptional` (optional, build / simulate); both schemas are
// `minLength: 8, maxLength: 128`.
//
// Drift before the fix (this test's RED):
//   - `maxLength: 128` was **never** enforced — a 129-character key would be accepted;
//   - `minLength: 8` only took effect for broadcast; build / simulate did not validate at all (even 3 characters were accepted).
// Consequence: the SDK and the Gateway disagreed on what a "valid idempotency key" is, so a client could pass local validation while the server behaved differently;
// and over-long keys would enter the idempotency record primary key, an abusable input surface.
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import type { TransactionEngine } from '@dfr/transaction';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const KEY_ID = 'IdemKey1';
const SECRET = 'idempotencyKeySecret0123456789ab';
const PEPPER = 'idem-pepper';

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
    projectId: 'idem',
    scope: { chains: '*', capabilities: '*', allowWrite: true },
  };
}

const UNSIGNED = {
  schemaVersion: '1',
  chain: 'ethereum-sepolia',
  payload: '0x02f8',
  meta: { encoding: 'hex', requiresNonce: '42' },
};

/** Record the key passed through to the engine, to assert "a valid key is passed through as-is". */
let seenKeys: (string | undefined)[] = [];

function engine(): TransactionEngine {
  seenKeys = [];
  return {
    build: async (input: { idempotencyKey?: string }) => {
      seenKeys.push(input.idempotencyKey);
      return {
        transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
        status: 'built',
        nonce: '42',
        unsignedTransaction: UNSIGNED,
        replayed: false,
        replayable: true,
      };
    },
    simulate: async (input: { requestId?: string }) => {
      void input;
      return {
        transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
        status: 'simulated',
        simulation: { success: true, gasUsed: '21000' },
      };
    },
  } as unknown as TransactionEngine;
}

let server: Server | undefined;
let baseUrl = '';

async function start(): Promise<void> {
  server = createGatewayServer({
    core,
    auth: auth(),
    allowWrite: true,
    transactions: engine(),
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

const BUILD_BODY = {
  chain: 'ethereum-sepolia',
  from: { chain: 'ethereum-sepolia', address: '0x1111111111111111111111111111111111111111' },
  to: { chain: 'ethereum-sepolia', address: '0x2222222222222222222222222222222222222222' },
  value: { asset: { kind: 'native', chain: 'ethereum-sepolia' }, amount: '1000' },
};

const SIMULATE_BODY = {
  transactionId: 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
  unsignedTransaction: UNSIGNED,
};

async function post(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
    'content-type': 'application/json',
  };
  if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('Idempotency-Key length contract (TODO-007)', () => {
  it('build: shorter than 8 characters → 400 DFR_VALIDATION_FAILED (previously accepted)', async () => {
    await start();
    const response = await post('/v1/transactions/build', BUILD_BODY, 'short');
    expect(response.status).toBe(400);
    expect(response.body['dfr_code']).toBe('DFR_VALIDATION_FAILED');
    // The engine must not be called: structural validation precedes business orchestration.
    expect(seenKeys).toEqual([]);
  });

  it('build: boundary 8 characters pass, boundary 128 characters pass (closed interval)', async () => {
    await start();
    const eight = 'a'.repeat(8);
    expect((await post('/v1/transactions/build', BUILD_BODY, eight)).status).toBe(200);
    const max = 'b'.repeat(128);
    expect((await post('/v1/transactions/build', BUILD_BODY, max)).status).toBe(200);
    expect(seenKeys).toEqual([eight, max]);
  });

  it('build: 129 characters → 400 (previously no upper bound)', async () => {
    await start();
    const response = await post('/v1/transactions/build', BUILD_BODY, 'c'.repeat(129));
    expect(response.status).toBe(400);
    expect(response.body['dfr_code']).toBe('DFR_VALIDATION_FAILED');
    expect(seenKeys).toEqual([]);
  });

  it('build: still succeeds without an idempotency key (optional header; must not be hurt by the new validation)', async () => {
    await start();
    const response = await post('/v1/transactions/build', BUILD_BODY);
    expect(response.status).toBe(200);
    expect(seenKeys).toEqual([undefined]);
  });

  it('simulate: short and over-long keys are both rejected, valid keys admitted', async () => {
    await start();
    expect((await post('/v1/transactions/simulate', SIMULATE_BODY, 'tiny')).status).toBe(400);
    expect(
      (await post('/v1/transactions/simulate', SIMULATE_BODY, 'd'.repeat(129))).status,
    ).toBe(400);
    expect((await post('/v1/transactions/simulate', SIMULATE_BODY, 'e'.repeat(8))).status).toBe(200);
  });

  it('broadcast: 129 characters rejected (previously only the lower bound was checked)', async () => {
    await start();
    const response = await post(
      '/v1/transactions/broadcast',
      { transactionId: 'txn_1', signedTransaction: {} },
      'f'.repeat(129),
    );
    // Key-length validation precedes body parsing: even with an incomplete body, the key error should come first.
    expect(response.status).toBe(400);
    expect(response.body['dfr_code']).toBe('DFR_VALIDATION_FAILED');
  });
});
