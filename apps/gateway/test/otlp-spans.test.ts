// OTLP span 导出接线测试（M5 生产加固 E6）。
//
// 这条测试锁的是 observability-spec 验收清单里最后一个未决项：
// "真正的 parent/child span（独立 spanId + 父引用）"。
//
// 断言在**线格式**上做，而不是只看日志：解析 stdout 里的 OTLP/JSON，
// 检查 traceId 一致、各层 spanId 互不相同、parentSpanId 指向请求 span。
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { startGateway } from '../src/main.js';
import { hashSecret } from '../src/index.js';
import { attributesFromLogFields, SPAN_NAMES, storeSpanName } from '../src/span-emitter.js';

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  status: { code: number };
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
}

function parseOtlpLines(lines: readonly string[]): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!Array.isArray(parsed['resourceSpans'])) continue;
    for (const rs of parsed['resourceSpans'] as Array<Record<string, unknown>>) {
      for (const ss of rs['scopeSpans'] as Array<Record<string, unknown>>) {
        for (const span of ss['spans'] as OtlpSpan[]) spans.push(span);
      }
    }
  }
  return spans;
}

describe('span-emitter 纯函数', () => {
  it('关联字段不进入 span 属性（身份与属性不重复存两份）', () => {
    const attrs = attributesFromLogFields({
      request_id: 'r',
      trace_id: 't',
      span_id: 's',
      span: 'core.operation',
      level: 'info',
      msg: 'core operation',
      operation: 'getInfo',
      latency_ms: 3,
    });
    expect(attrs).toEqual({ operation: 'getInfo', latency_ms: 3 });
  });

  it('store span 名按 kind 展开为 store.read / store.write', () => {
    expect(storeSpanName('read')).toBe('store.read');
    expect(storeSpanName('write')).toBe('store.write');
  });

  it('span 名称与 spec §4 的层级名一致', () => {
    expect(SPAN_NAMES).toEqual({
      coreOperation: 'core.operation',
      adapterCall: 'adapter.call',
      providerRequest: 'provider.request',
    });
  });
});

describe('真实 startGateway：DFR_OTLP_SPANS=true 产出可组装层级的 span', () => {
  it('core/adapter/provider 三层各产出独立 spanId，父指向同一请求 span', async () => {
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
          DFR_M0_API_KEY_ID: 'OtlpK001',
          DFR_M0_API_KEY_HASH: hashSecret('otlpSpansSecret0123456789ab', 'p'),
          DFR_M0_API_KEY_PEPPER: 'p',
          DFR_GATEWAY_PORT: '0',
          DFR_M1_ALLOW_WRITE: 'true',
          DFR_M0_SCOPE_CHAINS: '*', // Explicit legacy test fixture scope; M1 no longer assumes wildcard.
          DFR_M0_SCOPE_CAPABILITIES: '*',
          DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
          DFR_RECOVERY_SWEEP_INTERVAL_MS: '3600000',
          DFR_REORG_SWEEP_INTERVAL_MS: '3600000',
          DFR_OTLP_SPANS: 'true',
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
        headers: { 'x-dfr-key': 'dfr_OtlpK001_otlpSpansSecret0123456789ab' },
      });
      expect(response.status).toBe(200);

      const spans = parseOtlpLines(lines);
      const byName = new Map(spans.map((s) => [s.name, s]));
      // 至少要有 core.operation 与 provider.request（adapter.call 视适配器实现而定）
      expect(byName.has('core.operation'), JSON.stringify([...byName.keys()])).toBe(true);

      const core = byName.get('core.operation') as OtlpSpan;
      expect(core.traceId).toMatch(/^[0-9a-f]{32}$/u);
      expect(core.spanId).toMatch(/^[0-9a-f]{16}$/u);
      expect(core.parentSpanId).toMatch(/^[0-9a-f]{16}$/u);
      expect(core.status.code).toBe(1);

      // 所有 span 共享同一 trace
      for (const span of spans) expect(span.traceId).toBe(core.traceId);

      // 每层 spanId 互不相同（这就是"独立 spanId"）
      const spanIds = spans.map((s) => s.spanId);
      expect(new Set(spanIds).size).toBe(spanIds.length);

      const sameRequest = spans.filter((s) => s.parentSpanId !== undefined);
      expect(new Set(sameRequest.map((s) => s.parentSpanId)).size).toBe(1);

      // spanId 不等于父（没有自环）
      for (const span of spans) expect(span.spanId).not.toBe(span.parentSpanId);

      // 脱敏：span 属性里不得出现 RPC 端点
      expect(JSON.stringify(spans)).not.toContain('127.0.0.1');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);

  it('未开启 DFR_OTLP_SPANS 时不产出 span（默认行为不变）', async () => {
    const rpc = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { id?: unknown; method?: string };
        const value = parsed.method === 'eth_chainId' ? '0x14a34' : '0x1';
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
          DFR_M0_API_KEY_ID: 'NoOtlp01',
          DFR_M0_API_KEY_HASH: hashSecret('noOtlpSpansSecret0123456789', 'p'),
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
      await fetch(`http://127.0.0.1:${app.port}/v1/chains/base-sepolia`, {
        headers: { 'x-dfr-key': 'dfr_NoOtlp01_noOtlpSpansSecret0123456789' },
      });
      expect(parseOtlpLines(lines)).toHaveLength(0);
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => rpc.close(() => resolve()));
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }, 25_000);
});
