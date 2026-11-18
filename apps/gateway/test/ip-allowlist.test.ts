/** The Gateway enforcement contract for ApiKeyScope.ipAllowlist. */
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
  it('a non-allowlisted source is rejected before route execution', async () => {
    await start({ ipAllowlist: ['198.51.100.7'] });
    const response = await fetch(`${baseUrl}/v1/chains`, { headers: KEY_HEADER });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ dfr_code: 'DFR_IP_NOT_ALLOWED' });
  });

  it('X-Forwarded-For is only trusted when the direct peer is a trusted proxy', async () => {
    await start({ ipAllowlist: ['198.51.100.7'], trustedProxies: ['127.0.0.1'] });
    const response = await fetch(`${baseUrl}/v1/chains`, {
      headers: { ...KEY_HEADER, 'x-forwarded-for': '198.51.100.7' },
    });
    expect(response.status).toBe(200);
  });

  it('a forgeable X-Forwarded-For is ignored when no trusted proxy is configured', async () => {
    await start({ ipAllowlist: ['198.51.100.7'] });
    const response = await fetch(`${baseUrl}/v1/chains`, {
      headers: { ...KEY_HEADER, 'x-forwarded-for': '198.51.100.7' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ dfr_code: 'DFR_IP_NOT_ALLOWED' });
  });

  it('metrics and SSE header auth cannot bypass the IP allowlist either', async () => {
    await start({ ipAllowlist: ['198.51.100.7'], eventBus: true });
    const metrics = await fetch(`${baseUrl}/metrics`, { headers: KEY_HEADER });
    expect(metrics.status).toBe(403);
    expect(await metrics.json()).toMatchObject({ dfr_code: 'DFR_IP_NOT_ALLOWED' });

    const subscribe = await fetch(`${baseUrl}/v1/events/subscribe`, { headers: KEY_HEADER });
    expect(subscribe.status).toBe(403);
    expect(await subscribe.json()).toMatchObject({ dfr_code: 'DFR_IP_NOT_ALLOWED' });
  });
});
