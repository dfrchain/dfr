//
// M1 Trace end-to-end propagation integration test (DFR-M1-D06).
//
// Authoritative sources: the acceptance checklist in chapters 4 and 10 of docs/architecture/observability-spec-v0.1.md
// ("traceparent is traceable across the whole Gateway → Core → Adapter → Provider chain").
//
// This test uses the real Gateway + Core + EVM Adapter + TransactionEngine, replacing only `fetch` at the outermost layer,
// so it verifies **cross-module** pass-through of the correlation fields, not a single function's arguments:
//   1. the client traceparent's trace-id must travel all the way to the Provider egress request headers;
//   2. the Gateway must create a new span for the local request and write back the same trace-id in the response headers;
//   3. an all-zero/invalid traceparent is untrusted: the Gateway rebuilds the trace-id and still propagates it downstream.
//
// Only assert trace-id consistency: a span-id identifies "each outbound call", and the ProviderManager regenerates it for
// each attempt (covered separately by provider.test.ts), so it is not required to match the gateway span.
//
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { createGatewayServer, createCoreTransactionChainPort, hashSecret } from '@dfr/gateway';
import { ChainRegistry } from '@dfr/registry';
import { TransactionEngine } from '@dfr/transaction';
import type { Chain, ChainId, DecimalUint, TransactionId } from '@dfr/types';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN = 'ethereum-sepolia' as ChainId;
const FROM = { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' } as const;
const TO = { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' } as const;
const TRACE_ID = 'a'.repeat(32);
const ZERO_TRACE_ID = '0'.repeat(32);
const SECRET = 'm1TraceIntegrationSecret0123456789';
const PEPPER = 'm1-trace-pepper';
const KEY_ID = 'M1TraceA'; // dfr_<8 chars>_<20..64>

const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
  baseFeePerGas: '0x3b9aca00',
};

/** The traceparent actually carried by each outbound RPC; recorded by the capturing fetch. */
const seenTraceparents: string[] = [];

function resolveValue(method: string, params: readonly unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return '0xaa36a7';
    case 'eth_getTransactionCount':
      return '0x2a';
    case 'eth_estimateGas':
      return '0x5208';
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00';
    case 'eth_getBlockByNumber':
      return BLOCK;
    case 'eth_call':
      return '0x';
    case 'web3_clientVersion':
      return 'stub/1.0.0';
    case 'eth_getTransactionReceipt':
      return { transactionHash: `0x${'aa'.repeat(32)}`, status: '0x1' };
    case 'eth_getTransactionByHash':
      return {
        hash: `0x${'aa'.repeat(32)}`,
        blockNumber: '0x112a87f',
        blockHash: `0x${'11'.repeat(32)}`,
        from: FROM.address,
        to: TO.address,
        value: '0x1',
        gas: '0x5208',
        nonce: '0x2a',
      };
    default:
      void params;
      return null;
  }
}

const capturingFetch: typeof fetch = (async (_input, init) => {
  const headers = new Headers(init?.headers);
  const tp = headers.get('traceparent');
  if (tp !== null) seenTraceparents.push(tp);
  const body = typeof init?.body === 'string' ? init.body : '{}';
  const parsed = JSON.parse(body) as { method?: string; params?: unknown[] };
  const value = resolveValue(parsed.method ?? 'unknown', parsed.params ?? []);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

let server: Server | undefined;
let baseUrl = '';
let engine: TransactionEngine;
let nextTransactionNumber = 1;

const REQUEST = {
  chain: CHAIN,
  from: FROM,
  to: TO,
  value: { asset: { kind: 'native' as const, chain: CHAIN }, amount: '1000' as DecimalUint },
};

beforeAll(async () => {
  const stores = createInMemoryTransactionStores();
  const registry = ChainRegistry.load({
    file: resolve(repoRoot, 'packages/registry/config/chains.yaml'),
    env: {
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://stub.local/sepolia-primary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_KEY: 'stub-credential-primary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://stub.local/sepolia-secondary',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_KEY: 'stub-credential-secondary',
    },
  });
  const core = new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    fetchImpl: capturingFetch,
    transactionStores: stores,
  });
  engine = new TransactionEngine({
    stores: {
      transaction: stores.transaction,
      idempotency: stores.idempotency,
      nonce: stores.nonce,
      tracker: stores.tracker,
    },
    chain: createCoreTransactionChainPort(core),
    newTransactionId: () => `txn_trace_${String(nextTransactionNumber++).padStart(2, '0')}` as TransactionId,
  });
  const created = createGatewayServer({
    core,
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'm1-trace-integration',
      scope: { chains: [CHAIN], capabilities: '*', allowWrite: true },
    },
    allowWrite: true,
    transactions: engine,
  });
  server = created;
  await new Promise<void>((resolveListen) => created.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (!server) return;
  engine.close();
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
});

async function postBuild(traceparent?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`,
    'content-type': 'application/json',
  };
  if (traceparent !== undefined) headers['traceparent'] = traceparent;
  return fetch(`${baseUrl}/v1/transactions/build`, {
    method: 'POST',
    headers,
    body: JSON.stringify(REQUEST),
  });
}

function traceIdOf(traceparent: string): string | null {
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent);
  return match?.[1] ?? null;
}

describe('M1 Trace end-to-end propagation (DFR-M1-D06)', () => {
  it('the client traceparent\'s trace-id travels all the way to the Provider egress, and the response headers write back the same trace-id', async () => {
    seenTraceparents.length = 0;
    const response = await postBuild(`00-${TRACE_ID}-${'b'.repeat(16)}-01`);
    expect(response.status).toBe(200);
    await response.json();

    const outgoing = response.headers.get('traceparent');
    expect(outgoing).not.toBeNull();
    expect(traceIdOf(outgoing!)).toBe(TRACE_ID);

    expect(seenTraceparents.length).toBeGreaterThan(0);
    for (const header of seenTraceparents) {
      expect(traceIdOf(header)).toBe(TRACE_ID);
    }
  });

  it('an all-zero traceparent is untrusted: the gateway rebuilds the trace-id and continues propagating a valid traceparent downstream', async () => {
    seenTraceparents.length = 0;
    const response = await postBuild(`00-${ZERO_TRACE_ID}-${'b'.repeat(16)}-01`);
    expect(response.status).toBe(200);
    await response.json();

    const outgoing = response.headers.get('traceparent');
    expect(outgoing).not.toBeNull();
    const gatewayTraceId = traceIdOf(outgoing!);
    expect(gatewayTraceId).not.toBeNull();
    expect(gatewayTraceId).not.toBe(ZERO_TRACE_ID);

    expect(seenTraceparents.length).toBeGreaterThan(0);
    for (const header of seenTraceparents) {
      expect(traceIdOf(header)).toBe(gatewayTraceId);
    }
  });
});
