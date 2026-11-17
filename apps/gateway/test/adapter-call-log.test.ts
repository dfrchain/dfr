// Adapter 调用结构化日志契约测试（DFR-M1-E02 观测补充）。
//
// 与 provider-call-log.test.ts 同构：白名单护栏 + 真实 composition root 端到端接线。
// Core 的 11 个 Adapter 调用点已统一收敛到 `callAdapter` 包装，因此这里只需证明
// "真实请求会产生 adapter call 日志"，以及"新增字段会被迫使归类"。
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterCallRecord } from '@dfr/core';
import {
  ADAPTER_CALL_LOG_EXCLUDED,
  ADAPTER_CALL_LOG_FIELDS,
  adapterCallLogFields,
  createAdapterCallLogger,
} from '../src/adapter-call-log.js';
import { hashSecret } from '../src/index.js';
import { startGateway } from '../src/main.js';

const RECORD: AdapterCallRecord = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  adapter: 'evm',
  adapterVersion: '0.1.0',
  chain: 'base-sepolia' as never,
  method: 'getBlock',
  methodClass: 'read',
  status: 'success',
  latencyMs: 12,
};

describe('Adapter 调用结构化日志（DFR-M1-E02）', () => {
  it('字段名符合 observability-spec 第 3 章统一命名', () => {
    const fields = adapterCallLogFields(RECORD);
    expect(fields['request_id']).toBe(RECORD.requestId);
    expect(fields['trace_id']).toBe(RECORD.traceId);
    expect(fields['span_id']).toBe(RECORD.spanId);
    expect(fields['adapter']).toBe('evm');
    expect(fields['adapter_version']).toBe('0.1.0');
    expect(fields['chain']).toBe('base-sepolia');
    expect(fields['method']).toBe('getBlock');
    expect(fields['status']).toBe('success');
    expect(fields['latency_ms']).toBe(12);
    expect(fields['msg']).toBe('adapter call');
    expect(fields['level']).toBe('info');
  });

  it('每个记录字段都必须被归类为"可入日志"或"有意排除"（新增字段会让本测试失败）', () => {
    const allowlisted = new Set(Object.keys(ADAPTER_CALL_LOG_FIELDS));
    const excluded = new Set<string>(ADAPTER_CALL_LOG_EXCLUDED);
    const unclassified = Object.keys(RECORD).filter(
      (key) => !allowlisted.has(key) && !excluded.has(key),
    );
    expect(
      unclassified,
      'AdapterCallRecord 新增了未归类字段：请判断它是否可写日志，并更新白名单或排除列表',
    ).toEqual([]);
  });

  it('失败调用以 warn 记录并携带稳定错误码', () => {
    const fields = adapterCallLogFields({
      ...RECORD,
      status: 'error',
      errorCode: 'DFR_CHAIN_UNAVAILABLE',
    });
    expect(fields['level']).toBe('warn');
    expect(fields['error_code']).toBe('DFR_CHAIN_UNAVAILABLE');
  });

  it('调用参数 / 载荷 / 地址绝不进入日志（白名单负对照）', () => {
    // 模拟未来把参数或载荷塞进记录的后果。
    const polluted = {
      ...RECORD,
      params: ['0xdeadbeef', '0x1111111111111111111111111111111111111111'],
      unsignedPayload: '0x02f86b0180808080942222222222222222222222222222222222222280c0',
      result: { raw: '0xabcdef' },
    } as unknown as AdapterCallRecord;

    const serialized = JSON.stringify(adapterCallLogFields(polluted));
    expect(serialized).not.toContain('0xdeadbeef');
    expect(serialized).not.toContain('0x02f86b');
    expect(serialized).not.toContain('0x1111');
    expect(serialized).not.toContain('0xabcdef');
  });

  it('日志出口不抛错', () => {
    const logger = createAdapterCallLogger(() => {
      throw new Error('stdout closed');
    });
    expect(() => logger(RECORD)).not.toThrow();
  });

  it('真实 startGateway：一次链上读会同时产生 adapter call 与 provider call 日志', async () => {
    const rpcServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
        const value =
          parsed.method === 'eth_chainId'
            ? '0x14a34'
            : parsed.method === 'eth_getBlockByNumber'
              ? {
                  number: '0x1',
                  hash: `0x${'11'.repeat(32)}`,
                  parentHash: `0x${'22'.repeat(32)}`,
                  timestamp: '0x67f00000',
                  transactions: [],
                }
              : '0x0';
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
      app = await startGateway(
        {
          DFR_M0_API_KEY_ID: 'AdpKey01',
          DFR_M0_API_KEY_HASH: hashSecret('adapterCallLogSecret0123456789ab', 'p'),
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
        headers: { 'x-dfr-key': 'dfr_AdpKey01_adapterCallLogSecret0123456789ab' },
      });
      expect(response.status).toBe(200);

      const adapterLines = lines.filter((line) => line.includes('"adapter call"'));
      const providerLines = lines.filter((line) => line.includes('"provider call"'));
      expect(adapterLines.length, lines.join('')).toBeGreaterThan(0);
      expect(providerLines.length, lines.join('')).toBeGreaterThan(0);

      const record = JSON.parse(adapterLines[0]!.trim()) as Record<string, unknown>;
      expect(record['msg']).toBe('adapter call');
      expect(record['adapter']).toBe('evm');
      expect(record['method']).toBe('getInfo');
      expect(record['latency_ms']).toBeTypeOf('number');
      // 脱敏：日志不得出现 RPC 端点。
      expect(JSON.stringify(record)).not.toContain('127.0.0.1');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);

  it('失败路径：adapter call 记录稳定错误码，且日志不含原始异常文本', async () => {
    // Provider 返回 503（含可疑内部文本），Adapter 抛错，Core 归一化后记录。
    // 关键断言：日志里只有 DFR_ 错误码，不含端点或原始 message。
    const rpcServer = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('upstream exploded at http://internal.example.invalid/v3?apikey=SUPERSECRET');
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
      app = await startGateway(
        {
          DFR_M0_API_KEY_ID: 'AdpKey02',
          DFR_M0_API_KEY_HASH: hashSecret('adapterCallLogSecret0123456789ab', 'p'),
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
        headers: { 'x-dfr-key': 'dfr_AdpKey02_adapterCallLogSecret0123456789ab' },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);

      const adapterLines = lines.filter((line) => line.includes('"adapter call"'));
      expect(adapterLines.length, lines.join('')).toBeGreaterThan(0);
      const record = JSON.parse(adapterLines[0]!.trim()) as Record<string, unknown>;
      expect(record['status']).toBe('error');
      expect(String(record['error_code'])).toMatch(/^DFR_/u);
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('SUPERSECRET');
      expect(serialized).not.toContain('internal.example.invalid');
      expect(serialized).not.toContain('upstream exploded');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);
});
