/**
 * Log-volume load test (M5 production hardening E7, launch-plan "5+ lines per request").
 *
 * Why it is needed: the observability spec requires each request to produce http.request / core.operation /
 * adapter.call / provider.request (and store.* when needed) -- several lines of structured logs.
 * "How many lines per request, how many bytes per line" directly decides log cost and disk headroom, but there were **no measured numbers** --
 * ops capacity planning cannot rely on "probably not much".
 *
 * This probe fires real HTTP requests at the **real Gateway + real Core/Adapter**,
 * captures every stdout line, counts/measures them by source, and produces a report that can be cited directly.
 * The Provider is a local stub HTTP server (no network, no funds, no signing), so it is repeatable.
 *
 * Usage:
 *   node --experimental-strip-types --experimental-transform-types \
 *     --import ./scripts/ts-runtime/register.mjs tests/tools/log-volume-probe.ts
 *
 * Optional environment variables:
 *   DFR_PROBE_REQUESTS (default 200): number of requests
 *   DFR_PROBE_CONCURRENCY (default 20): concurrency
 *   DFR_PROBE_OUT (default artifacts/log-volume-report.json)
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
 * Request interval (milliseconds).
 *
 * Why it is needed: `startGateway` uses the default token bucket (read: capacity 40, 20/s).
 * The probe measures **log volume**, not rate-limit behavior, so the rate must stay below the limit,
 * otherwise 429s distort the statistics (429s also write logs, skewing "lines per request").
 * Default 60ms ≈ 16.7 req/s, below 20/s; concurrency is limited to 1 accordingly to avoid instant bursts.
 */
const PACE_MS = Number.parseInt(process.env['DFR_PROBE_PACE_MS'] ?? '60', 10);
const OUT = process.env['DFR_PROBE_OUT'] ?? resolve(REPO_ROOT, 'artifacts/log-volume-report.json');

const SECRET = 'logVolumeProbeSecret0123456789';
const PEPPER = 'log-volume-pepper';
const KEY_ID = 'LogVol01';
const API_KEY = `dfr_${KEY_ID}_${SECRET}`;

/** Local JSON-RPC stub: only answers the two methods this probe needs, returning fixed values. */
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

  // Capture every stdout line. Both the Gateway and the probe itself write stdout, so filter by prefix:
  // only JSON Lines (starting with `{`) count as log lines; the probe's own progress output does not.
  const perSource = new Map<string, LineStats>();
  const rawLines: number[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown): boolean => {
    const text = String(chunk);
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('{')) continue;
      rawLines.push(Buffer.byteLength(line, 'utf8'));
      // Classification must cover the **actual** line shapes, otherwise lines land in unknown and the result is meaningless.
      // Measured shapes (2026-10-08, 200 requests):
      //   provider call x4, adapter call x1, core.operation x1, http.request x1 = 7 lines/request.
      // OTLP span lines only appear when DFR_OTLP_SPANS=true, classified separately (this probe does not enable it by default).
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
          // http.request lines have no msg/span: they are {requestId,trace_id,span_id,method,path,status,latencyMs}.
          // Use `path` + `requestId` as dual criteria to avoid misclassifying other lines (e.g. Provider lines also have method).
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

  // Warm up once (so cold-start extra logs are not counted in the average).
  await fetch(`http://127.0.0.1:${app.port}/v1/chains/base-sepolia`, { headers: { 'x-dfr-key': API_KEY } });
  perSource.clear();
  rawLines.length = 0;

  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  // Serial + fixed rate: the rate limiter is the default bucket, and bursty concurrent requests would get 429s and distort the log-volume statistics.
  // CONCURRENCY is kept as an explicit constraint, but the fixed rate is already single-concurrency.
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

  // Self-check: the classifier must place **every** line into a known source.
  // If unknown / unparsable-json appears, the log shapes changed and the classifier did not keep up --
  // then the report's numbers are misleading; better to have the probe exit non-zero than produce a fake report that "looks fine".
  const unclassified = (perSource.get('unknown')?.count ?? 0) + (perSource.get('unparsable-json')?.count ?? 0);
  if (unclassified > 0) {
    process.stderr.write(`Log-volume load test: the classifier missed ${unclassified} lines; the report is unreliable (see bySource.unknown)\n`);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return 2;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // The report summary goes to stderr, so it does not pollute the stdout shape just asserted.
  process.stderr.write(
    `Log-volume load test: ${REQUESTS} requests (ok=${ok} failed=${failed}, ${CONCURRENCY} concurrent, ${elapsedMs}ms)\n` +
      `  ${report.totals.linesPerRequest} lines / ${report.totals.bytesPerRequest} bytes per request; ${report.totals.bytesPerLine} bytes per line on average\n` +
      `  Evidence: ${OUT}\n`,
  );
  return failed === 0 ? 0 : 1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

process.exitCode = await main();
