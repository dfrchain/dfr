// Operations probe contract test (DFR-M1-E02).
//
// Authoritative source: docs/architecture/observability-spec-v0.1.md chapter 9 —
//   GET /healthz  process alive (dependencies not checked)
//   GET /readyz   ready: Registry loaded, at least one Provider available, no configuration errors
// And requires the two to be **kept separate**: when a dependency fails, the process stays alive but accepts no traffic.
//
// This test only cares about the Gateway's responsibility: aggregating Core's readiness report with the optional dependency probe (DB)
// into 200/503, without leaking endpoints, credentials, or high-cardinality fields.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DfrCore } from '@dfr/core';
import { createGatewayServer, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const KEY_ID = 'ReadyKey';
const SECRET = 'readinessProbeSecret0123456789abc';
const PEPPER = 'readiness-pepper';

function auth(): StaticApiKeyConfig {
  return {
    keyId: KEY_ID,
    currentHash: hashSecret(SECRET, PEPPER),
    pepper: PEPPER,
    projectId: 'readiness',
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  };
}

interface FakeReadiness {
  ready: boolean;
  chains: { chain: string; providers: number; available: number }[];
}

/** Only implement the surface the probe uses: listChains / readiness / health-check switches. */
function fakeCore(readiness: FakeReadiness): DfrCore {
  return {
    listChains: () => [],
    readiness: () => readiness,
    startHealthChecks: () => ({ started: [], skipped: [] }),
    stopHealthChecks: () => undefined,
  } as unknown as DfrCore;
}

let server: Server | undefined;
let baseUrl = '';

async function start(options: {
  readiness: FakeReadiness;
  readyCheck?: () => Promise<void>;
}): Promise<void> {
  server = createGatewayServer({
    core: fakeCore(options.readiness),
    auth: auth(),
    ...(options.readyCheck !== undefined ? { readyCheck: options.readyCheck } : {}),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

const READY: FakeReadiness = {
  ready: true,
  chains: [{ chain: 'ethereum-sepolia', providers: 2, available: 2 }],
};
const NOT_READY: FakeReadiness = {
  ready: false,
  chains: [{ chain: 'ethereum-sepolia', providers: 2, available: 0 }],
};

describe('GET /readyz (DFR-M1-E02)', () => {
  it('returns 200 ready when ready, with no API Key needed (a probe must not be blocked by auth)', async () => {
    await start({ readiness: READY });
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ready');
    expect(body['chains']).toEqual([{ chain: 'ethereum-sepolia', providers: 2, available: 2 }]);
  });

  it('returns 503 not_ready when no Provider is available', async () => {
    await start({ readiness: NOT_READY });
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('not_ready');
    expect(body['chains']).toEqual([{ chain: 'ethereum-sepolia', providers: 2, available: 0 }]);
  });

  it('returns 503 when the dependency probe fails (e.g. database unreachable), even if the Registry and Providers are fine', async () => {
    await start({
      readiness: READY,
      readyCheck: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.9:5432?password=do-not-leak');
      },
    });
    const response = await fetch(`${baseUrl}/readyz`);

    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(JSON.parse(raw)).toMatchObject({ status: 'not_ready', stores: 'unavailable' });
    // Raw dependency error text must not be echoed (it may contain a DSN / password).
    expect(raw).not.toContain('do-not-leak');
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toContain('10.0.0.9');
  });

  it('health and readiness checks must be separate: /healthz stays 200 when not ready', async () => {
    await start({ readiness: NOT_READY });

    const live = await fetch(`${baseUrl}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: 'ok' });

    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(503);
  });

  it('when no transaction store is configured, stores=not_configured, without affecting M0 read-only readiness', async () => {
    await start({ readiness: READY });
    const response = await fetch(`${baseUrl}/readyz`);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['stores']).toBe('not_configured');
    expect(response.status).toBe(200);
  });

  it('the readiness probe leaks no credentials, and does not write probe results into log fields', async () => {
    const info = vi.fn();
    server = createGatewayServer({
      core: fakeCore(NOT_READY),
      auth: auth(),
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    expect(JSON.stringify(info.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(info.mock.calls)).not.toContain(PEPPER);
  });
});
