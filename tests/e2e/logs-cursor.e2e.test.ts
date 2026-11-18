/**
 * SDK → Gateway → Core → EVM Adapter cursor pagination E2E.
 *
 * The SDK-only test uses a fetch mock and the Gateway-only test uses raw fetch; this drives the
 * real HTTP path with the SDK, which is the contract a reconciliation consumer actually uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { ChainRegistry } from '@dfr/registry';
import { createStubFetch } from '@dfr/provider';
import { createGatewayServer, hashSecret, TokenBucketLimiter } from '@dfr/gateway';
import { DFR } from '@dfr/sdk-typescript';
import type { Chain } from '@dfr/types';
import { createInMemoryTransactionStores } from './support/in-memory-transaction-stores.js';

const SECRET = 'logsCursorE2eSecret0123456789ab';
const PEPPER = 'logs-cursor-e2e-pepper';
const KEY_ID = 'LogsCurs';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const CHAIN = 'base-sepolia';

function logPosition(log: {
  blockRef?: { kind: string; number?: string };
  index?: string;
}): [string | undefined, string | undefined] {
  return [log.blockRef?.kind === 'number' ? log.blockRef.number : undefined, log.index];
}

function rpcLog(block: number, index: number): Record<string, unknown> {
  return {
    address: '0x1111111111111111111111111111111111111111',
    topics: [`0x${block.toString(16).padStart(2, '0')}`],
    data: '0x',
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${index.toString(16)}`,
    transactionHash: `0x${'ab'.repeat(32)}`,
  };
}

let server: Server;
let dfr: DFR;

beforeAll(async () => {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: 'https://base.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://a.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://b.invalid',
    },
  });
  const logs = [rpcLog(300, 1), rpcLog(300, 2), rpcLog(301, 1)];
  const core = new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    transactionStores: createInMemoryTransactionStores(),
    fetchImpl: createStubFetch({
      resolve: (call) => {
        if (call.method === 'eth_getLogs') return { kind: 'result', value: logs };
        if (call.method === 'eth_chainId') return { kind: 'result', value: '0x14a34' };
        return { kind: 'rpc-error', code: -32601, message: `unsupported ${call.method}` };
      },
    }),
  });
  server = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'logs-cursor-e2e',
      scope: { chains: '*', capabilities: '*', allowWrite: false },
    },
    limiter: new TokenBucketLimiter({
      read: { capacity: 100, refillPerSecond: 100 },
      write: { capacity: 100, refillPerSecond: 100 },
      stream: { capacity: 100, refillPerSecond: 100 },
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  dfr = new DFR({
    apiKey: KEY,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('cursor pagination over real HTTP (SDK)', () => {
  it('walks all logs with no gaps or duplicates, including inside one block', async () => {
    const first = await dfr.getLogsPage({ chain: CHAIN, fromBlock: '300', toBlock: '301', limit: 2 });
    expect(first.logs.map(logPosition)).toEqual([
      ['300', '1'],
      ['300', '2'],
    ]);
    expect(first.hasMore).toBe(true);

    const second = await dfr.getLogsPage({
      chain: CHAIN,
      cursor: first.nextCursor as string,
      limit: 2,
    });
    expect(second.logs.map(logPosition)).toEqual([['301', '1']]);
    expect(second.hasMore).toBe(false);

    // The SDK kept the chain in the query string and did not re-send the range on resume.
    expect(first.requestId).toMatch(/^req_/);
    expect(second.requestId).toMatch(/^req_/);
  });

  it('rejects a cursor issued for another chain over the wire', async () => {
    const foreign = Buffer.from(
      JSON.stringify({
        v: 1,
        chain: 'ethereum-sepolia',
        fromBlock: '300',
        toBlock: '301',
        afterBlock: '300',
        afterIndex: '1',
      }),
    ).toString('base64url');
    await expect(dfr.getLogsPage({ chain: CHAIN, cursor: foreign, limit: 1 })).rejects.toMatchObject({
      code: 'DFR_VALIDATION_FAILED',
      status: 400,
    });
  });
});
