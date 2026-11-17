// 生产入口与优雅退出的进程级回归（DFR-M1-E02）。
//
// 背景：本仓库是 `module: NodeNext` 的 ESM TypeScript 源码仓，导入写 `.js` 说明符
// 但磁盘上是 `.ts`。Node 内置类型剥离**不会**做这个重映射，
// 因此 `node --experimental-strip-types apps/gateway/src/main.ts` 会
// `ERR_MODULE_NOT_FOUND: .../server.js`。E01 手册里写的启动命令正是这一种，实测启动失败。
//
// E02 补了零依赖解析钩子 `scripts/ts-runtime/`。本文件用**真实子进程**锁定两件事：
//   1. 参数属性（`constructor(private readonly x)`）必须被变换，`.js`→`.ts` 必须被解析；
//   2. 真实 Gateway 入口能起来、`/healthz` 可达，并且 SIGTERM 后以退出码 0 优雅退出。
//
// 这两条都是单测无法覆盖的：它们只在真实 Node 进程的模块解析与信号路径上才成立。
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

describe('Node 运行时解析钩子（DFR-M1-E02）', () => {
  it('解析 .js 说明符到 .ts，并变换 TS 参数属性', async () => {
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

  it('真实 Gateway 入口可启动、/healthz 可达，且 SIGTERM 后退出码为 0', async () => {
    const child = spawn(
      process.execPath,
      [...TS_FLAGS, '--import', REGISTER, 'apps/gateway/src/main.ts'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          // M0 只读部署：不需要数据库。
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

    // 就绪探针必须存在并返回可解析的结构（不强制 200：默认注册表在 M0 下没有启用任何链）。
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
