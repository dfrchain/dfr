/**
 * 模块依赖边界契约测试（DFR-M1-A04 起）。
 *
 * 目的：把 AGENTS.md 第 3 节与 docs/development/module-catalog.md 的
 * "禁止出现的依赖" 从人工纪律变成可回归断言。
 *
 * 为什么需要它：依赖方向一旦被破坏，往往不会让任何功能测试失败，
 * 却会让 Adapter 绑定到具体 Provider、让 Storage 反向依赖 Core，
 * 之后只能靠大规模重构挽回。这类退化必须在 CI 就被拦住。
 *
 * 注意：本测试只读取 package.json 的声明依赖，不解析源码 import。
 * 声明依赖是"能否 import"的唯一许可来源，因此足够守住边界。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface WorkspacePackage {
  /** 仓库相对目录，例如 `packages/core`、`adapters/evm`。 */
  readonly dir: string;
  readonly manifest: PackageManifest;
}

const WORKSPACE_ROOTS = ['packages', 'adapters', 'apps', 'sdk', 'services'] as const;

function readManifest(relPath: string): PackageManifest | null {
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) return null;
  return JSON.parse(readFileSync(abs, 'utf8')) as PackageManifest;
}

function workspacePackages(): readonly WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const root of WORKSPACE_ROOTS) {
    const absRoot = resolve(repoRoot, root);
    if (!existsSync(absRoot)) continue;
    for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      const manifest = readManifest(`${dir}/package.json`);
      if (manifest) found.push({ dir, manifest });
    }
  }
  return found;
}

const packages = workspacePackages();

/** 取运行时依赖名（不含 devDependencies）。 */
function runtimeDeps(pkg: WorkspacePackage): readonly string[] {
  return Object.keys(pkg.manifest.dependencies ?? {});
}

function find(dir: string): WorkspacePackage | undefined {
  return packages.find((p) => p.dir === dir);
}

describe('模块依赖边界（AGENTS.md 第 3 节 / module-catalog）', () => {
  it('workspace 发现全部已声明包', () => {
    // 基线：这些包在 M0 已完成或 M1 计划中，缺失说明扫描逻辑或目录被破坏。
    const dirs = packages.map((p) => p.dir);
    expect(dirs).toEqual(expect.arrayContaining(['packages/types', 'adapters/evm', 'apps/gateway']));
  });

  it('packages/types 不依赖任何工作区包（纯契约，叶子节点）', () => {
    const types = find('packages/types');
    expect(types, '缺少 packages/types').toBeTruthy();
    const workspaceDeps = runtimeDeps(types!).filter((d) => d.startsWith('@dfr/'));
    expect(workspaceDeps, 'Types 必须是依赖图的叶子').toEqual([]);
  });

  it('Core 不依赖任何 Adapter（Core 不得出现链特定分支）', () => {
    const core = find('packages/core');
    expect(core, '缺少 packages/core').toBeTruthy();
    const adapters = runtimeDeps(core!).filter((d) => d.startsWith('@dfr/adapter-'));
    expect(adapters, 'Core 直接依赖 Adapter 会让链语义渗入编排层').toEqual([]);
  });

  it('Provider 不依赖任何 Adapter（Provider 不理解链业务语义）', () => {
    const provider = find('packages/provider');
    expect(provider, '缺少 packages/provider').toBeTruthy();
    const adapters = runtimeDeps(provider!).filter((d) => d.startsWith('@dfr/adapter-'));
    expect(adapters).toEqual([]);
  });

  it('Adapter 不依赖 Gateway 或 Storage（链语义层不得反向依赖）', () => {
    const violations: string[] = [];
    for (const pkg of packages.filter((p) => p.dir.startsWith('adapters/'))) {
      for (const dep of runtimeDeps(pkg)) {
        if (dep === '@dfr/gateway' || dep.startsWith('@dfr/storage-')) {
          violations.push(`${pkg.dir} → ${dep}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('@dfr/transaction 包边界（DFR-M1-A04）', () => {
  it('包存在且使用 monorepo 约定的入口形状', () => {
    const tx = find('packages/transaction');
    expect(tx, '缺少 packages/transaction').toBeTruthy();
    expect(tx!.manifest.name).toBe('@dfr/transaction');
    expect(existsSync(resolve(repoRoot, 'packages/transaction/src/index.ts'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'packages/transaction/tsconfig.json'))).toBe(true);
  });

  it('运行时依赖只允许"叶子工具包"（types / errors / metrics）', () => {
    const tx = find('packages/transaction');
    expect(tx, '缺少 packages/transaction').toBeTruthy();
    // ADR-001 的模块化单体下，允许 Transaction 依赖**零领域知识的叶子工具包**。
    // 关键不在于"只有两个"，而在于这些包本身不得再依赖任何业务层——
    // 下面的循环把这条性质也断言掉，因此加入新工具包不会削弱约束。
    const allowed = new Set(['@dfr/types', '@dfr/errors', '@dfr/metrics']);
    const unexpected = runtimeDeps(tx!).filter((d) => !allowed.has(d));
    expect(unexpected, 'Transaction 不得依赖 Core/Adapter/Provider/Registry/Storage/数据库驱动').toEqual(
      [],
    );

    // 被允许的"叶子工具包"必须是真正的叶子：它们的依赖也只能是这些工具包。
    // 否则"工具包"会变成绕过边界的后门（例如 metrics 依赖 Provider 就会把链语义带进来）。
    for (const dep of allowed) {
      const dir = { '@dfr/types': 'packages/types', '@dfr/errors': 'packages/errors', '@dfr/metrics': 'packages/metrics' }[dep]!;
      const pkg = find(dir);
      expect(pkg, `缺少 ${dir}`).toBeTruthy();
      const transitive = runtimeDeps(pkg!).filter((d) => !allowed.has(d));
      expect(transitive, `${dep} 必须只依赖叶子工具包`).toEqual([]);
    }
  });

  it('声明 typecheck 脚本以便 pnpm -r 门禁覆盖该包', () => {
    const manifest = readManifest('packages/transaction/package.json') as
      | (PackageManifest & { scripts?: Record<string, string> })
      | null;
    expect(manifest?.scripts?.typecheck, '缺少 typecheck 脚本，会被 pnpm -r 静默跳过').toBeTruthy();
  });

  it('Store 端口不泄漏数据库驱动类型（pg / SQL / 连接池）', () => {
    // m1-storage-model 第 8 节：端口表达行为，不表达表。实现方负责把驱动细节
    // 留在 packages/storage-postgres；一旦 Store 接口出现 pg 类型，
    // Core 与全部单元测试都会被绑到具体数据库上。
    const srcDir = resolve(repoRoot, 'packages/transaction/src');
    const forbidden = [
      /from\s+['"]pg['"]/,
      /from\s+['"]postgres['"]/,
      /\bPool\b/,
      /\bPoolClient\b/,
      /\bQueryResult\b/,
      /\bSELECT\b/,
      /\bINSERT\b/,
      /\bUPDATE\b/,
      /\bBEGIN\b/,
    ];
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(resolve(srcDir, file), 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(source)) offenders.push(`${file} 命中 ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Core 只做 Store 的兼容 re-export，不重新定义端口', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/core/src/stores.ts'), 'utf8');
    // 不允许出现 interface / class 定义；只允许 export ... from '...'。
    expect(source).not.toMatch(/^\s*(export\s+)?(interface|class)\s/m);
    expect(source).toMatch(/from '@dfr\/transaction'/);
  });
});

describe('@dfr/storage-postgres 包边界（DFR-M1-A07）', () => {
  it('包存在（A07 起引入）', () => {
    const storage = find('packages/storage-postgres');
    expect(storage, '缺少 packages/storage-postgres').toBeTruthy();
    expect(storage!.manifest.name).toBe('@dfr/storage-postgres');
  });

  it('只实现 Store 端口：依赖限定为 transaction / types / errors / pg', () => {
    const storage = find('packages/storage-postgres');
    expect(storage, '缺少 packages/storage-postgres').toBeTruthy();
    const allowed = new Set(['@dfr/transaction', '@dfr/types', '@dfr/errors', 'pg']);
    const unexpected = runtimeDeps(storage!).filter((d) => !allowed.has(d));
    expect(unexpected, 'Storage 不得依赖 Core/Adapter/Provider/Registry/Gateway').toEqual([]);
    // 端口所有权在 transaction：Storage 必须依赖它，否则无法实现接口。
    expect(runtimeDeps(storage!)).toContain('@dfr/transaction');
  });

  it('只有 Gateway composition root 所在包可依赖 Storage', () => {
    const offenders: string[] = [];
    for (const pkg of packages) {
      if (pkg.dir === 'packages/storage-postgres' || pkg.dir === 'apps/gateway') continue;
      for (const dep of runtimeDeps(pkg)) {
        if (dep.startsWith('@dfr/storage-')) offenders.push(`${pkg.dir} → ${dep}`);
      }
    }
    expect(offenders, 'Core/Transaction 不得依赖具体数据库驱动').toEqual([]);
    expect(runtimeDeps(find('apps/gateway')!)).toContain('@dfr/storage-postgres');
  });

  it('Gateway 只有 main composition root 可 import 具体 Storage', () => {
    const srcDir = resolve(repoRoot, 'apps/gateway/src');
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts') || file === 'main.ts') continue;
      const source = readFileSync(resolve(srcDir, file), 'utf8');
      if (source.includes('@dfr/storage-')) offenders.push(file);
    }
    expect(offenders, 'Storage 不得渗入 Gateway 路由/auth/server').toEqual([]);
  });

  it('只有 storage-postgres 可以依赖 pg', () => {
    const offenders: string[] = [];
    for (const pkg of packages) {
      if (pkg.dir === 'packages/storage-postgres') continue;
      if (runtimeDeps(pkg).includes('pg')) offenders.push(pkg.dir);
    }
    expect(offenders, '除 Storage 外任何包都不得引入 pg').toEqual([]);
  });
});

describe('Viem 依赖边界（ADR-016）', () => {
  it('只有 adapters/evm 可以依赖 viem', () => {
    // ADR-016 §2：Viem 只能存在于 EVM Adapter；Types / Transaction / Gateway
    // 一旦依赖它，就会把第三方交易库类型泄漏进领域契约。
    const offenders: string[] = [];
    for (const pkg of packages) {
      if (pkg.dir === 'adapters/evm') continue;
      if (runtimeDeps(pkg).includes('viem')) offenders.push(pkg.dir);
    }
    expect(offenders, 'Viem 不得泄漏到 EVM Adapter 之外').toEqual([]);
    expect(runtimeDeps(find('adapters/evm')!)).toContain('viem');
  });

  it('adapters/evm 使用精确 Viem 版本（ADR-016 §6）', () => {
    const evm = find('adapters/evm');
    expect(evm, '缺少 adapters/evm').toBeTruthy();
    // 精确版本而非 ^ / ~ / latest：升级必须显式改 lockfile 并重跑 golden vectors。
    expect(evm!.manifest.dependencies?.['viem']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
