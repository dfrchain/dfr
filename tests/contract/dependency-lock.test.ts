import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dfr-dependency-lock-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'], devDependencies: { vitest: '^5.0.3' } }),
  );
  writeFileSync(
    join(root, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^5.0.3\n        version: 5.0.3\n`,
  );
  return root;
}

function runGate(root: string): { status: number | null; output: string } {
  try {
    const output = execFileSync('node', ['scripts/check-dependency-lock.mjs', '--root', root], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const e = error as { status: number | null; stdout?: string; stderr?: string };
    return { status: e.status, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('依赖声明与 pnpm 锁文件门禁', () => {
  it('package.json 暴露门禁且 verify 会执行它', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check:dependency-lock']).toBeTruthy();
    expect(pkg.scripts.verify).toContain('check:dependency-lock');
  });

  it('声明版本与锁文件一致时通过', () => {
    const root = copyFixture();
    try {
      expect(runGate(root)).toMatchObject({ status: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('锁文件中同一依赖的声明版本漂移时拒绝', () => {
    const root = copyFixture();
    try {
      const lockPath = join(root, 'pnpm-lock.yaml');
      writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace('specifier: ^5.0.3', 'specifier: ^5.1.0'));
      const outcome = runGate(root);
      expect(outcome.status).not.toBe(0);
      expect(outcome.output).toContain('vitest');
      expect(outcome.output).toContain('specifier');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
