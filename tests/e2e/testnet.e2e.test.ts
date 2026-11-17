/**
 * 真实测试网 E2E：SDK →（真实 HTTP）→ Gateway → Core → EVM Adapter → 真实 Sepolia RPC。
 *
 * 与 gateway.e2e.test.ts 的区别：那里用可编程替身保证确定性，这里**真的发网络请求**。
 * 因此默认跳过，只在显式开启时运行：
 *
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL=https://… \
 *   DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL=https://… \
 *   pnpm vitest run tests/e2e/testnet.e2e.test.ts
 *
 * 全程只读：不签名、不广播。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ChainRegistry } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import { EvmAdapter } from '@dfr/adapter-evm';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '@dfr/gateway';
import { DFR } from '@dfr/sdk-typescript';

const ENABLED =
  process.env['DFR_RUN_TESTNET'] === '1' &&
  (process.env['DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL'] ?? '') !== '';

const CHAIN = 'ethereum-sepolia';
const SECRET = 'testnetE2EsecrettestnetE2Esecret01';
const PEPPER = 'testnet-e2e-pepper';
const KEY_ID = 'TnKey001';

let server: Server;
let baseUrl = '';
let dfr: DFR;

beforeAll(async () => {
  if (!ENABLED) return;
  const registry = ChainRegistry.load();
  const core = new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) }],
    milestone: 'M0',
  });
  const auth: StaticApiKeyConfig = {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'testnet-e2e',
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  };
  server = createGatewayServer({ core, auth });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dfr = new DFR({ apiKey: `dfr_${KEY_ID}_${SECRET}`, baseUrl, timeoutMs: 30_000 });
});

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(!ENABLED)('真实 Sepolia E2E（HTTP 全链路）', () => {
  it('鉴权后的 /v1/chains 返回启用的链', async () => {
    const chains = await dfr.listChains();
    expect(chains.map((c) => c.id)).toContain(CHAIN);
  }, 30_000);

  it('getChain 返回真实高度', async () => {
    const info = await dfr.getChain(CHAIN);
    expect(info.chain).toBe(CHAIN);
    expect(BigInt(info.height ?? '0')).toBeGreaterThan(0n);
  }, 30_000);

  it('getBalance 返回十进制余额', async () => {
    const balance = await dfr.getBalance({
      chain: CHAIN,
      account: '0x0000000000000000000000000000000000000000',
    });
    expect(balance.amount).toMatch(/^[0-9]+$/);
  }, 30_000);

  it('getBlock(tag:finalized) 返回已最终化区块', async () => {
    const block = await dfr.getBlock({ chain: CHAIN, blockRef: 'tag:finalized' });
    expect(block.finality).toBe('finalized');
    expect(block.hash).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 30_000);

  it('未鉴权请求被拒绝，且错误体是 RFC 9457 封套', async () => {
    const response = await fetch(`${baseUrl}/v1/chains`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { dfr_code?: string; request_id?: string };
    expect(body.dfr_code).toBe('DFR_UNAUTHENTICATED');
    expect(body.request_id).toMatch(/^req_/);
  }, 30_000);
});

describe.skipIf(ENABLED)('真实测试网 E2E（未启用）', () => {
  it('默认跳过：设置 DFR_RUN_TESTNET=1 与 RPC 端点后运行', () => {
    expect(ENABLED).toBe(false);
  });
});
