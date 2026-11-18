// `core.operation` log contract test (the last layer of observability-spec §4).
//
// In the §4 span hierarchy, http.request / adapter.call / provider.request / store.* already have outlets;
// only core.operation is missing. This file verifies the allowlist mapping and the real wiring.
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { CoreOperationRecord } from '@dfr/core';
import {
  CORE_OPERATION_LOG_EXCLUDED,
  CORE_OPERATION_LOG_FIELDS,
  coreOperationLogFields,
  createCoreOperationLogger,
} from '../src/core-operation-log.js';
import { hashSecret } from '../src/index.js';
import { startGateway } from '../src/main.js';

const RECORD: CoreOperationRecord = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  operation: 'getBlock',
  chain: 'ethereum-sepolia' as never,
  status: 'success',
  latencyMs: 42,
};

describe('core.operation logging (§4)', () => {
  it('field names follow the §3 unified naming, and are tagged span=core.operation', () => {
    const fields = coreOperationLogFields(RECORD);
    expect(fields['request_id']).toBe(RECORD.requestId);
    expect(fields['trace_id']).toBe(RECORD.traceId);
    expect(fields['span_id']).toBe(RECORD.spanId);
    expect(fields['operation']).toBe('getBlock');
    expect(fields['chain']).toBe('ethereum-sepolia');
    expect(fields['status']).toBe('success');
    expect(fields['latency_ms']).toBe(42);
    expect(fields['span']).toBe('core.operation');
    expect(fields['msg']).toBe('core operation');
    expect(fields['level']).toBe('info');
  });

  it('errors are recorded as warn, with a stable error code and classification', () => {
    const fields = coreOperationLogFields({
      ...RECORD,
      status: 'error',
      errorCode: 'DFR_CHAIN_UNAVAILABLE',
      category: 'availability' as never,
    });
    expect(fields['level']).toBe('warn');
    expect(fields['error_code']).toBe('DFR_CHAIN_UNAVAILABLE');
    expect(fields['error_category']).toBe('availability');
  });

  it('every record field is classified (a new field fails this test)', () => {
    const allowlisted = new Set(Object.keys(CORE_OPERATION_LOG_FIELDS));
    const excluded = new Set<string>(CORE_OPERATION_LOG_EXCLUDED);
    const unclassified = Object.keys(RECORD).filter(
      (k) => !allowlisted.has(k) && !excluded.has(k),
    );
    expect(unclassified, 'CoreOperationRecord has an unclassified field').toEqual([]);
  });

  it('the log outlet does not throw', () => {
    const logger = createCoreOperationLogger(() => {
      throw new Error('stdout closed');
    });
    expect(() => logger(RECORD)).not.toThrow();
  });

  it('real startGateway: one on-chain read produces a core.operation log (with no endpoint)', async () => {
    const rpc = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
        const value =
          parsed.method === 'eth_chainId'
            ? '0x14a34'
            : parsed.method === 'eth_getBlockByNumber'
              ? { number: '0x1', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: '0x67f00000', transactions: [] }
              : '0x0';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result: value }));
      });
    });
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    const rpcPort = (rpc.address() as { port: number }).port;

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
          DFR_M0_API_KEY_ID: 'CoreOpK1',
          DFR_M0_API_KEY_HASH: hashSecret('coreOperationLogSecret0123456789', 'p'),
          DFR_M0_API_KEY_PEPPER: 'p',
          DFR_GATEWAY_PORT: '0',
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
          DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
        },
        async () => ({
          stores: {
            transaction: { listRecoverable: async () => [] } as never,
            idempotency: { pruneExpired: async () => 0 } as never,
            nonce: { releaseExpiredOrphaned: async () => 0 } as never,
            tracker: { listRecoverable: async () => [] } as never,
          },
          healthCheck: async () => undefined,
          close: async () => undefined,
        }),
      );

      const response = await fetch(`http://127.0.0.1:${app.port}/v1/chains/base-sepolia`, {
        headers: { 'x-dfr-key': 'dfr_CoreOpK1_coreOperationLogSecret0123456789' },
      });
      expect(response.status).toBe(200);

      const coreLines = lines.filter((l) => l.includes('"core operation"'));
      expect(coreLines.length, lines.join('')).toBeGreaterThan(0);
      const record = JSON.parse(coreLines[0]!.trim()) as Record<string, unknown>;
      expect(record['span']).toBe('core.operation');
      expect(record['operation']).toBe('getInfo');
      expect(record['chain']).toBe('base-sepolia');
      expect(record['latency_ms']).toBeTypeOf('number');
      // Same correlation field as the other layers, so the hierarchy can be rebuilt by trace_id.
      expect(record['request_id']).toBeDefined();
      expect(record['trace_id']).toBeDefined();
      // Redaction: no RPC endpoint may appear.
      expect(JSON.stringify(record)).not.toContain('127.0.0.1');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);
});
