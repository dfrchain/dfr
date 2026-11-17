// Provider 调用结构化日志契约测试（DFR-M1-E02 观测补充）。
//
// 这是**脱敏护栏**测试：它不关心日志好不好看，只关心"哪些字段允许进入生产日志"。
// 一旦 `@dfr/provider` 的 `ProviderCallRecord` 新增字段而没人把它加入白名单或排除列表，
// 本测试即失败，强制人工判断该字段是否可入日志。
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

describe('Provider 调用结构化日志（DFR-M1-E02）', () => {
  it('字段名符合 observability-spec 第 3 章的统一 snake_case 命名', () => {
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

  it('每个记录字段都必须被显式归类为"可入日志"或"有意排除"（新增字段会让本测试失败）', () => {
    const allowlisted = new Set(Object.keys(PROVIDER_CALL_LOG_FIELDS));
    const excluded = new Set<string>(PROVIDER_CALL_LOG_EXCLUDED);
    const unclassified = Object.keys(RECORD).filter(
      (key) => !allowlisted.has(key) && !excluded.has(key),
    );
    expect(
      unclassified,
      'ProviderCallRecord 新增了未归类字段：请判断它是否可写日志，并更新白名单或排除列表',
    ).toEqual([]);
  });

  it('失败调用以 warn 记录，并携带稳定错误码', () => {
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

  it('非白名单字段（端点 / 凭证 / 请求体）绝不进入日志', () => {
    // 模拟"未来 ProviderCallRecord 被加入敏感字段"的最坏情况：运行时确实带了这些键。
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

  it('日志出口不抛错：观测失败不得影响被观测的调用路径', () => {
    const logger = createProviderCallLogger(() => {
      throw new Error('stdout closed');
    });
    expect(() => logger(RECORD)).not.toThrow();
  });

  it('createProviderCallLogger 输出单行 JSON（便于日志采集按行解析）', () => {
    const write = vi.fn();
    createProviderCallLogger(write)(RECORD);
    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0]?.[0] as string;
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({ msg: 'provider call', provider_id: RECORD.providerId });
  });

  it('真实 startGateway 装配 onProviderCall：一次链上查询就会写出脱敏调用日志', async () => {
    // 端到端接线验证：本地起一个最小 JSON-RPC 端点，让 base-sepolia 的 block.read
    // 真正走到 Provider，断言 composition root 把调用记录写成了结构化日志。
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
      // base-sepolia 是 M1 链，必须开 M1 才会启用（否则 /v1/chains/base-sepolia 为 404）。
      // 持久化用最小假替身：本用例只关心 Provider 调用日志，不关心交易存储。
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
      // 脱敏：即使端点带凭证，日志也只能出现逻辑 Provider ID，不出现 URL。
      expect(JSON.stringify(record)).not.toContain('127.0.0.1');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 20_000);
});
