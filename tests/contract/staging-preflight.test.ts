// staging drill preflight script behavior tests (M5-E01).
//
// Why this is worth testing: this script is the only gate for "can this staging drill start".
// Both failure modes cause harm:
//   1. Not ready but reports READY -> people start the drill on a broken instance and all the evidence is wasted;
//   2. Ready but reports NOT READY -> repeated debugging of an environment that is actually fine.
// And the **most dangerous** one: if the script misses a missing auth config, the conclusions of the whole drill do not hold,
// so auth is locked in with a **reverse** assertion (no Key must give 401).
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = './scripts/staging-preflight.sh';
const FAULT_DRILL_SCRIPT = './scripts/staging-fault-drill.sh';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveRead) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
    });
    req.on('end', () => resolveRead(raw));
  });
}

interface StubOptions {
  /** Status code returned by /v1/chains without a Key; default 401 (auth is fine). */
  readonly unauthChainsStatus?: number;
  /** Status code returned by /metrics without a Key; default 401. */
  readonly unauthMetricsStatus?: number;
  /** chains in the /readyz body; by default both are available. */
  readonly readyChains?: Array<{ chain: string; providers: number; available: number }>;
  /** The stores field in /readyz; default ok. */
  readonly stores?: string;
  /** Status code for /readyz; default 200. */
  readonly readyStatus?: number;
  /** Number of items in /v1/chains with a Key; default 2. */
  readonly chainsCount?: number;
  /** Status code for /v1/chains/{id}; default 200. */
  readonly detailStatus?: number;
  /** Response body for /metrics with a Key; by default contains the two key metric families. */
  readonly metricsBody?: string;
  /** Status code for /healthz; default 200. */
  readonly healthStatus?: number;
}

/** Minimal staging stub: only implements the endpoints the script hits. */
async function startStaging(options: StubOptions = {}): Promise<string> {
  const readyChains = options.readyChains ?? [
    { chain: 'base-sepolia', providers: 1, available: 1 },
    { chain: 'arbitrum-sepolia', providers: 1, available: 1 },
  ];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const hasKey = (req.headers['x-dfr-key'] as string | undefined) !== undefined;
    const send = (status: number, body: string): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    await readBody(req);

    if (url === '/healthz') {
      return send(options.healthStatus ?? 200, JSON.stringify({ status: 'ok', requestId: 'r' }));
    }
    if (url === '/readyz') {
      return send(
        options.readyStatus ?? 200,
        JSON.stringify({
          status: (options.readyStatus ?? 200) === 200 ? 'ready' : 'not_ready',
          requestId: 'r',
          chains: readyChains,
          stores: options.stores ?? 'ok',
        }),
      );
    }
    if (url === '/metrics') {
      if (!hasKey) return send(options.unauthMetricsStatus ?? 401, JSON.stringify({ dfr_code: 'DFR_UNAUTHENTICATED' }));
      return send(
        200,
        options.metricsBody ??
          ['# HELP x', 'dfr_gateway_requests_total{route="listChains"} 1', 'dfr_gateway_inflight_requests{route_class="read"} 0', ''].join('\n'),
      );
    }
    if (url === '/v1/chains') {
      if (!hasKey) return send(options.unauthChainsStatus ?? 401, JSON.stringify({ dfr_code: 'DFR_UNAUTHENTICATED' }));
      const count = options.chainsCount ?? 2;
      return send(
        200,
        JSON.stringify({
          items: Array.from({ length: count }, (_v, i) => ({ id: i === 0 ? 'base-sepolia' : 'arbitrum-sepolia' })),
          requestId: 'r',
        }),
      );
    }
    if (url.startsWith('/v1/chains/')) {
      if (!hasKey) return send(401, JSON.stringify({ dfr_code: 'DFR_UNAUTHENTICATED' }));
      return send(options.detailStatus ?? 200, JSON.stringify({ id: url.slice('/v1/chains/'.length), requestId: 'r' }));
    }
    return send(404, JSON.stringify({ dfr_code: 'DFR_NOT_FOUND' }));
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface Result {
  readonly code: number | null;
  readonly out: string;
}

function run(env: Record<string, string>): Promise<Result> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('bash', [SCRIPT], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code, out }));
  });
}

describe('staging preflight script', () => {
  it('Missing required input -> exit code 2, without pretending a check ran', async () => {
    const result = await run({});
    expect(result.code).toBe(2);
    expect(result.out).toContain('DFR_STAGING_BASE_URL');
    expect(result.out).toContain('NOT READY');
  });

  it('All preconditions met -> READY with exit code 0', async () => {
    const base = await startStaging();
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
      DFR_STAGING_EXPECT_CHAINS: 'base-sepolia,arbitrum-sepolia',
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('READY');
    expect(result.out).toContain('401');
  });

  it('Auth misconfigured (200 even without a Key) -> NOT READY (this must be blocked)', async () => {
    const base = await startStaging({ unauthChainsStatus: 200, unauthMetricsStatus: 200 });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('NOT READY');
    expect(result.out).toContain('auth');
  });

  it('Dependencies not ready (/readyz 503 and stores unavailable) -> NOT READY', async () => {
    const base = await startStaging({ readyStatus: 503, stores: 'unavailable' });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('NOT READY');
    expect(result.out).toContain('503');
  });

  it('A chain with no available Provider -> NOT READY, naming the chain', async () => {
    const base = await startStaging({
      readyChains: [
        { chain: 'base-sepolia', providers: 1, available: 1 },
        { chain: 'arbitrum-sepolia', providers: 1, available: 0 },
      ],
    });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('arbitrum-sepolia');
  });

  it('Expected chain missing -> NOT READY', async () => {
    const base = await startStaging();
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
      DFR_STAGING_EXPECT_CHAINS: 'base-sepolia,solana-devnet',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('solana-devnet');
  });

  it('Expected chain details unreadable -> NOT READY, naming the chain', async () => {
    const base = await startStaging({ detailStatus: 404 });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
      DFR_STAGING_EXPECT_CHAINS: 'base-sepolia,arbitrum-sepolia',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('base-sepolia');
    expect(result.out).toContain('details');
  });

  it('Chain list is empty -> NOT READY (nothing to drill against)', async () => {
    const base = await startStaging({ chainsCount: 0 });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('empty');
  });

  it('Key metric families missing -> NOT READY (the drill would run blind)', async () => {
    const base = await startStaging({ metricsBody: '# HELP x\ndfr_other_metric 1\n' });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('dfr_gateway_requests_total');
  });

  it('Never prints the API Key value', async () => {
    const base = await startStaging();
    const secret = 'supersecretvalue0123456789';
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: `dfr_StageK01_${secret}`,
    });
    expect(result.out).not.toContain(secret);
  });
});

describe('staging preflight: semantic boundaries (guards against "false NOT READY")', () => {
  it('A chain with no configured endpoint (providers=0) is not a failure; per the README wording it should be READY', async () => {
    // Real defect (found in live testing on 2026-10-08): the script used to treat any `available == 0` as "chain unavailable",
    // while a **chain with no configured endpoint** in a deployment (e.g. solana-devnet on an instance with only EVM enabled)
    // also happens to have available=0. So a healthy deployment was judged NOT READY, and the operator went debugging
    // a problem that does not exist at all — exactly the second failure mode warned about at the top of this file.
    // The semantics should be: providers>0 and available==0 is "configured but all down".
    const base = await startStaging({
      readyChains: [
        { chain: 'base-sepolia', providers: 1, available: 1 },
        { chain: 'solana-devnet', providers: 0, available: 0 },
      ],
    });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('Chains with no configured endpoints');
  });

  it('Metric family names match the implementation (dfr_gateway_inflight_requests, not dfr_gateway_inflight)', async () => {
    // Real defect (found in live testing on 2026-10-08): the script checked `dfr_gateway_inflight`,
    // while the Gateway actually exports `dfr_gateway_inflight_requests`. A wrong name judges
    // a healthy instance as "metric family missing".
    const base = await startStaging({
      metricsBody: [
        '# HELP x',
        'dfr_gateway_requests_total{route="listChains"} 1',
        'dfr_gateway_inflight_requests{route_class="read"} 0',
        '',
      ].join('\n'),
    });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code, result.out).toBe(0);
  });
});

describe('staging preflight: large response body (guards against SIGPIPE false failures)', () => {
  it('A very large metrics body is still judged correctly as having the key families present (no false failure from grep -q exiting early)', async () => {
    // Real defect (found in live testing against a real instance on 2026-10-08):
    // The script used to run `printf '%s' "${metrics}" | grep -q "^family"`. The metrics body can be tens of KB,
    // `grep -q` exits as soon as it matches the first line -> printf gets SIGPIPE -> under `set -o pipefail`
    // the whole pipeline returns non-zero -> **the key metrics clearly exist but are judged missing**.
    // The live instance's /metrics was 75KB, and this false failure turned READY into NOT READY.
    // The fix is to write to a temp file first, then grep (no pipe, no SIGPIPE).
    const pad = Array.from({ length: 4000 }, (_v, i) => `dfr_filler_metric_${i}{chain="x"} ${i}`).join('\n');
    const base = await startStaging({
      metricsBody: `# HELP x\ndfr_gateway_requests_total{route="listChains"} 1\n${pad}\ndfr_gateway_inflight_requests{route_class="read"} 0\n`,
    });
    const result = await run({
      DFR_STAGING_BASE_URL: base,
      DFR_STAGING_API_KEY: 'dfr_StageK01_supersecretvalue0123456789',
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('key metric families are all present');
  });
});

describe('staging preflight: credential visibility to processes', () => {
  it('Does not expand the API Key into curl command-line arguments, and cleans up the restricted Header temp file', () => {
    // Putting the API Key in an environment variable is a controlled runbook input; but if it were expanded again into `curl -H "...${KEY}"`
    // argv, a party on the same machine that can view process arguments would see it during the request. The Header must go through a 0600
    // temp file to curl, and the script must delete that file on exit.
    const source = readFileSync(resolve(repoRoot, SCRIPT), 'utf8');
    expect(source).not.toContain('-H "X-DFR-Key: ${KEY}"');
    expect(source).toContain('AUTH_HEADER_FILE');
    expect(source).toContain('chmod 600 "${AUTH_HEADER_FILE}"');
    expect(source).toContain('rm -f "${AUTH_HEADER_FILE}"');
    expect(source).toContain('-H "@${AUTH_HEADER_FILE}"');
  });

  it('The isolated fault drill also does not expand the temporary API Key into curl command-line arguments', () => {
    const source = readFileSync(resolve(repoRoot, FAULT_DRILL_SCRIPT), 'utf8');
    expect(source).not.toContain('-H "X-DFR-Key: ${API_KEY}"');
    expect(source).toContain('API_KEY_HEADER_FILE');
    expect(source).toContain('chmod 600 "${API_KEY_HEADER_FILE}"');
    expect(source).toContain('rm -f "${API_KEY_HEADER_FILE}"');
    expect(source).toContain('-H "@${API_KEY_HEADER_FILE}"');
  });
});
