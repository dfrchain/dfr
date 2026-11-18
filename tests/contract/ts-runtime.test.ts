// Process-level regression for the production entrypoint and graceful shutdown (DFR-M1-E02).
//
// Background: this repo is a `module: NodeNext` ESM TypeScript source repo; imports write `.js` specifiers
// but the files on disk are `.ts`. Node's built-in type stripping does **not** do this remapping,
// so `node --experimental-strip-types apps/gateway/src/main.ts` fails with
// `ERR_MODULE_NOT_FOUND: .../server.js`. The startup command written in the E01 runbook is exactly this kind,
// and it failed when actually run.
//
// E02 added a zero-dependency resolution hook, `scripts/ts-runtime/`. This file locks two things with
// **real subprocesses**:
//   1. Parameter properties (`constructor(private readonly x)`) must be transformed, and `.js`→`.ts` must resolve;
//   2. The real Gateway entrypoint starts, `/healthz` is reachable, and after SIGTERM it exits gracefully with code 0.
//
// Neither is coverable by unit tests: they only hold on a real Node process's module-resolution and signal paths.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTER = './scripts/ts-runtime/register.mjs';
const TS_FLAGS = ['--experimental-strip-types', '--experimental-transform-types'];

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly code: number | null;
}

function run(file: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...TS_FLAGS, '--import', REGISTER, file], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise({ stdout, code });
      else reject(new Error(`exit=${code}\nstdout=${stdout}\nstderr=${stderr}`));
    });
  });
}

describe('Node runtime resolution hook (DFR-M1-E02)', () => {
  it('resolves .js specifiers to .ts and transforms TS parameter properties', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfr-ts-runtime-'));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, 'a.ts'),
      'export class A { constructor(private readonly v: number) {} get value() { return this.v; } }\n',
    );
    writeFileSync(
      join(dir, 'b.ts'),
      'import { A } from "./a.js";\nprocess.stdout.write(`got ${new A(7).value}\\n`);\n',
    );

    const result = await run(join(dir, 'b.ts'));
    expect(result.stdout).toContain('got 7');
  });

  it('the real Gateway entrypoint starts, /healthz is reachable, and exit code is 0 after SIGTERM', async () => {
    const child = spawn(
      process.execPath,
      [...TS_FLAGS, '--import', REGISTER, 'apps/gateway/src/main.ts'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          // M0 read-only deployment: no database needed.
          DFR_M0_API_KEY_ID: 'RuntimeA',
          DFR_M0_API_KEY_HASH: '0'.repeat(64),
          DFR_GATEWAY_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    spawned.push(child);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`gateway did not start\nstdout=${stdout}\nstderr=${stderr}`)),
        20_000,
      );
      child.stdout?.on('data', () => {
        const match = /"msg":"dfr gateway listening","port":(\d+)/u.exec(stdout);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolvePort(Number(match[1]));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`gateway exited early code=${code}\nstderr=${stderr}`));
      });
    });

    const live = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: 'ok' });

    // The readiness probe must exist and return a parseable structure (200 not forced: under M0 the default
    // registry has no chain enabled).
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect([200, 503]).toContain(ready.status);
    expect(await ready.json()).toHaveProperty('status');

    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.once('exit', (code) => resolveExit(code));
      child.kill('SIGTERM');
    });
    expect(exitCode).toBe(0);
  }, 30_000);
});
