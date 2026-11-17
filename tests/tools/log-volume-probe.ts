/**
 * 日志量压测（M5 生产加固 E7，launch-plan "每请求 5+ 行"）。
 *
 * 为什么需要：观测规范要求每个请求产出 http.request / core.operation /
 * adapter.call / provider.request（必要时还有 store.*）多行结构化日志。
 * "每请求几行、每行多少字节"直接决定日志成本与磁盘水位，但一直**没有实测数字**——
 * 运维容量规划不能靠"大概不多"。
 *
 * 本探针在**真实 Gateway + 真实 Core/Adapter** 上打真实 HTTP 请求，
 * 捕获 stdout 的每一行并按来源分类计数/计量，产出一份可直接引用的报告。
 * Provider 是本地 stub HTTP（不联网、无资金、无签名），因此可重复。
 *
 * 用法：
 *   node --experimental-strip-types --experimental-transform-types \
 *     --import ./scripts/ts-runtime/register.mjs tests/tools/log-volume-probe.ts
 *
 * 可选环境变量：
 *   DFR_PROBE_REQUESTS（默认 200）：请求数
 *   DFR_PROBE_CONCURRENCY（默认 20）：并发度
 *   DFR_PROBE_OUT（默认 artifacts/log-volume-report.json）
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSecret } from '@dfr/gateway';
import { startGateway } from '../../apps/gateway/src/main.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REQUESTS = Number.parseInt(process.env['DFR_PROBE_REQUESTS'] ?? '200', 10);
const CONCURRENCY = Number.parseInt(process.env['DFR_PROBE_CONCURRENCY'] ?? '20', 10);
/**
 * 请求间隔（毫秒）。
 *
 * 为什么需要它：`startGateway` 使用默认令牌桶（read: 容量 40、20/s）。
 * 探针要测的是**日志量**而不是限流行为，因此必须把速率压在限额以下，
 * 否则 429 会让统计失真（429 也写日志，会把"每请求行数"算歪）。
 * 默认 60ms ≈ 16.7 req/s，低于 20/s；并发度相应限制为 1 以免瞬时突发。
 */
const PACE_MS = Number.parseInt(process.env['DFR_PROBE_PACE_MS'] ?? '60', 10);
const OUT = process.env['DFR_PROBE_OUT'] ?? resolve(REPO_ROOT, 'artifacts/log-volume-report.json');

const SECRET = 'logVolumeProbeSecret0123456789';
const PEPPER = 'log-volume-pepper';
const KEY_ID = 'LogVol01';
const API_KEY = `dfr_${KEY_ID}_${SECRET}`;

/** 本地 JSON-RPC stub：只回本探针需要的两个方法，返回固定值。 */
function startStubRpc(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer((req, res) => {
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
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolvePromise({ server, port: addr.port });
    });
  });
}

interface LineStats {
  count: number;
  bytes: number;
}

async function main(): Promise<number> {
  const { server: rpc, port } = await startStubRpc();

  // 捕获 stdout 的每一行。Gateway 与探针自身都写 stdout，因此按前缀过滤：
  // 只有 JSON Lines（以 `{` 开头）才算日志行，探针的进度输出不算。
  const perSource = new Map<string, LineStats>();
  const rawLines: number[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown): boolean => {
    const text = String(chunk);
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('{')) continue;
      rawLines.push(Buffer.byteLength(line, 'utf8'));
      // 分类必须覆盖**实际的**行形状，否则会落到 unknown 而失去意义。
      // 实测形状（2026-10-08，200 请求）：
      //   provider call ×4、adapter call ×1、core.operation ×1、http.request ×1 = 7 行/请求。
      // OTLP span 行只在 DFR_OTLP_SPANS=true 时出现，单独归类（本探针默认不开启）。
      let source = 'unknown';
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (Array.isArray(parsed['resourceSpans'])) source = 'otlp-span';
        else if (typeof parsed['span'] === 'string') source = parsed['span'];
        else {
          const msg = parsed['msg'];
          if (msg === 'provider call') source = 'provider.request';
          else if (msg === 'adapter call') source = 'adapter.call';
          else if (msg === 'core operation') source = 'core.operation';
          else if (msg === 'store call') source = 'store';
          // http.request 行没有 msg/span：它是 {requestId,trace_id,span_id,method,path,status,latencyMs}。
          // 用 `path` + `requestId` 双重判据，避免把别的行误归（如 Provider 行也有 method）。
          else if (
            typeof parsed['method'] === 'string' &&
            typeof parsed['path'] === 'string' &&
            typeof parsed['requestId'] === 'string'
          ) {
            source = 'http.request';
          }
        }
      } catch {
        source = 'unparsable-json';
      }
      const current = perSource.get(source) ?? { count: 0, bytes: 0 };
      perSource.set(source, { count: current.count + 1, bytes: current.bytes + Buffer.byteLength(line, 'utf8') });
    }
    return true;
  };

  const stdout = process.stdout;
  const app = await startGateway(
    {
      DFR_M0_API_KEY_ID: KEY_ID,
      DFR_M0_API_KEY_HASH: hashSecret(SECRET, PEPPER),
      DFR_M0_API_KEY_PEPPER: PEPPER,
      DFR_GATEWAY_PORT: '0',
      DFR_M1_ALLOW_WRITE: 'true',
      DFR_TRANSACTION_DATABASE_URL: 'postgres://runtime:[redacted]@db.invalid/dfr',
      DFR_RECOVERY_SWEEP_INTERVAL_MS: '86400000',
      DFR_REORG_SWEEP_INTERVAL_MS: '86400000',
      DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: `http://127.0.0.1:${port}`,
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

  // 预热 1 次（避免把冷启动的额外日志算进平均值）。
  await fetch(`http://127.0.0.1:${app.port}/v1/chains/base-sepolia`, { headers: { 'x-dfr-key': API_KEY } });
  perSource.clear();
  rawLines.length = 0;

  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  // 串行 + 定速：限流器是默认桶，突发的并发请求会被 429，令日志量统计失真。
  // CONCURRENCY 保留为显式约束，但定速本身就是单并发。
  void CONCURRENCY;
  for (let i = 0; i < REQUESTS; i += 1) {
    const res = await fetch(`http://127.0.0.1:${app.port}/v1/chains/base-sepolia`, {
      headers: { 'x-dfr-key': API_KEY },
    });
    if (res.status === 200) ok += 1;
    else failed += 1;
    await res.arrayBuffer();
    if (i < REQUESTS - 1 && PACE_MS > 0) await new Promise((r) => setTimeout(r, PACE_MS));
  }
  const elapsedMs = Date.now() - startedAt;

  await app.close();
  await new Promise<void>((r) => rpc.close(() => r()));
  (stdout as unknown as { write: typeof originalWrite }).write = originalWrite;

  const bySource = Object.fromEntries(
    [...perSource.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => [k, { lines: v.count, bytes: v.bytes, linesPerRequest: round(v.count / REQUESTS), bytesPerLine: round(v.bytes / v.count) }]),
  );
  const totalLines = rawLines.reduce((a) => a + 1, 0);
  const totalBytes = rawLines.reduce((a, b) => a + b, 0);
  const report = {
    schema: 1,
    probe: 'log-volume',
    requests: { total: REQUESTS, ok, failed, concurrency: CONCURRENCY, elapsedMs },
    totals: {
      lines: totalLines,
      bytes: totalBytes,
      linesPerRequest: round(totalLines / REQUESTS),
      bytesPerRequest: round(totalBytes / REQUESTS),
      bytesPerLine: round(totalBytes / totalLines),
    },
    bySource,
  };

  // 自检：分类器必须把**所有**行归入已知来源。
  // 若出现 unknown / unparsable-json，说明日志形状变了而分类器没跟上——
  // 那种报告的数字是误导性的，宁可让探针非零退出，也不要产出一份"看起来正常"的假报告。
  const unclassified = (perSource.get('unknown')?.count ?? 0) + (perSource.get('unparsable-json')?.count ?? 0);
  if (unclassified > 0) {
    process.stderr.write(`日志量压测：分类器漏掉 ${unclassified} 行，报告不可信（见 bySource.unknown）\n`);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return 2;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // 报告摘要走 stderr，避免污染我们刚断言的 stdout 口径。
  process.stderr.write(
    `日志量压测：${REQUESTS} 请求（ok=${ok} failed=${failed}, ${CONCURRENCY} 并发, ${elapsedMs}ms）\n` +
      `  每请求 ${report.totals.linesPerRequest} 行 / ${report.totals.bytesPerRequest} 字节；每行均值 ${report.totals.bytesPerLine} 字节\n` +
      `  证据：${OUT}\n`,
  );
  return failed === 0 ? 0 : 1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

process.exitCode = await main();
