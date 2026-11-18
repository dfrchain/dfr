/**
 * M0 E2E: TypeScript SDK → API Gateway → DFR Core → EVM Adapter → Provider.
 *
 * Drives the whole chain with a programmable Provider stand-in (review fix R-11), so the tests are deterministic, offline, and regression-safe.
 * For the real Sepolia integration test, see tests/integration/ethereum-sepolia.test.ts (must be explicitly enabled).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ChainRegistry } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import { EvmAdapter } from '@dfr/adapter-evm';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '@dfr/gateway';
import { createStubFetch } from '@dfr/provider';
import { DFR, isDfrApiError } from '@dfr/sdk-typescript';

const CHAIN = 'ethereum-sepolia';
const ADDRESS = '0x1111111111111111111111111111111111111111';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const SECRET = 'e2esecrete2esecrete2esecrete2esecret';
const PEPPER = 'e2e-pepper';
const KEY_ID = 'E2eKey01';

const REGISTRY_YAML = `
schemaVersion: "1"
updatedAt: "2026-10-03T00:00:00Z"
chains:
  ethereum-sepolia:
    displayName: "Ethereum Sepolia"
    family: evm
    network: testnet
    externalChainId: "11155111"
    adapter: { id: evm, version: "^0.1.0" }
    finality: { kind: checkpoint, finalizedTag: true }
    finalityStatus: unverified
    capabilities: [account.balance, block.read, transaction.read]
    milestone: M0
providers:
  stub-primary:
    chain: ethereum-sepolia
    kind: json-rpc-http
    endpointRef: "env:STUB_PRIMARY_URL"
    credentialRef: "none"
    priority: 10
    weight: 1
    timeoutMs: 5000
    cost: { unit: request, priceUsd: "0" }
  stub-secondary:
    chain: ethereum-sepolia
    kind: json-rpc-http
    endpointRef: "env:STUB_SECONDARY_URL"
    credentialRef: "none"
    priority: 9
    weight: 1
    timeoutMs: 5000
    cost: { unit: request, priceUsd: "0" }
`;

const BLOCK = {
  number: '0x112a880',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: ['0xaa'],
  baseFeePerGas: '0x3b9aca00',
};

const stubFetch = createStubFetch({
  resolve: ({ method, params }) => {
    switch (method) {
      case 'eth_chainId':
        return { kind: 'result', value: '0xaa36a7' };
      case 'eth_blockNumber':
        return { kind: 'result', value: '0x112a880' };
      case 'web3_clientVersion':
        return { kind: 'result', value: 'geth/v1.14.0-stable/linux-amd64/go1.21' };
      case 'eth_getBlockByNumber':
        return { kind: 'result', value: BLOCK };
      case 'eth_getBalance':
        return { kind: 'result', value: '0xde0b6b3a7640000' };
      case 'eth_getTransactionByHash':
        return {
          kind: 'result',
          value: {
            hash: TX_HASH,
            blockNumber: '0x112a880',
            blockHash: BLOCK.hash,
            from: ADDRESS,
            to: '0x2222222222222222222222222222222222222222',
            value: '0x2386f26fc10000',
            nonce: '0x2a',
            gas: '0x5208',
            gasPrice: '0x3b9aca00',
          },
        };
      case 'eth_getTransactionReceipt':
        return {
          kind: 'result',
          value: {
            transactionHash: TX_HASH,
            blockNumber: '0x112a880',
            blockHash: BLOCK.hash,
            status: '0x1',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x3b9aca00',
          },
        };
      default:
        void params;
        return { kind: 'result', value: null };
    }
  },
});

let server: Server;
let baseUrl = '';
let dfr: DFR;

beforeAll(async () => {
  const registry = ChainRegistry.fromText(REGISTRY_YAML, {
    env: {
      STUB_PRIMARY_URL: 'https://stub.local/stub-primary',
      STUB_SECONDARY_URL: 'https://stub.local/stub-secondary',
    },
    source: 'e2e',
  });

  const core = new DfrCore({
    registry,
    fetchImpl: stubFetch,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) }],
    milestone: 'M0',
  });

  const auth: StaticApiKeyConfig = {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'e2e-project',
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  };

  server = createGatewayServer({ core, auth });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  dfr = new DFR({ apiKey: `dfr_${KEY_ID}_${SECRET}`, baseUrl });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('M0 E2E: SDK → Gateway → Core → EVM Adapter → Provider', () => {
  it('listChains returns the chains enabled in M0', async () => {
    const chains = await dfr.listChains();
    expect(chains.map((c) => c.id)).toEqual([CHAIN]);
  });

  it('getChain returns runtime chain info', async () => {
    const info = await dfr.getChain(CHAIN);
    expect(info.chain).toBe(CHAIN);
    expect(info.height).toBe('18000000');
    expect(info.requestId).toMatch(/^req_/);
  });

  it('getBalance returns the native balance (one API, no need to care about RPC)', async () => {
    const balance = await dfr.getBalance({ chain: CHAIN, account: ADDRESS });
    expect(balance.amount).toBe('1000000000000000000');
    expect(balance.decimals).toBe(18);
  });

  it('getBlock supports tag syntax', async () => {
    const block = await dfr.getBlock({ chain: CHAIN, blockRef: 'tag:latest' });
    expect(block.number).toBe('18000000');
    expect(block.transactionCount).toBe(1);
  });

  it('getTransaction and getReceipt go through the same chain', async () => {
    const tx = await dfr.getTransaction({ chain: CHAIN, txHash: TX_HASH });
    expect(tx.status).toBe('included');

    const receipt = await dfr.getReceipt({ chain: CHAIN, txHash: TX_HASH });
    expect(receipt?.success).toBe(true);
  });
});

describe('E2E: gateway cross-cutting concerns', () => {
  it('missing API Key → 401 DFR_UNAUTHENTICATED, and the response is an RFC 9457 envelope', async () => {
    const response = await fetch(`${baseUrl}/v1/chains`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['dfr_code']).toBe('DFR_UNAUTHENTICATED');
    expect(body['request_id']).toMatch(/^req_/);
    expect(response.headers.get('x-request-id')).toBe(body['request_id']);
  });

  it('an externally supplied valid X-Request-Id is reused, an invalid one is replaced', async () => {
    const supplied = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN';
    const echoed = await fetch(`${baseUrl}/v1/chains`, {
      headers: { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`, 'x-request-id': supplied },
    });
    expect(echoed.headers.get('x-request-id')).toBe(supplied);

    const replaced = await fetch(`${baseUrl}/v1/chains`, {
      headers: { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}`, 'x-request-id': 'garbage' },
    });
    expect(replaced.headers.get('x-request-id')).not.toBe('garbage');
    expect(replaced.headers.get('x-request-id')).toMatch(/^req_/);
  });

  it('unknown chain → 404, and the error body contains no credentials', async () => {
    const response = await fetch(`${baseUrl}/v1/chains/no-such-chain`, {
      headers: { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` },
    });
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain('DFR_NOT_FOUND');
    expect(text).not.toContain(SECRET);
  });

  it('invalid blockRef → 400 DFR_VALIDATION_FAILED', async () => {
    const response = await fetch(`${baseUrl}/v1/blocks/123?chain=${CHAIN}`, {
      headers: { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { dfr_code?: string; details?: { fields?: string[] } };
    expect(body.dfr_code).toBe('DFR_VALIDATION_FAILED');
    expect(body.details?.fields).toContain('blockRef');
  });

  it('the SDK maps errors to DfrApiError and keeps retryable / requestId', async () => {
    const bad = new DFR({ apiKey: `dfr_${KEY_ID}_wrongwrongwrongwrongwrongwrong`, baseUrl });
    try {
      await bad.listChains();
      throw new Error('expected failure');
    } catch (err) {
      expect(isDfrApiError(err)).toBe(true);
      if (isDfrApiError(err)) {
        expect(err.code).toBe('DFR_UNAUTHENTICATED');
        expect(err.status).toBe(401);
        expect(err.requestId).toMatch(/^req_/);
      }
    }
  });

  it('/healthz needs no authentication (ops probe, not part of the public API)', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
  });
});
