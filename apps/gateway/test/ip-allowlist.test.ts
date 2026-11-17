/** ApiKeyScope.ipAllowlist 的 Gateway 执行契约。 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DfrCore } from '@dfr/core';
import { EventBus } from '@dfr/events';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const KEY_ID = 'IpScope1';
const SECRET = 'ipAllowlistSecret0123456789abcdef';
const PEPPER = 'ip-allowlist-pepper';
const KEY_HEADER = { 'x-dfr-key': `dfr_${KEY_ID}_${SECRET}` };

const core = {
  listChains: () => [],
  startHealthChecks: () => ({ started: 0, skipped: 0 }),
  stopHealthChecks: () => undefined,
} as unknown as DfrCore;

let server: Server | undefined;
let baseUrl = '';

async function start(input: {
  readonly ipAllowlist?: readonly string[];
  readonly trustedProxies?: readonly string[];
  readonly eventBus?: boolean;
}): Promise<void> {
  const auth: StaticApiKeyConfig = {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'ip-allowlist-test',
    scope: { chains: '*', capabilities: '*', allowWrite: false, ...(input.ipAllowlist !== undefined ? { ipAllowlist: input.ipAllowlist } : {}) },
  };
  server = createGatewayServer({
    core,
    auth,
    ...(input.trustedProxies !== undefined ? { trustedProxies: input.trustedProxies } : {}),
    ...(input.eventBus ? { eventBus: new EventBus() } : {}),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe('API Key IP allowlist', () => {
  it('非白名单来源在路由执行前被拒绝', async () => {
    await start({ ipAllowlist: ['198.51.100.7'] });
    const response = await fetch(`${baseUrl}/v1/chains`, { headers: KEY_HEADER });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ dfr_code: 'DFR_IP_NOT_ALLOWED' });
  });

  it('仅在直连对端为可信代理时采信 X-Forwarded-For', async () => {
    await start({ ipAllowlist: ['198.51.100.7'], trustedProxies: ['127.0.0.1'] });
    const response = await fetch(`${baseUrl}/v1/chains`, {
      headers: { ...KEY_HEADER, 'x-forwarded-for': '198.51.100.7' },
    });
    expect(response.status).toBe(200);
  });

  it('未配置可信代理时忽略可伪造的 X-Forwarded-For', async () => {
    await start({ ipAllowlist: ['198.51.100.7'] });
    const response = await fetch(`${baseUrl}/v1/chains`, {
      headers: { ...KEY_HEADER, 'x-forwarded-for': '198.51.100.7' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ dfr_code: 'DFR_IP_NOT_ALLOWED' });
  });

  it('指标与 SSE header 鉴权也不能绕过 IP allowlist', async () => {
    await start({ ipAllowlist: ['198.51.100.7'], eventBus: true });
    const metrics = await fetch(`${baseUrl}/metrics`, { headers: KEY_HEADER });
    expect(metrics.status).toBe(403);
    expect(await metrics.json()).toMatchObject({ dfr_code: 'DFR_IP_NOT_ALLOWED' });

    const subscribe = await fetch(`${baseUrl}/v1/events/subscribe`, { headers: KEY_HEADER });
    expect(subscribe.status).toBe(403);
    expect(await subscribe.json()).toMatchObject({ dfr_code: 'DFR_IP_NOT_ALLOWED' });
  });
});
