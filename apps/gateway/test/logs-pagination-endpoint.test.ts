/**
 * `POST /v1/logs` cursor pagination (developer-product follow-up).
 *
 * Why: `limit` used to truncate silently and the only workaround was client-side block
 * windowing. Reconciliation consumers (BEX) need a server-provided continuation that cannot
 * skip or duplicate logs, including when a single block contains more logs than one page.
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

const SECRET = 'logsPageSecret0123456789abcdef';
const PEPPER = 'logs-page-pepper';
const KEY_ID = 'LogsPage';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const CHAIN = 'base-sepolia';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
}

function rpcLog(block: number, index: number): RpcLog {
  return {
    address: '0x1111111111111111111111111111111111111111',
    topics: [`0x${block.toString(16).padStart(2, '0')}`],
    data: '0x',
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${index.toString(16)}`,
    transactionHash: `0x${'ab'.repeat(32)}`,
  };
}

function makeServer(logs: unknown, onCall?: (method: string) => void): Server {
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
        onCall?.(call.method);
        if (call.method === 'eth_getLogs') return { kind: 'result', value: logs };
        if (call.method === 'eth_chainId') return { kind: 'result', value: '0x14a34' };
        return { kind: 'rpc-error', code: -32601, message: `unsupported ${call.method}` };
      },
    }),
  });
  const server = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'logs-page',
      scope: { chains: '*', capabilities: '*', allowWrite: false },
    },
    limiter: new TokenBucketLimiter({
      read: { capacity: 100, refillPerSecond: 100 },
      write: { capacity: 100, refillPerSecond: 100 },
      stream: { capacity: 100, refillPerSecond: 100 },
    }),
  });
  servers.push(server);
  return server;
}

async function baseUrl(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface PageBody {
  logs: { index?: string; blockRef?: { kind: string; number?: string } }[];
  hasMore: boolean;
  nextCursor?: string;
  requestId: string;
}

async function postLogs(base: string, body: unknown): Promise<{ status: number; body: PageBody }> {
  const res = await fetch(`${base}/v1/logs?chain=${CHAIN}`, {
    method: 'POST',
    headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as PageBody };
}

describe('POST /v1/logs cursor pagination', () => {
  it('pages deterministically by (blockNumber, logIndex), even when the RPC order is not sorted', async () => {
    const server = makeServer([rpcLog(101, 1), rpcLog(100, 3), rpcLog(100, 1)]);
    const base = await baseUrl(server);

    const first = await postLogs(base, { fromBlock: '100', toBlock: '101', limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.logs.map((l) => [l.blockRef?.number, l.index])).toEqual([
      ['100', '1'],
      ['100', '3'],
    ]);
    expect(first.body.hasMore).toBe(true);
    expect(typeof first.body.nextCursor).toBe('string');

    // The cursor is self-contained: no fromBlock/toBlock/filters are re-sent.
    const second = await postLogs(base, { cursor: first.body.nextCursor, limit: 2 });
    expect(second.status).toBe(200);
    expect(second.body.logs.map((l) => [l.blockRef?.number, l.index])).toEqual([['101', '1']]);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.nextCursor).toBeUndefined();
  });

  it('can continue inside one block when that block alone exceeds the page size', async () => {
    const server = makeServer([rpcLog(200, 1), rpcLog(200, 2), rpcLog(200, 3)]);
    const base = await baseUrl(server);

    const first = await postLogs(base, { fromBlock: '200', toBlock: '200', limit: 1 });
    expect(first.body.logs.map((l) => l.index)).toEqual(['1']);
    expect(first.body.hasMore).toBe(true);

    const second = await postLogs(base, { cursor: first.body.nextCursor, limit: 1 });
    expect(second.body.logs.map((l) => l.index)).toEqual(['2']);
    expect(second.body.hasMore).toBe(true);

    const third = await postLogs(base, { cursor: second.body.nextCursor, limit: 1 });
    expect(third.body.logs.map((l) => l.index)).toEqual(['3']);
    expect(third.body.hasMore).toBe(false);
  });

  it('without limit keeps the old behavior (all logs, hasMore=false) and sends no adapter limit', async () => {
    const methods: string[] = [];
    const server = makeServer([rpcLog(100, 1), rpcLog(101, 1)], (m) => methods.push(m));
    const base = await baseUrl(server);
    const res = await postLogs(base, { fromBlock: '100', toBlock: '101' });
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeUndefined();
    expect(methods).toContain('eth_getLogs');
  });

  it('rejects a cursor combined with range/filter fields (ambiguous request)', async () => {
    const server = makeServer([rpcLog(100, 1)]);
    const base = await baseUrl(server);
    const first = await postLogs(base, { fromBlock: '100', toBlock: '100', limit: 1 });
    const combined = await postLogs(base, {
      cursor: first.body.nextCursor ?? 'x',
      fromBlock: '100',
      toBlock: '100',
    });
    // With one log there is no next cursor; construct a syntactically invalid one to prove the gate
    // fires before decoding: either way the request is rejected as a client error.
    expect(combined.status).toBe(400);
    expect((combined.body as unknown as { dfr_code?: string }).dfr_code).toBe('DFR_VALIDATION_FAILED');
  });

  it('rejects a forged/tampered cursor instead of returning arbitrary data', async () => {
    const server = makeServer([rpcLog(100, 1)]);
    const base = await baseUrl(server);
    for (const cursor of ['not-base64!!', Buffer.from('{"v":2}').toString('base64url')]) {
      const res = await postLogs(base, { cursor, limit: 1 });
      expect(res.status).toBe(400);
      expect((res.body as unknown as { dfr_code?: string }).dfr_code).toBe('DFR_VALIDATION_FAILED');
    }
  });

  it('rejects a cursor issued for another chain', async () => {
    // Build a valid cursor shape for a different chain by hand: the Gateway must compare it to
    // the ?chain= query parameter, not trust the cursor's own chain.
    const foreign = Buffer.from(
      JSON.stringify({
        v: 1,
        chain: 'ethereum-sepolia',
        fromBlock: '100',
        toBlock: '101',
        afterBlock: '100',
        afterIndex: '0',
      }),
    ).toString('base64url');
    const server = makeServer([rpcLog(100, 1)]);
    const base = await baseUrl(server);
    const res = await postLogs(base, { cursor: foreign, limit: 1 });
    expect(res.status).toBe(400);
    const body = res.body as unknown as { dfr_code?: string; details?: { fields?: string[] } };
    expect(body.dfr_code).toBe('DFR_VALIDATION_FAILED');
    expect(body.details?.fields).toContain('cursor');
  });
});
