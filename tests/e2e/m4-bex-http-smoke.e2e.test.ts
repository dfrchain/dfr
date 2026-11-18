/**
 * M4 BEX-facing HTTP smoke test against the real chain (SDK → Gateway → Core → real Base Sepolia).
 *
 * Why a separate layer: `tests/integration/contract-read-account.test.ts` and
 * `logs-reconcile.test.ts` call Core directly, which cannot prove "the path BEX will actually take" --
 * HTTP routing, authentication, capability gating, response envelopes, and JSON serialization. This file pins that path down.
 *
 * Skipped by default; enable explicitly (read-only, no funds/private keys needed):
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL=https://sepolia.base.org \
 *   pnpm vitest run tests/e2e/m4-bex-http-smoke.e2e.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ChainRegistry } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import { EvmAdapter } from '@dfr/adapter-evm';
import { createGatewayServer, hashSecret, TokenBucketLimiter } from '@dfr/gateway';
import { DFR } from '@dfr/sdk-typescript';
import type { Chain, ChainId } from '@dfr/types';
import { createInMemoryTransactionStores } from './support/in-memory-transaction-stores.js';

const RUN = process.env['DFR_RUN_TESTNET'] === '1';
const BASE = process.env['DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL'];
const ENABLED = RUN && BASE !== undefined && BASE !== '';
const CHAIN = 'base-sepolia';
// Base Sepolia Wrapped Ether (a publicly known ERC-20 contract address).
const WETH = '0x4200000000000000000000000000000000000006';
const SECRET = 'm4HttpSmokeSecret0123456789ab';
const PEPPER = 'm4-http-smoke-pepper';
const KEY_ID = 'M4Http01';
const KEY = `dfr_${KEY_ID}_${SECRET}`;

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

function makeCore(): DfrCore {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: BASE ?? 'https://x.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://x.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://y.invalid',
      DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: 'https://s.invalid',
    },
  });
  return new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
    milestone: 'M1',
    transactionStores: createInMemoryTransactionStores(),
  });
}

async function makeClient(): Promise<DFR> {
  const server = createGatewayServer({
    core: makeCore(),
    auth: {
      keyId: KEY_ID,
      currentHash: hashSecret(SECRET, PEPPER),
      pepper: PEPPER,
      projectId: 'm4-http-smoke',
      scope: { chains: '*', capabilities: '*', allowWrite: false },
    },
    limiter: new TokenBucketLimiter({
      read: { capacity: 50, refillPerSecond: 50 },
      write: { capacity: 50, refillPerSecond: 50 },
      stream: { capacity: 50, refillPerSecond: 50 },
    }),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return new DFR({ apiKey: KEY, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 30_000 });
}

describe.skipIf(!ENABLED)('M4 BEX HTTP smoke test against the real chain (read-only)', () => {
  it('GET /v1/accounts/{address}: the Gateway judges WETH a contract and an EOA a regular account', async () => {
    const dfr = await makeClient();
    const contract = await dfr.getAccount({ chain: CHAIN, address: WETH });
    expect(contract.kind).toBe('contract');
    expect(contract.exists).toBe(true);

    const eoa = await dfr.getAccount({
      chain: CHAIN,
      address: '0x0000000000000000000000000000000000000001',
    });
    expect(eoa.kind).toBe('externally-owned');
  }, 40_000);

  it('POST /v1/contracts/read: read WETH.totalSupply() via the Gateway and decode it JSON-safely', async () => {
    const dfr = await makeClient();
    const result = await dfr.readContract({
      chain: CHAIN,
      contract: WETH,
      abi: ['function totalSupply() view returns (uint256)'],
      method: 'totalSupply',
    });
    expect(typeof result.data).toBe('string');
    expect(result.data.startsWith('0x')).toBe(true);
    // bigint must already be normalized to a decimal string, otherwise the Gateway will 500 during JSON serialization.
    expect(typeof result.decoded).toBe('string');
    expect(/^[0-9]+$/.test(result.decoded as string)).toBe(true);
  }, 40_000);

  it('POST /v1/contracts/read: the data path returns raw hex (the shape BEX has when using cast calldata)', async () => {
    const dfr = await makeClient();
    // the totalSupply() selector: 0x18160ddd
    const result = await dfr.readContract({ chain: CHAIN, contract: WETH, data: '0x18160ddd' });
    expect(typeof result.data).toBe('string');
    expect(result.data.startsWith('0x')).toBe(true);
    expect(result.decoded).toBeUndefined();
  }, 40_000);

  it('capability gate: a chain without contract.read enabled returns 422 over HTTP (not 500)', async () => {
    const dfr = await makeClient();
    await expect(
      dfr.readContract({ chain: 'ethereum-sepolia' as ChainId as string, contract: WETH, data: '0x' }),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY', status: 422 });
  }, 40_000);
});
