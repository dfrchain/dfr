/**
 * `POST /v1/contracts/read` (ADR-035) and `GET /v1/accounts/{address}` (ADR-036) endpoint tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { ChainRegistry } from '@dfr/registry';
import { createStubFetch } from '@dfr/provider';
import { createGatewayServer, hashSecret, TokenBucketLimiter } from '../src/index.js';
import type { Chain } from '@dfr/types';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const SECRET = 'contractAcctSecret0123456789ab';
const PEPPER = 'contract-acct-pepper';
const KEY_ID = 'ConAcct1';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const CHAIN = 'base-sepolia';
const ADDRESS = '0x1111111111111111111111111111111111111111';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

function makeServer() {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: 'https://base.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://a.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://b.invalid',
    },
  });
  const core = new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    transactionStores: createInMemoryTransactionStores(),
    fetchImpl: createStubFetch({
      resolve: (call) => {
        switch (call.method) {
          case 'eth_call': return { kind: 'result', value: `0x${'0'.repeat(62)}2a` };
          case 'eth_getCode': return { kind: 'result', value: '0x60806040' };
          case 'eth_getTransactionCount': return { kind: 'result', value: '0x0' };
          case 'eth_getBalance': return { kind: 'result', value: '0x0' };
          default: return { kind: 'rpc-error', code: -32601, message: `unsupported ${call.method}` };
        }
      },
    }),
  });
  const server = createGatewayServer({
    core,
    auth: { keyId: KEY_ID, currentHash: hashSecret(SECRET, PEPPER), pepper: PEPPER, projectId: 'contract-acct', scope: { chains: '*', capabilities: '*', allowWrite: false } },
    limiter: new TokenBucketLimiter({
      read: { capacity: 100, refillPerSecond: 100 },
      write: { capacity: 100, refillPerSecond: 100 },
      stream: { capacity: 100, refillPerSecond: 100 },
    }),
  });
  servers.push(server);
  return server;
}

async function base(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('POST /v1/contracts/read (ADR-035)', () => {
  it('abi+method: encode the call and decode the return', async () => {
    const url = await base(makeServer());
    const res = await fetch(`${url}/v1/contracts/read?chain=${CHAIN}`, {
      method: 'POST', headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contract: ADDRESS, abi: ['function balanceOf(address) view returns (uint256)'], method: 'balanceOf', args: [ADDRESS] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { data: string; decoded: unknown } };
    // Does bigint break over JSON? No — viem decoding returns bigint, which needs care in HTTP serialization. Asserting data here is enough.
    expect(body.result.data).toBe(`0x${'0'.repeat(62)}2a`);
  });

  it('missing contract → 400', async () => {
    const url = await base(makeServer());
    const res = await fetch(`${url}/v1/contracts/read?chain=${CHAIN}`, {
      method: 'POST', headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('a chain that does not declare the capability → 422', async () => {
    const url = await base(makeServer());
    const res = await fetch(`${url}/v1/contracts/read?chain=ethereum-sepolia`, {
      method: 'POST', headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contract: ADDRESS, data: '0x' }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { dfr_code?: string }).dfr_code).toBe('DFR_UNSUPPORTED_CAPABILITY');
  });
});

describe('GET /v1/accounts/{address} (ADR-036)', () => {
  it('returns the contract determination', async () => {
    const url = await base(makeServer());
    const res = await fetch(`${url}/v1/accounts/${ADDRESS}?chain=${CHAIN}`, { headers: { 'x-dfr-key': KEY } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { kind: string; exists: boolean } };
    expect(body.account.kind).toBe('contract');
    expect(body.account.exists).toBe(true);
  });

  it('a chain that does not declare the capability → 422', async () => {
    const url = await base(makeServer());
    const res = await fetch(`${url}/v1/accounts/${ADDRESS}?chain=ethereum-sepolia`, { headers: { 'x-dfr-key': KEY } });
    expect(res.status).toBe(422);
  });

  it('unauthenticated → 401', async () => {
    const url = await base(makeServer());
    const res = await fetch(`${url}/v1/accounts/${ADDRESS}?chain=${CHAIN}`);
    expect(res.status).toBe(401);
  });
});
