// E03 preflight script behavior tests.
//
// Why this is worth testing: the failure modes of this script are dangerous — if it
// misreports READY while **not ready**, a human will carry on without an RPC or a
// funded account, turning the E03 evidence into waste paper.
// Conversely, if it misreports NOT READY while **ready**, people will assume the
// environment is broken and debug it over and over.
//
// Both paths are locked:
//   1. Empty environment -> NOT READY + exit code 1 (fail-closed);
//   2. All preconditions met (with a stub RPC returning the correct chainId) -> READY + exit code 0;
//   3. Plus a negative control: chainId is not Sepolia -> must be rejected.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = './scripts/e03-preflight.sh';

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

/** Minimal JSON-RPC stub: answers every request with the `eth_chainId` result. */
async function startRpc(chainId: string): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { id?: unknown };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, result: chainId }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface PreflightResult {
  readonly code: number | null;
  readonly stdout: string;
}

/** Run the script in a **controlled environment**: do not inherit host variables, so test results do not depend on the dev machine's incidental configuration. */
function runPreflight(env: Record<string, string>): Promise<PreflightResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('bash', [SCRIPT], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code, stdout: stdout + stderr }));
  });
}

describe('E03 preflight script', () => {
  it('Empty environment -> NOT READY with exit code 1 (missing RPC / DB / key / funded address)', async () => {
    const result = await runPreflight({});

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('NOT READY');
    // Missing items must be named explicitly, not just reported as a generic failure.
    expect(result.stdout).toContain('DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL');
    expect(result.stdout).toContain('DFR_TRANSACTION_DATABASE_URL');
    expect(result.stdout).toContain('DFR_E03_FUNDED_ADDRESS');
  });

  it('All preconditions met (Sepolia chainId) -> READY with exit code 0', async () => {
    const rpc = await startRpc('0xaa36a7');
    const result = await runPreflight({
      DFR_E03_SKIP_DB: '1',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: rpc,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: rpc,
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_M1_ALLOW_WRITE: 'true',
      DFR_E03_FUNDED_ADDRESS: '0x1111111111111111111111111111111111111111',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('READY');
    expect(result.stdout).toContain('has declared transaction.broadcast');
  });

  it('Database probe can load the pg driver (guards against "a tooling problem misreported as database unreachable")', async () => {
    // Real defect (found 2026-10-06): the script used to `require("pg")` from the **repo root**, while `pg` is only installed under
    // `packages/storage-postgres/node_modules`, so the probe always failed with MODULE_NOT_FOUND and printed
    // "Database is unreachable" — even when the database was perfectly fine. This is exactly the
    // "ready but misreported as NOT READY" failure warned about at the top of this file: the operator would keep debugging the network and permissions, when the real problem was the script itself.
    //
    // This does not depend on a real database: it asserts the script **first confirms the driver loads**, then reports the connection result,
    // so the two failure kinds stay distinguishable (driver unavailable = repo/installation problem; unreachable = network/credential problem).
    const rpc = await startRpc('0xaa36a7');
    const result = await runPreflight({
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: rpc,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: rpc,
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_M1_ALLOW_WRITE: 'true',
      DFR_E03_FUNDED_ADDRESS: '0x1111111111111111111111111111111111111111',
      // Point at a port that will certainly refuse connections: the driver should load, then honestly report "unreachable".
      DFR_TRANSACTION_DATABASE_URL: 'postgres://dfr_runtime:x@127.0.0.1:1/dfr_m1_test',
    });

    expect(result.stdout).toContain('Database driver is available');
    expect(result.stdout).toContain('Database is unreachable');
    expect(result.stdout).not.toContain('Database driver is unavailable');
  });

  it('RPC pointing at a non-Sepolia chain -> must be rejected (negative control)', async () => {
    // 0x14a34 = Base Sepolia. Pointing at another chain makes the "Sepolia acceptance" a misnomer.
    const rpc = await startRpc('0x14a34');
    const result = await runPreflight({
      DFR_E03_SKIP_DB: '1',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: rpc,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: rpc,
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_M1_ALLOW_WRITE: 'true',
      DFR_E03_FUNDED_ADDRESS: '0x1111111111111111111111111111111111111111',
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('is not Sepolia');
  });

  it('Write switch not enabled -> must be rejected (M1 write path fail-closed)', async () => {
    const rpc = await startRpc('0xaa36a7');
    const result = await runPreflight({
      DFR_E03_SKIP_DB: '1',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: rpc,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: rpc,
      DFR_M0_API_KEY_ID: 'TestKey1',
      DFR_M0_API_KEY_HASH: '0'.repeat(64),
      DFR_E03_FUNDED_ADDRESS: '0x1111111111111111111111111111111111111111',
      // DFR_M1_ALLOW_WRITE deliberately not set
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('DFR_M1_ALLOW_WRITE');
  });
});
