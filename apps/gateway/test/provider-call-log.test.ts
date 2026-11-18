// Provider call structured-log contract test (DFR-M1-E02 observability supplement).
//
// This is a **redaction guardrail** test: it does not care whether logs look nice, only "which fields may enter production logs".
// Once `@dfr/provider`'s `ProviderCallRecord` gains a field that nobody adds to the allowlist or exclusion list,
// this test fails, forcing a human to judge whether the field may enter logs.
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderCallRecord } from '@dfr/provider';
import {
  PROVIDER_CALL_LOG_EXCLUDED,
  PROVIDER_CALL_LOG_FIELDS,
  createProviderCallLogger,
  providerCallLogFields,
} from '../src/provider-call-log.js';
import { hashSecret } from '../src/index.js';
import { startGateway } from '../src/main.js';

const RECORD: ProviderCallRecord = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  chain: 'ethereum-sepolia' as never,
  network: 'testnet',
  providerId: 'ethereum-sepolia-primary',
  providerKind: 'json-rpc-http',
  method: 'eth_getBalance',
  methodClass: 'read',
  latencyMs: 42,
  status: 'success',
  retryCount: 0,
  circuitState: 'closed',
  scoreAtCall: 87,
  failover: false,
};

describe('Provider call structured logging (DFR-M1-E02)', () => {
  it('field names follow the unified snake_case naming in observability-spec chapter 3', () => {
    const fields = providerCallLogFields(RECORD);
    expect(fields['request_id']).toBe(RECORD.requestId);
    expect(fields['trace_id']).toBe(RECORD.traceId);
    expect(fields['span_id']).toBe(RECORD.spanId);
    expect(fields['provider_id']).toBe(RECORD.providerId);
    expect(fields['method']).toBe('eth_getBalance');
    expect(fields['method_class']).toBe('read');
    expect(fields['status']).toBe('success');
    expect(fields['latency_ms']).toBe(42);
    expect(fields['retry_count']).toBe(0);
    expect(fields['circuit_state']).toBe('closed');
    expect(fields['score_at_call']).toBe(87);
    expect(fields['chain']).toBe('ethereum-sepolia');
    expect(fields['msg']).toBe('provider call');
    expect(fields['level']).toBe('info');
  });

  it('every record field must be explicitly classified as "loggable" or "deliberately excluded" (a new field fails this test)', () => {
    const allowlisted = new Set(Object.keys(PROVIDER_CALL_LOG_FIELDS));
    const excluded = new Set<string>(PROVIDER_CALL_LOG_EXCLUDED);
    const unclassified = Object.keys(RECORD).filter(
      (key) => !allowlisted.has(key) && !excluded.has(key),
    );
    expect(
      unclassified,
      'ProviderCallRecord has an unclassified field: judge whether it may be logged, and update the allowlist or exclusion list',
    ).toEqual([]);
  });

  it('failed calls are recorded as warn, with a stable error code', () => {
    const fields = providerCallLogFields({
      ...RECORD,
      status: 'error',
      errorCode: 'DFR_PROVIDER_UNAVAILABLE',
      retryCount: 2,
      failover: true,
    });
    expect(fields['level']).toBe('warn');
    expect(fields['error_code']).toBe('DFR_PROVIDER_UNAVAILABLE');
    expect(fields['retry_count']).toBe(2);
    expect(fields['failover']).toBe(true);
  });

  it('non-allowlisted fields (endpoints / credentials / request bodies) never enter logs', () => {
    // Simulate the worst case of "a sensitive field is added to ProviderCallRecord in the future": the runtime really carries those keys.
    const polluted = {
      ...RECORD,
      endpoint: 'https://rpc.example.invalid/v3?apikey=SUPERSECRET',
      credential: 'SUPERSECRET',
      requestBody: '{"method":"eth_sendRawTransaction","params":["0xdeadbeef"]}',
    } as unknown as ProviderCallRecord;

    const fields = providerCallLogFields(polluted);
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('rpc.example.invalid');
    expect(serialized).not.toContain('0xdeadbeef');
    expect(fields).not.toHaveProperty('endpoint');
    expect(fields).not.toHaveProperty('credential');
    expect(fields).not.toHaveProperty('request_body');
  });

  it('the log outlet does not throw: observability failures must not affect the observed call path', () => {
    const logger = createProviderCallLogger(() => {
      throw new Error('stdout closed');
    });
    expect(() => logger(RECORD)).not.toThrow();
  });

  it('createProviderCallLogger outputs single-line JSON (so log collectors can parse line by line)', () => {
    const write = vi.fn();
    createProviderCallLogger(write)(RECORD);
    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0]?.[0] as string;
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({ msg: 'provider call', provider_id: RECORD.providerId });
  });

  it('real startGateway wires onProviderCall: one on-chain query writes a redacted call log', async () => {
    // End-to-end wiring check: start a local minimal JSON-RPC endpoint and let base-sepolia's block.read
    // really reach the Provider, asserting that the composition root wrote the call record as a structured log.
    const rpcServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
        const value =
          parsed.method === 'eth_chainId' ? '0x14a34' : parsed.method === 'eth_blockNumber' ? '0x1' : '0x0';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result: value }));
      });
    });
    await new Promise<void>((resolve) => rpcServer.listen(0, '127.0.0.1', resolve));
    const rpcPort = (rpcServer.address() as { port: number }).port;

    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let app: Awaited<ReturnType<typeof startGateway>> | undefined;
    try {
      // base-sepolia is an M1 chain and is only enabled when M1 is on (otherwise /v1/chains/base-sepolia is 404).
      // Persistence uses a minimal fake stand-in: this case only cares about Provider call logs, not transaction storage.
      app = await startGateway(
        {
          DFR_M0_API_KEY_ID: 'LogKey01',
          DFR_M0_API_KEY_HASH: hashSecret('providerCallLogSecret0123456789', 'p'),
          DFR_M0_API_KEY_PEPPER: 'p',
          DFR_GATEWAY_PORT: '0',
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
          DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
          DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${rpcPort}`,
        },
        async () => ({
          stores: {
            transaction: { listRecoverable: async () => [] } as never,
            idempotency: { pruneExpired: async () => 0 } as never,
            nonce: { releaseExpiredOrphaned: async () => 0 } as never,
            tracker: {
              acquire: async () => ({ kind: 'held_by_other' }),
              release: async () => ({ kind: 'released' }),
            } as never,
          },
          healthCheck: async () => undefined,
          close: async () => undefined,
        }),
      );

      const response = await fetch(`http://127.0.0.1:${app.port}/v1/chains/base-sepolia`, {
        headers: { 'x-dfr-key': 'dfr_LogKey01_providerCallLogSecret0123456789' },
      });
      expect(response.status).toBe(200);

      const callLines = lines.filter((line) => line.includes('"provider call"'));
      expect(callLines.length, `expected provider call logs, got: ${lines.join('')}`).toBeGreaterThan(0);
      const record = JSON.parse(callLines[0]!.trim()) as Record<string, unknown>;
      expect(record['msg']).toBe('provider call');
      expect(record['provider_id']).toBe('base-sepolia-primary');
      expect(record['method']).toBeDefined();
      expect(record['latency_ms']).toBeTypeOf('number');
      // Redaction: even when the endpoint carries credentials, logs may only show the logical Provider ID, never a URL.
      expect(JSON.stringify(record)).not.toContain('127.0.0.1');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);
});
