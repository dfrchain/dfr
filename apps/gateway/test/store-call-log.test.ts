// Store call structured-log contract test (observability-spec chapter 4 store.read / store.write).
//
// Isomorphic to the provider / adapter log tests: allowlist guardrail + real composition-root wiring.
// Store calls are produced by the port-layer wrapper inside `TransactionEngine` (a single implementation point), so this mainly verifies
// "the allowlist is correct" and "a real request produces records", without repeating the engine-side behavior tests.
import { describe, expect, it, vi } from 'vitest';
import type { StoreCallRecord } from '@dfr/transaction';
import {
  STORE_CALL_LOG_EXCLUDED,
  STORE_CALL_LOG_FIELDS,
  createStoreCallLogger,
  storeCallLogFields,
} from '../src/store-call-log.js';
import { createGatewayServer, hashSecret } from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const RECORD: StoreCallRecord = {
  store: 'transaction',
  operation: 'create',
  kind: 'write',
  status: 'success',
  latencyMs: 3,
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
};

describe('Store call structured logging (observability-spec §4)', () => {
  it('field names follow the unified naming in observability-spec chapter 3, with store.read/write span names', () => {
    const fields = storeCallLogFields(RECORD);
    expect(fields['request_id']).toBe(RECORD.requestId);
    expect(fields['trace_id']).toBe(RECORD.traceId);
    expect(fields['span_id']).toBe(RECORD.spanId);
    expect(fields['store']).toBe('transaction');
    expect(fields['operation']).toBe('create');
    expect(fields['kind']).toBe('write');
    expect(fields['span']).toBe('store.write');
    expect(fields['latency_ms']).toBe(3);
    expect(fields['status']).toBe('success');
    expect(fields['msg']).toBe('store call');
    expect(fields['level']).toBe('info');

    // Read operations map to store.read.
    expect(storeCallLogFields({ ...RECORD, operation: 'get', kind: 'read' })['span']).toBe(
      'store.read',
    );
  });

  it('every record field must be classified as "loggable" or "deliberately excluded" (a new field fails this test)', () => {
    const allowlisted = new Set(Object.keys(STORE_CALL_LOG_FIELDS));
    const excluded = new Set<string>(STORE_CALL_LOG_EXCLUDED);
    const unclassified = Object.keys(RECORD).filter(
      (key) => !allowlisted.has(key) && !excluded.has(key),
    );
    expect(
      unclassified,
      'StoreCallRecord has an unclassified field: judge whether it may be logged, and update the allowlist or exclusion list',
    ).toEqual([]);
  });

  it('failed calls are recorded as warn with a stable error code', () => {
    const fields = storeCallLogFields({
      ...RECORD,
      status: 'error',
      errorCode: 'DFR_INTERNAL_ERROR',
    });
    expect(fields['level']).toBe('warn');
    expect(fields['error_code']).toBe('DFR_INTERNAL_ERROR');
  });

  it('business values (addresses / payloads / nonces / lease tokens) never enter logs (allowlist negative control)', () => {
    const polluted = {
      ...RECORD,
      address: '0x1111111111111111111111111111111111111111',
      unsignedPayload: '0x02f86b0180808080942222222222222222222222222222222222222280c0',
      nonce: '42',
      ownerToken: 'dfr-lease-owner-token',
      record: { txHash: `0x${'aa'.repeat(32)}` },
    } as unknown as StoreCallRecord;

    const serialized = JSON.stringify(storeCallLogFields(polluted));
    expect(serialized).not.toContain('0x1111');
    expect(serialized).not.toContain('0x02f86b');
    expect(serialized).not.toContain('dfr-lease-owner-token');
    expect(serialized).not.toContain('aa'.repeat(32));
  });

  it('the log outlet does not throw', () => {
    const logger = createStoreCallLogger(() => {
      throw new Error('stdout closed');
    });
    expect(() => logger(RECORD)).not.toThrow();
  });

  it('real Gateway: one successful build request produces store call logs', async () => {
    // Use the repo's in-memory Store stand-in (the same implementation as the transaction package tests), avoiding shape drift from hand-written fake Stores;
    // this case only verifies "the composition root wires up the observability outlet with correct classification".
    const { TransactionEngine } = await import('@dfr/transaction');
    const stores = createInMemoryTransactionStores();
    const observed: string[] = [];
    const engine = new TransactionEngine({
      stores,
      chain: {
        getPendingNonce: async () => '42',
        build: async () => ({
          schemaVersion: '1',
          chain: 'ethereum-sepolia',
          payload: '0x02f8',
          meta: { encoding: 'hex', requiresNonce: '42' },
        }),
      } as never,
      newTransactionId: () => 'txn_store_call_log' as never,
      onStoreCall: (r) => observed.push(`${r.store}.${r.operation}:${r.kind}`),
    });

    const server = createGatewayServer({
      core: {
        listChains: () => [],
        readiness: () => ({ ready: false, chains: [] }),
        startHealthChecks: () => ({ started: [], skipped: [] }),
        stopHealthChecks: () => undefined,
      } as never,
      auth: {
        keyId: 'StoreKy1',
        currentHash: hashSecret('storeCallLogSecret0123456789abcde', 'p'),
        pepper: 'p',
        projectId: 'store-log',
        scope: { chains: '*', capabilities: '*', allowWrite: true },
      },
      allowWrite: true,
      transactions: engine,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/transactions/build`, {
        method: 'POST',
        headers: {
          'x-dfr-key': 'dfr_StoreKy1_storeCallLogSecret0123456789abcde',
          'content-type': 'application/json',
          'idempotency-key': 'store-log-0001',
        },
        body: JSON.stringify({
          chain: 'ethereum-sepolia',
          from: { chain: 'ethereum-sepolia', address: '0x1111111111111111111111111111111111111111' },
          to: { chain: 'ethereum-sepolia', address: '0x2222222222222222222222222222222222222222' },
          value: { asset: { kind: 'native', chain: 'ethereum-sepolia' }, amount: '1000' },
        }),
      });
      expect(response.status).toBe(200);
      // All four write calls are observed, with correct classification.
      expect(observed).toEqual([
        'idempotency.begin:write',
        'nonce.reserve:write',
        'transaction.create:write',
        'idempotency.complete:write',
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('real startGateway: M1 assembles the store observability outlet (the startup recovery round already produces records)', async () => {
    // Wiring test: the real composition root must wire up onStoreCall.
    // At M1 startup, one RecoveryCoordinator round runs first (pruneExpired / releaseExpiredOrphaned /
    // listRecoverable), and these Store calls should produce logs — so the wiring can be verified without any business request.
    const { startGateway } = await import('../src/main.js');
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
          DFR_M0_API_KEY_ID: 'StoreKy2',
          DFR_M0_API_KEY_HASH: hashSecret('storeCallWiringSecret0123456789ab', 'p'),
          DFR_M0_API_KEY_PEPPER: 'p',
          DFR_GATEWAY_PORT: '0',
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
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

      const storeLines = lines.filter((line) => line.includes('"store call"'));
      expect(storeLines.length, lines.join('')).toBeGreaterThan(0);
      const record = JSON.parse(storeLines[0]!.trim()) as Record<string, unknown>;
      expect(record['msg']).toBe('store call');
      expect(record['store']).toBe('idempotency');
      expect(record['operation']).toBe('pruneExpired');
      expect(record['kind']).toBe('write');
      expect(record['span']).toBe('store.write');
      expect(record['latency_ms']).toBeTypeOf('number');
      // Background recovery paths have no request context; a request_id must not be invented out of thin air.
      expect(record).not.toHaveProperty('request_id');
    } finally {
      await app?.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);

  it('real startGateway: store calls on the engine write path carry request_id (distinguishing engine wiring from background wiring)', async () => {
    // Key distinguishing signal: background sweeps (recovery/reorg) have no request context, so records carry **no** request_id;
    // only when onStoreCall is wired into TransactionEngine do request-path store calls carry request_id.
    // So this case can catch the regression of "engine wiring deleted" (while background wiring remains).
    const { startGateway } = await import('../src/main.js');
    const stores = createInMemoryTransactionStores();
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
          DFR_M0_API_KEY_ID: 'StoreKy3',
          DFR_M0_API_KEY_HASH: hashSecret('storeCallEngineSecret0123456789ab', 'p'),
          DFR_M0_API_KEY_PEPPER: 'p',
          DFR_GATEWAY_PORT: '0',
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
        },
        async () => ({
          stores: {
            transaction: stores.transaction,
            idempotency: stores.idempotency,
            nonce: stores.nonce,
            tracker: stores.tracker,
          } as never,
          healthCheck: async () => undefined,
          close: async () => undefined,
        }),
      );

      const before = lines.length;
      // build first writes the idempotency record (idempotency.begin), then reads the on-chain nonce.
      // This test configures no Provider, so the chain call fails; but the idempotency begin has already happened,
      // which is enough to verify "request-path store calls are observed and carry request_id".
      const response = await fetch(`http://127.0.0.1:${app.port}/v1/transactions/build`, {
        method: 'POST',
        headers: {
          'x-dfr-key': 'dfr_StoreKy3_storeCallEngineSecret0123456789ab',
          'content-type': 'application/json',
          'idempotency-key': 'store-log-engine-0001',
          'x-request-id': 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN',
        },
        body: JSON.stringify({
          chain: 'ethereum-sepolia',
          from: { chain: 'ethereum-sepolia', address: '0x1111111111111111111111111111111111111111' },
          to: { chain: 'ethereum-sepolia', address: '0x2222222222222222222222222222222222222222' },
          value: { asset: { kind: 'native', chain: 'ethereum-sepolia' }, amount: '1000' },
        }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);

      const engineStoreLines = lines
        .slice(before)
        .filter((line) => line.includes('"store call"'))
        .map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
      expect(engineStoreLines.length, lines.join('')).toBeGreaterThan(0);
      const withRequestId = engineStoreLines.filter((r) => r['request_id'] !== undefined);
      expect(withRequestId.length).toBeGreaterThan(0);
      expect(withRequestId[0]?.['request_id']).toBe('req_01J8Z6W3Q2K9M4ABCDEFGHJKMN');
    } finally {
      await app?.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);

  it('createStoreCallLogger outputs single-line JSON', () => {
    const write = vi.fn();
    createStoreCallLogger(write)(RECORD);
    const line = write.mock.calls[0]?.[0] as string;
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ msg: 'store call', span: 'store.write' });
  });
});
