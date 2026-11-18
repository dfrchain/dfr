// Monotonicity of reorg event cursors across sweep rounds (ADR-006 / ChainEvent.cursor).
//
// Why a real startGateway is required: the defect is not inside `ReorgReconciler`, but in the **wiring** —
// the Gateway's `reconcile` does `new ReorgReconciler(...)` every round, while the cursor is an instance field,
// so every round restarts from 1. Component-level tests (reorg.test.ts) only ever new one instance, so they cannot see it.
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { hashSecret } from '../src/index.js';
import { startGateway, type GatewayPersistence } from '../src/main.js';

const KEY_ID = 'CursorKy';
const SECRET = 'reorgCursorMonotonicSecret0123456789';
const PEPPER = 'cursor-pepper';
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
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
      // The transaction-anchored canonical hash is 0xcc…, while the chain now returns 0xaa…,
      // so every sweep round judges it a reorg and rolls back the record.
      const result =
        parsed.method === 'eth_chainId'
          ? '0xaa36a7'
          : parsed.method === 'eth_getBlockByNumber'
            ? BLOCK
            : '0x0';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result }));
    });
  });
}

/** One included record; every round "discovers a reorg" and rolls it back. */
function includedRecord(seq: number): Record<string, unknown> {
  return {
    transactionId: `txn_cursor_${seq}`,
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

describe('reorg event cursors monotonic across rounds (DFR-M1-D04 reinforcement)', () => {
  it('event cursors published by two sweep rounds must strictly increase (the current implementation repeats 1)', async () => {
    const rpc = rpcServer();
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    const rpcPort = (rpc.address() as { port: number }).port;

    // Each sweep round returns a new included record, guaranteeing one event per round.
    let served = 0;
    const persistence: GatewayPersistence = {
      stores: {
        transaction: {
          listRecoverable: async (input: { statuses?: readonly string[] }) => {
            if (input.statuses?.includes('included') !== true) return [];
            served += 1;
            if (served > 2) return [];
            return [includedRecord(served)];
          },
          transition: async () => ({ kind: 'applied', record: includedRecord(served) }),
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

    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
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
          DFR_REORG_SWEEP_INTERVAL_MS: '1000',
          DFR_REORG_SWEEP_BATCH: '10',
          DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
          DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: `http://127.0.0.1:${rpcPort}`,
        },
        async () => persistence,
      );
      // Wait for two sweep rounds (1s apart).
      await new Promise((resolve) => setTimeout(resolve, 2_600));

      const cursors = lines
        .map((line) => {
          try {
            return JSON.parse(line) as { msg?: string; cursor?: unknown };
          } catch {
            return undefined;
          }
        })
        .filter((entry): entry is { msg?: string; cursor?: unknown } => entry?.msg === 'chain.reorg')
        .map((entry) => String(entry.cursor));

      expect(cursors.length, `expected >= 2 reorg events, got: ${lines.join('')}`).toBeGreaterThanOrEqual(2);
      // Convert to numbers before string comparison: ADR-006 requires cursors to increase monotonically.
      for (let i = 1; i < cursors.length; i += 1) {
        expect(
          Number(cursors[i]),
          `cursors must strictly increase, actually ${JSON.stringify(cursors)}`,
        ).toBeGreaterThan(Number(cursors[i - 1]));
      }
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);
});
