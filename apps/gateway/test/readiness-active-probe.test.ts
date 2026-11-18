// /readyz active probing contract test (DFR-M1-E02 observability supplement, opt-in).
//
// Background: by default `/readyz` only reads existing circuit-breaker / health state, so a **cold-started** Provider (not yet observed by any probe,
// health=unknown) counts as available → even fully dead endpoints could "falsely report ready".
// With `DFR_READY_ACTIVE_PROBE=true` it probes on the spot instead: available means "it really just answered".
//
// This file uses a real `startGateway` + local RPC endpoint to verify three things:
//   1. Default (off): even when the endpoint is unreachable, the old semantics still decide (regression protection, behavior unchanged);
//   2. After enabling: unreachable endpoint → 503; reachable endpoint → 200;
//   3. The TTL cache takes effect: two consecutive /readyz calls do not each hit RPC.
import { createServer, type Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionStores } from '@dfr/core';
import { hashSecret } from '../src/index.js';
import { GatewayStartupError, startGateway, type GatewayPersistence } from '../src/main.js';

const SECRET = 'activeProbeSecret0123456789abcdef';
const PEPPER = 'active-probe-pepper';

function fakePersistence(): GatewayPersistence {
  return {
    stores: {
      transaction: { listRecoverable: async () => [] as never[] } as unknown as TransactionStores['transaction'],
      idempotency: { pruneExpired: async () => 0 } as unknown as TransactionStores['idempotency'],
      nonce: { releaseExpiredOrphaned: async () => 0 } as unknown as TransactionStores['nonce'],
      tracker: {
        acquire: async () => ({ kind: 'held_by_other' }),
        release: async () => ({ kind: 'released' }),
      } as unknown as TransactionStores['tracker'],
    },
    healthCheck: async () => undefined,
    close: vi.fn(async () => undefined),
  };
}

function baseEnv(rpcPort: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DFR_M0_API_KEY_ID: 'ProbeKey',
    DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
    DFR_M0_API_KEY_PEPPER: PEPPER,
    DFR_GATEWAY_PORT: '0',
    DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
    DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
    DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
    DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
    DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
    ...extra,
  };
}

async function withGateway(
  env: NodeJS.ProcessEnv,
  body: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const app = await startGateway(env, async () => fakePersistence());
  try {
    await body(`http://127.0.0.1:${app.port}`);
  } finally {
    await app.close();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

/** An RPC returning eth_chainId; `calls` records the number of requests received. */
async function startRpc(): Promise<{ port: number; server: Server; calls: () => number }> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result: '0x14a34' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, server, calls: () => count };
}

describe('GET /readyz active probing (DFR-M1-E02 observability supplement)', () => {
  it('after enabling: reachable endpoint → 200 ready, and available means "really answered"', async () => {
    const rpc = await startRpc();
    try {
      await withGateway(baseEnv(rpc.port, { DFR_READY_ACTIVE_PROBE: 'true' }), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/readyz`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          status: string;
          chains: { chain: string; providers: number; available: number }[];
        };
        expect(body.status).toBe('ready');
        const base = body.chains.find((c) => c.chain === 'base-sepolia');
        expect(base).toEqual({ chain: 'base-sepolia', providers: 1, available: 1 });
        expect(rpc.calls()).toBeGreaterThan(0);
      });
    } finally {
      await new Promise<void>((resolve) => rpc.server.close(() => resolve()));
    }
  }, 20_000);

  it('after enabling: unreachable endpoint → 503 (exactly the scenario where the default semantics would falsely report ready)', async () => {
    // Occupy a port and immediately close it, obtaining a "definitely unreachable" address.
    const rpc = await startRpc();
    const deadPort = rpc.port;
    await new Promise<void>((resolve) => rpc.server.close(() => resolve()));

    await withGateway(baseEnv(deadPort, { DFR_READY_ACTIVE_PROBE: 'true' }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/readyz`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as {
        status: string;
        chains: { chain: string; available: number }[];
      };
      expect(body.status).toBe('not_ready');
      // The probe really judges the dead endpoint unavailable (rather than keeping "unknown means available").
      expect(body.chains.find((c) => c.chain === 'base-sepolia')?.available).toBe(0);
    });
  }, 20_000);

  it('keeps the old semantics when off by default (regression protection): does not change the verdict because an endpoint is unreachable', async () => {
    const rpc = await startRpc();
    const deadPort = rpc.port;
    await new Promise<void>((resolve) => rpc.server.close(() => resolve()));

    await withGateway(baseEnv(deadPort), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/readyz`);
      // The old semantics only read existing state: a never-observed Provider counts as available → still ready.
      // This assertion locks in "do not change default behavior", making enabling the new feature an explicit choice.
      expect(response.status).toBe(200);
    });
  }, 20_000);

  it('TTL cache takes effect: two consecutive /readyz calls do not repeatedly saturate RPC', async () => {
    const rpc = await startRpc();
    try {
      await withGateway(
        baseEnv(rpc.port, { DFR_READY_ACTIVE_PROBE: 'true', DFR_READY_PROBE_CACHE_MS: '60000' }),
        async (baseUrl) => {
          const first = await fetch(`${baseUrl}/readyz`);
          expect(first.status).toBe(200);
          const afterFirst = rpc.calls();

          const second = await fetch(`${baseUrl}/readyz`);
          expect(second.status).toBe(200);
          // Cache hit: the second call should produce no new RPC.
          expect(rpc.calls()).toBe(afterFirst);
        },
      );
    } finally {
      await new Promise<void>((resolve) => rpc.server.close(() => resolve()));
    }
  }, 20_000);

  it('an illegal switch value fails closed (not silently treated as off)', async () => {
    await expect(
      startGateway(
        baseEnv(1, { DFR_READY_ACTIVE_PROBE: 'yes' }),
        async () => fakePersistence(),
      ),
    ).rejects.toBeInstanceOf(GatewayStartupError);
  }, 20_000);
});
