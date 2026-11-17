/**
 * `POST /v1/logs` 端点测试（ADR-034）。
 *
 * 用真实 createGatewayServer + 真实 Core + EVM Adapter + stub provider 驱动完整 HTTP 路径。
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

const SECRET = 'logsEndpointSecret0123456789ab';
const PEPPER = 'logs-endpoint-pepper';
const KEY_ID = 'LogsEnd1';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const CHAIN = 'base-sepolia';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

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
      projectId: 'logs-endpoint',
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

async function url(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('POST /v1/logs（ADR-034）', () => {
  it('返回日志列表（映射为 ChainLog）', async () => {
    const server = makeServer([
      { address: '0x1111111111111111111111111111111111111111', topics: ['0xaa'], data: '0x', blockNumber: '0x64', logIndex: '0x1', transactionHash: '0x' + 'ab'.repeat(32) },
    ]);
    const base = await url(server);
    const res = await fetch(`${base}/v1/logs?chain=${CHAIN}`, {
      method: 'POST',
      headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ fromBlock: '90', toBlock: '100' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[]; requestId: string };
    expect(body.logs).toHaveLength(1);
    expect(body.requestId).toMatch(/^req_/);
  });

  it('超区间 → 400 DFR_VALIDATION_FAILED（不静默截断）', async () => {
    const server = makeServer([]);
    const base = await url(server);
    const res = await fetch(`${base}/v1/logs?chain=${CHAIN}`, {
      method: 'POST',
      headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ fromBlock: '1', toBlock: '5000' }),
    });
    // error-spec：DFR_VALIDATION_FAILED = 400（客户端请求不合法）。
    expect(res.status).toBe(400);
    const body = (await res.json()) as { dfr_code: string };
    expect(body.dfr_code).toBe('DFR_VALIDATION_FAILED');
  });

  it('缺 fromBlock/toBlock → 400 校验失败', async () => {
    const server = makeServer([]);
    const base = await url(server);
    for (const payload of [{}, { fromBlock: '1' }, { fromBlock: 'abc', toBlock: '2' }]) {
      const res = await fetch(`${base}/v1/logs?chain=${CHAIN}`, {
        method: 'POST',
        headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    }
  });

  it('未声明该能力的链 → 422 不支持', async () => {
    const server = makeServer([]);
    const base = await url(server);
    // ethereum-sepolia 声明了写能力但未声明 contract.logs → 能力闸门拒绝。
    const res = await fetch(`${base}/v1/logs?chain=ethereum-sepolia`, {
      method: 'POST',
      headers: { 'x-dfr-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ fromBlock: '1', toBlock: '2' }),
    });
    const debugBody = (await res.json()) as { dfr_code?: string; detail?: string };
    expect({ status: res.status, code: debugBody.dfr_code, detail: debugBody.detail }).toEqual({
      status: 422, code: 'DFR_UNSUPPORTED_CAPABILITY', detail: expect.any(String),
    });
  });

  it('未鉴权 → 401', async () => {
    const server = makeServer([]);
    const base = await url(server);
    const res = await fetch(`${base}/v1/logs?chain=${CHAIN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromBlock: '1', toBlock: '2' }),
    });
    expect(res.status).toBe(401);
  });
});
