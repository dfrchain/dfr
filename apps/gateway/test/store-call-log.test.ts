// Store 调用结构化日志契约测试（observability-spec 第 4 章 store.read / store.write）。
//
// 与 provider / adapter 日志测试同构：白名单护栏 + 真实 composition root 接线。
// Store 调用由 `TransactionEngine` 内的端口层包装产生（单点实现），因此这里主要验证
// "白名单正确"与"真实请求会产出记录"，而不重复引擎侧的行为测试。
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

describe('Store 调用结构化日志（observability-spec §4）', () => {
  it('字段名符合 observability-spec 第 3 章统一命名，并带 store.read/write span 名', () => {
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

    // 读操作映射到 store.read。
    expect(storeCallLogFields({ ...RECORD, operation: 'get', kind: 'read' })['span']).toBe(
      'store.read',
    );
  });

  it('每个记录字段都必须被归类为"可入日志"或"有意排除"（新增字段会让本测试失败）', () => {
    const allowlisted = new Set(Object.keys(STORE_CALL_LOG_FIELDS));
    const excluded = new Set<string>(STORE_CALL_LOG_EXCLUDED);
    const unclassified = Object.keys(RECORD).filter(
      (key) => !allowlisted.has(key) && !excluded.has(key),
    );
    expect(
      unclassified,
      'StoreCallRecord 新增了未归类字段：请判断它是否可写日志，并更新白名单或排除列表',
    ).toEqual([]);
  });

  it('失败调用以 warn 记录并带稳定错误码', () => {
    const fields = storeCallLogFields({
      ...RECORD,
      status: 'error',
      errorCode: 'DFR_INTERNAL_ERROR',
    });
    expect(fields['level']).toBe('warn');
    expect(fields['error_code']).toBe('DFR_INTERNAL_ERROR');
  });

  it('业务值（地址 / 载荷 / nonce / 租约 token）绝不进入日志（白名单负对照）', () => {
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

  it('日志出口不抛错', () => {
    const logger = createStoreCallLogger(() => {
      throw new Error('stdout closed');
    });
    expect(() => logger(RECORD)).not.toThrow();
  });

  it('真实 Gateway：一次成功的 build 请求产出 store 调用日志', async () => {
    // 用仓库的内存 Store 替身（与 transaction 包测试同一实现），避免手写假 Store 的形状偏差；
    // 本用例只验证"composition root 把观测出口接上且分类正确"。
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
      // 四次写调用都被观测，且分类正确。
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

  it('真实 startGateway：M1 装配 store 观测出口（启动恢复轮即产生记录）', async () => {
    // 接线测试：真实 composition root 必须把 onStoreCall 接上。
    // M1 启动时会先跑一轮 RecoveryCoordinator（pruneExpired / releaseExpiredOrphaned /
    // listRecoverable），这些 Store 调用应当产生日志——因此无需业务请求即可验证接线。
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
      // 后台恢复路径没有请求上下文，不得凭空造一个 request_id。
      expect(record).not.toHaveProperty('request_id');
    } finally {
      await app?.close();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);

  it('真实 startGateway：引擎写路径的 store 调用带 request_id（区分引擎接线与后台接线）', async () => {
    // 关键区分信号：后台巡检（恢复/重组）没有请求上下文，记录**不带** request_id；
    // 只有把 onStoreCall 接进 TransactionEngine，请求路径的 store 调用才会带 request_id。
    // 因此本用例能捕获"引擎接线被删掉"（后台接线仍在）这种回归。
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
      // build 会先写幂等记录（idempotency.begin）再读链上 nonce。
      // 本测试未配置 Provider，因此链调用会失败；但幂等 begin 已经发生，
      // 足以验证"请求路径的 store 调用被观测且带 request_id"。
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

  it('createStoreCallLogger 输出单行 JSON', () => {
    const write = vi.fn();
    createStoreCallLogger(write)(RECORD);
    const line = write.mock.calls[0]?.[0] as string;
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ msg: 'store call', span: 'store.write' });
  });
});
