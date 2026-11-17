/** 链 scope 必须覆盖 JSON body 中的真实目标链，而不只覆盖 query 参数。 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DfrCore } from '@dfr/core';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const KEY_ID = 'ChainScp';
const SECRET = 'bodyChainScopeSecret0123456789abcd';
const PEPPER = 'body-chain-scope-pepper';
const KEY_HEADER = { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` };
const FORBIDDEN_CHAIN = 'ethereum-sepolia';

const core = {
  listChains: () => [],
  startHealthChecks: () => ({ started: 0, skipped: 0 }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

let server: Server | undefined;
let baseUrl = '';

async function start(): Promise<void> {
  const auth: StaticApiKeyConfig = {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'body-chain-scope-test',
    scope: { chains: ['base-sepolia' as never], capabilities: '*', allowWrite: true },
  };
  server = createGatewayServer({ core, auth, allowWrite: true });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...KEY_HEADER, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('JSON body chain scope', () => {
  it('build、preflight、simulate、broadcast 与事件票据都在业务处理前拒绝未授权链', async () => {
    await start();
    const unsigned = { schemaVersion: '1', chain: FORBIDDEN_CHAIN, payload: '0x00', meta: {} };
    const cases = [
      ['/v1/transactions/build', { chain: FORBIDDEN_CHAIN, from: { address: '0xabc' } }, {}],
      ['/v1/transactions/preflight', { chain: FORBIDDEN_CHAIN, from: { address: '0xabc' } }, {}],
      ['/v1/transactions/simulate', { transactionId: 'txn_test', unsignedTransaction: unsigned }, {}],
      ['/v1/transactions/broadcast', {
        transactionId: 'txn_test',
        signedTransaction: { schemaVersion: '1', chain: FORBIDDEN_CHAIN, unsigned, signedPayload: '0x00', expectedHash: '0x00' },
      }, { 'idempotency-key': 'body-chain-scope-test' }],
      ['/v1/events/tickets', { filter: { chain: FORBIDDEN_CHAIN } }, {}],
    ] as const;

    for (const [path, body, headers] of cases) {
      const response = await post(path, body, headers);
      expect(response.status, path).toBe(403);
      expect(response.body, path).toMatchObject({ dfr_code: 'DFR_PROJECT_SCOPE_DENIED' });
    }
  });
});
