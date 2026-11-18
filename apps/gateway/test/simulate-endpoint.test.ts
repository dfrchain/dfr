/**
 * simulate HTTP endpoint contract test (DFR-M1-B08).
 *
 * Authoritative sources: docs/api/openapi.yaml `/v1/transactions/simulate`,
 * docs/architecture/m1-api-contract.md sections 1/2/5.
 *
 * Request body = `SimulateTransactionRequest`: `transactionId` + the
 * `UnsignedTransaction` returned by build (no "bring another payload": the engine compares byte-for-byte against the stored record).
 *
 * Tests the Gateway's responsibilities with a fake engine:
 *   - contract envelope `{ transactionId, simulation, requestId }` (success code 200);
 *   - structural validation in the Gateway, domain binding validation in the engine;
 *   - **a revert (DFR_TRANSACTION_REVERTED) must map to 422, never wrapped as 500**;
 *   - no engine assembled → 422, not 500.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import type { SimulateTransactionInput, TransactionEngine } from '@dfr/transaction';
import { createDfrError } from '@dfr/errors';
import type { TransactionId, UnsignedTransaction } from '@dfr/types';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const CHAIN = 'ethereum-sepolia';
const SECRET = 'simulateEndpointSecret0123456789ab';
const PEPPER = 'simulate-endpoint-pepper';
const KEY_ID = 'SmKey001';
const TXN_ID = 'txn_01J8Z6W3Q2K9M4ABCDEFGHJKMN';

const core = {
  listChains: () => [],
  startHealthChecks: () => ({ started: 0, skipped: 0 }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

function auth(): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'simulate-endpoint',
    scope: { chains: '*', capabilities: '*', allowWrite: true },
  };
}

const UNSIGNED: UnsignedTransaction = {
  schemaVersion: '1',
  chain: CHAIN as never,
  payload: '0x02f8',
  meta: { encoding: 'hex', requiresNonce: '42' as never },
};

function fakeEngine(
  simulate: (input: SimulateTransactionInput) => Promise<{
    transactionId: TransactionId;
    status: 'simulated';
    simulation: { success: boolean };
  }>,
): TransactionEngine {
  return { simulate } as unknown as TransactionEngine;
}

const OK_RESULT = {
  transactionId: TXN_ID as TransactionId,
  status: 'simulated' as const,
  simulation: { success: true },
};

const VALID_BODY = { transactionId: TXN_ID, unsignedTransaction: UNSIGNED };

let server: Server | undefined;
let baseUrl = '';

async function start(engine: TransactionEngine): Promise<void> {
  server = createGatewayServer({ core, auth: auth(), allowWrite: true, transactions: engine });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function post(body: string | Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/v1/transactions/simulate`, {
    method: 'POST',
    headers: {
      'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('POST /v1/transactions/simulate (DFR-M1-B08)', () => {
  it('returns 200 + contract envelope (transactionId / simulation / requestId) on success', async () => {
    await start(fakeEngine(async () => OK_RESULT));
    const response = await post(VALID_BODY);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: TXN_ID,
      simulation: { success: true },
    });
    expect(response.body['requestId']).toMatch(/^req_/u);
    expect(JSON.stringify(response.body)).not.toContain('signedPayload');
  });

  it('passes transactionId / unsignedTransaction / requestId / signal through to the engine', async () => {
    const seen: SimulateTransactionInput[] = [];
    await start(
      fakeEngine(async (input) => {
        seen.push(input);
        return OK_RESULT;
      }),
    );

    // An optional Idempotency-Key must be accepted (OpenAPI declares it optional), but the engine's
    // simulate input has no such field: it takes no part in idempotency decisions (simulate locates by transactionId).
    await post(VALID_BODY, { 'idempotency-key': 'simulate-key-1' });
    await post(VALID_BODY);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.transactionId).toBe(TXN_ID);
    expect(seen[0]?.unsignedTransaction).toEqual(UNSIGNED);
    // The request ID and cancellation signal must travel all the way to the engine (otherwise retries/timeouts cannot be attributed).
    expect(seen[0]?.requestId).toMatch(/^req_/u);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reuses a valid X-Request-Id and echoes the same value in the response envelope', async () => {
    await start(fakeEngine(async () => OK_RESULT));
    const rid = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN';
    const response = await post(VALID_BODY, { 'x-request-id': rid });
    expect(response.body['requestId']).toBe(rid);
  });

  it('structural validation in the Gateway: missing transactionId / missing unsignedTransaction / wrong type → 400, and the engine is not called', async () => {
    const simulate = vi.fn(async () => OK_RESULT);
    await start(fakeEngine(simulate));

    const badBodies: Record<string, unknown>[] = [
      { unsignedTransaction: UNSIGNED },
      { transactionId: '' , unsignedTransaction: UNSIGNED },
      { transactionId: TXN_ID },
      { transactionId: TXN_ID, unsignedTransaction: '0x02f8' },
      { transactionId: TXN_ID, unsignedTransaction: [] },
    ];
    for (const body of badBodies) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
    }
    expect(simulate).not.toHaveBeenCalled();
  });

  it('missing unsignedTransaction.meta → 400, never leaking a 500 (found in the 2026-10-06 real-chain acceptance)', async () => {
    // Real defect: OpenAPI lists `meta` as required on UnsignedTransaction, but the Gateway's structural validation
    // only checked chain/payload. A request missing meta travels all the way into the engine, where
    // `unsigned.meta.requiresNonce` throws a TypeError, normalized into 500 DFR_INTERNAL_ERROR.
    // That is a **caller input error** and must be 400; a 500 misleads "a missing field" into "a server failure".
    const simulate = vi.fn(async () => OK_RESULT);
    await start(fakeEngine(simulate));

    const invalid: Record<string, unknown>[] = [
      // Missing meta
      { transactionId: TXN_ID, unsignedTransaction: { schemaVersion: '1', chain: CHAIN, payload: '0x02f8' } },
      // Wrong meta type
      { transactionId: TXN_ID, unsignedTransaction: { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: 'x' } },
      { transactionId: TXN_ID, unsignedTransaction: { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: [] } },
      // schemaVersion is not "1"
      { transactionId: TXN_ID, unsignedTransaction: { schemaVersion: '2', chain: CHAIN, payload: '0x02f8', meta: {} } },
      { transactionId: TXN_ID, unsignedTransaction: { chain: CHAIN, payload: '0x02f8', meta: {} } },
    ];
    for (const body of invalid) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
    }
    expect(simulate).not.toHaveBeenCalled();
  });

  it('a simulated revert (DFR_TRANSACTION_REVERTED) maps to 422, not wrapped as 500', async () => {
    await start(
      fakeEngine(async () => {
        throw createDfrError('DFR_TRANSACTION_REVERTED', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: CHAIN as never,
          message: 'execution reverted',
        });
      }),
    );
    const response = await post(VALID_BODY);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_TRANSACTION_REVERTED' });
  });

  it('payload binding failure / disallowed state (engine DFR_VALIDATION_FAILED) maps to 400', async () => {
    await start(
      fakeEngine(async () => {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: CHAIN as never,
          message: 'unsigned payload does not match the saved record',
          details: { fields: ['unsignedTransaction'] },
        });
      }),
    );
    const response = await post(VALID_BODY);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_VALIDATION_FAILED' });
  });

  it('unknown transactionId (DFR_NOT_FOUND) maps to 404', async () => {
    await start(
      fakeEngine(async () => {
        throw createDfrError('DFR_NOT_FOUND', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: 'Transaction not found',
        });
      }),
    );
    const response = await post(VALID_BODY);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_NOT_FOUND' });
  });

  it('no engine assembled → 422 (write path not enabled, not 500)', async () => {
    server = createGatewayServer({ core, auth: auth(), allowWrite: true });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await post(VALID_BODY);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ dfr_code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });
});
