//
// M1 发布门契约测试（DFR-M1-E01，门 #2）。
//
// 权威来源：m1-taskbook E01 完成门——"生产构建与运行手册中不出现 DFR_NOT_IMPLEMENTED"。
//
// B08 之后写路径已无 501 占位。为防止回归（有人在端点里塞回占位错误），本测试扫描
// **运行时源码**：DFR_NOT_IMPLEMENTED 只允许出现在规范错误目录（types / errors），
// 任何 Gateway / Core / Adapter / Transaction 源码出现它即失败。
//
// 说明：运行手册（docs/runbooks/m1-local.md）可以**引用**该错误码来声明策略
// （"写路径已归零，回归即失败"），这不是占位实现；本门只约束会被编译进产物的源码。
//
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 会被编译进产物的运行时源码根目录。 */
const SOURCE_ROOTS = ['apps', 'packages', 'adapters', 'sdk', 'services'] as const;

/** 规范错误目录：错误码的唯一定义处，允许出现 DFR_NOT_IMPLEMENTED。 */
const CATALOG_FILES = new Set([
  'packages/types/src/errors.ts',
  'packages/errors/src/metadata.ts',
]);

const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/u;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) out.push(abs);
  }
  return out;
}

function sourceFiles(): { rel: string; source: string }[] {
  const files: { rel: string; source: string }[] = [];
  for (const root of SOURCE_ROOTS) {
    const abs = resolve(repoRoot, root);
    for (const file of walk(abs)) {
      files.push({ rel: relative(repoRoot, file), source: readFileSync(file, 'utf8') });
    }
  }
  return files;
}

describe('M1 发布门：写路径不残留 NOT_IMPLEMENTED 占位（DFR-M1-E01）', () => {
  it('运行时源码中 DFR_NOT_IMPLEMENTED 只出现在规范错误目录', () => {
    const offenders = sourceFiles()
      .filter((file) => !CATALOG_FILES.has(file.rel))
      .filter((file) => file.source.includes('DFR_NOT_IMPLEMENTED'))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('Gateway 与 Core 源码不返回 501 占位', () => {
    const offenders = sourceFiles()
      .filter((file) => file.rel.startsWith('apps/gateway/src/') || file.rel.startsWith('packages/core/src/'))
      .filter((file) => /\b501\b/u.test(file.source))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });
});
