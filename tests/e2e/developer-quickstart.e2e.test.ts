/**
 * Developer-product E2E: the exact path a first integration team takes.
 *
 * Chain: real Gateway → Core → EVM Adapter → stub Provider; the quickstart examples are executed
 * as real child processes (`node --experimental-strip-types`), exactly as a developer would run them.
 * This is deliberately not a mock: if the examples drift from the SDK/HTTP contract, this fails.
 */
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ChainRegistry } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import { EvmAdapter } from '@dfr/adapter-evm';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '@dfr/gateway';
import { createStubFetch } from '@dfr/provider';
import { EventBus } from '@dfr/events';
import { SseTicketStore } from '../../apps/gateway/src/sse-ticket.js';
import { DFR } from '@dfr/sdk-typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN = 'ethereum-sepolia';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const SECRET = 'devProductE2eSecret0123456789ab';
const PEPPER = 'dev-product-e2e-pepper';
const KEY_ID = 'DevProd1';
const KEY = `dfr_${KEY_ID}_${SECRET}`;

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
  resolve: ({ method }) => {
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
            from: ACCOUNT,
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
        return { kind: 'result', value: null };
    }
  },
});

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const registry = ChainRegistry.fromText(REGISTRY_YAML, {
    env: {
      STUB_PRIMARY_URL: 'https://stub.local/stub-primary',
      STUB_SECONDARY_URL: 'https://stub.local/stub-secondary',
    },
    source: 'developer-product-e2e',
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
    projectId: 'developer-product',
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  };
  server = createGatewayServer({
    core,
    auth,
    eventBus: new EventBus(),
    sseTickets: new SseTicketStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('developer quickstart examples', () => {
  it('runs every quickstart example end to end and prints no credential', async () => {
    // Async spawn, not execFileSync: the Gateway lives in this process, so blocking the event
    // loop would make the child's HTTP request time out.
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-strip-types',
          '--experimental-transform-types',
          '--import',
          './scripts/ts-runtime/register.mjs',
          'examples/quickstart/run-all.ts',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            DFR_API_KEY: KEY,
            DFR_BASE_URL: baseUrl,
            DFR_EXAMPLE_CHAIN: CHAIN,
            DFR_EXAMPLE_ACCOUNT: ACCOUNT,
            DFR_EXAMPLE_TX: TX_HASH,
            DFR_EXAMPLE_WAIT_MS: '400',
          },
        },
        (error, stdout) => {
          if (error !== null) reject(error);
          else resolve(stdout);
        },
      );
    });

    expect(output).toContain('All quickstart examples completed.');
    expect(output).toContain('ethereum-sepolia');
    expect(output).toContain('1000000000000000000');
    expect(output).toContain('DFR_VALIDATION_FAILED');
    expect(output).toContain('"byRoute"');
    expect(output).toContain('Stream established');
    // Security negative control: neither the secret nor the full key is ever printed.
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(KEY);
  }, 90_000);
});

describe('usage over real HTTP (SDK)', () => {
  it('counts authenticated calls and excludes the usage read itself', async () => {
    const dfr = new DFR({ apiKey: KEY, baseUrl });
    await dfr.listChains();
    await dfr.listChains();
    const usage = await dfr.getUsage();
    expect(usage.projectId).toBe('developer-product');
    expect(usage.requests.byRoute['listChains']).toBeGreaterThanOrEqual(2);
    expect(usage.requests.byRoute['getUsage']).toBeUndefined();
    expect(usage.limits.scope.allowWrite).toBe(false);
    // The same call over raw HTTP must agree with the SDK view.
    const raw = (await (
      await fetch(`${baseUrl}/v1/usage`, { headers: { 'x-dfr-key': KEY } })
    ).json()) as { requests: { total: number } };
    expect(raw.requests.total).toBeGreaterThanOrEqual(usage.requests.total);
  });
});
