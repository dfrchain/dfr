/**
 * Event-source wiring test (M2-C03 wrap-up): background `chain.reorg` must really reach the event bus.
 *
 * Why a real `startGateway` is required: the wiring point is in the composition root (the reorg sweep's publish sink),
 * and component-level tests cannot see "whether events really flow from the sweep to subscribers".
 */
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../src/index.js';
import { startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'EvtWire1';
const SECRET = 'sseEventWiringSecret0123456789';
const PEPPER = 'sse-event-wiring-pepper';
const KEY = `dfr_${KEY_ID}_${SECRET}`;
const CHAIN = 'ethereum-sepolia';

const BLOCK = {
  number: '0x10',
  hash: `0x${'aa'.repeat(32)}`,
  parentHash: `0x${'bb'.repeat(32)}`,
  timestamp: '0x67f00000',
  transactions: [],
};

function rpcServer(): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
      // The on-chain canonical hash is 0xaa…, while the record is anchored to 0xcc… → every round is judged a reorg.
      const result = parsed.method === 'eth_chainId' ? '0xaa36a7'
        : parsed.method === 'eth_getBlockByNumber' ? BLOCK
          : '0x0';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
    });
  });
}

function includedRecord(seq: number): Record<string, unknown> {
  return {
    transactionId: `txn_evt_${seq}`,
    projectId: 'default',
    chain: CHAIN,
    requestFingerprint: 'a'.repeat(64),
    status: 'included',
    stateVersion: '4',
    from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
    txHash: `0x${String(seq).padStart(2, '0').repeat(32).slice(0, 64)}`,
    blockRef: { kind: 'number', number: '16' },
    canonicalBlockHash: `0x${'cc'.repeat(32)}`,
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
}

describe('event-source wiring: chain.reorg → SSE (M2-C03)', () => {
  it('subscribers receive the chain.reorg events published by the background sweep', async () => {
    const rpc = rpcServer();
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    const rpcPort = (rpc.address() as { port: number }).port;

    const persistence: GatewayPersistence = {
      stores: {
        transaction: {
          // Only the **reorg sweep** carries `statuses: ['included']`; the startup recovery sweep carries no statuses
          // (the `RecoveryCoordinator.run` call shape). Distinguish by this, so startup recovery does not
          // consume the record we want to observe early (otherwise the test becomes flaky with startup timing).
          // Every round returns the same "reorged" record: whenever a subscriber connects, later rounds still produce events.
          // (Returning it only once would make the test depend on "the subscription happens just before the first sweep round" — the root of the flakiness.)
          listRecoverable: async (input: { statuses?: readonly string[] }) => {
            if (input.statuses?.includes('included') !== true) return [];
            return [includedRecord(1)];
          },
          transition: async () => ({ kind: 'applied', record: includedRecord(1) }),
        } as never,
        idempotency: { pruneExpired: async () => 0 } as never,
        nonce: { releaseExpiredOrphaned: async () => 0 } as never,
        tracker: {
          acquire: async () => ({ kind: 'acquired' }),
          renew: async () => ({ kind: 'renewed' }),
          release: async () => ({ kind: 'released' }),
        } as never,
      },
      healthCheck: async () => undefined,
      close: async () => undefined,
    };

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let app: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      app = await startGateway(
        {
          DFR_M0_API_KEY_ID: KEY_ID,
          DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
          DFR_M0_API_KEY_PEPPER: PEPPER,
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_GATEWAY_PORT: '0',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '1000', // let the sweep run a round soon (without depending on an external trigger)
          DFR_REORG_SWEEP_BATCH: '10',
          DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
          DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: `http://127.0.0.1:${rpcPort}`,
        },
        async () => persistence,
      );

      // Subscribe (header auth path), then trigger one reorg sweep round.
      const controller = new AbortController();
      const res = await fetch(`${app.port ? `http://127.0.0.1:${app.port}` : ''}/v1/events/subscribe?chain=${CHAIN}`, {
        headers: { 'x-dfr-key': KEY },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      // The sweep runs one round per second; every round is judged a reorg and publishes an event, so a subscriber always eventually gets one.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // A single continuous read loop must own the reader. Previously, every second `reader.read()` raced against a timeout
      // Promise; if the timeout won, the leftover read would still consume the chunk when the event arrived,
      // while the test's main loop no longer observed that chunk, causing a false negative of "the log already has the reorg, but the SSE buffer is empty".
      const received = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          controller.abort();
          resolve(false);
        }, 8_000);
        void (async () => {
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) {
                resolve(false);
                return;
              }
              buffer += decoder.decode(chunk.value, { stream: true });
              if (buffer.includes('event: chain.reorg')) {
                resolve(true);
                return;
              }
            }
          } catch {
            // An abort / peer disconnect is not a successful event receipt.
            resolve(false);
          } finally {
            clearTimeout(timeout);
          }
        })();
      });
      await reader.cancel().catch(() => undefined);
      controller.abort();
      expect(received, `expected chain.reorg over SSE, buffer=${buffer.slice(0, 400)}`).toBe(true);
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);
});
