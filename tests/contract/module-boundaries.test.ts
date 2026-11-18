/**
 * Module dependency-boundary contract test (since DFR-M1-A04).
 *
 * Purpose: turn the "forbidden dependencies" in AGENTS.md §3 and docs/development/module-catalog.md from human
 * discipline into regressable assertions.
 *
 * Why it is needed: once a dependency direction breaks, often no functional test fails, yet Adapters get bound
 * to a concrete Provider and Storage ends up depending on Core, and only a large refactor can recover afterwards.
 * This kind of regression must be caught in CI.
 *
 * Note: this test only reads declared dependencies in package.json; it does not parse source imports.
 * Declared dependencies are the only licence source for "may import", so that is enough to hold the boundary.
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
  /** Repo-relative directory, e.g. `packages/core`, `adapters/evm`. */
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

/** Takes runtime dependency names (excluding devDependencies). */
function runtimeDeps(pkg: WorkspacePackage): readonly string[] {
  return Object.keys(pkg.manifest.dependencies ?? {});
}

function find(dir: string): WorkspacePackage | undefined {
  return packages.find((p) => p.dir === dir);
}

describe('Module dependency boundaries (AGENTS.md §3 / module-catalog)', () => {
  it('workspace discovery finds all declared packages', () => {
    // Baseline: these packages were done in M0 or planned in M1; a missing one means the scan logic or directory is broken.
    const dirs = packages.map((p) => p.dir);
    expect(dirs).toEqual(expect.arrayContaining(['packages/types', 'adapters/evm', 'apps/gateway']));
  });

  it('packages/types depends on no workspace package (pure contract, a leaf node)', () => {
    const types = find('packages/types');
    expect(types, 'missing packages/types').toBeTruthy();
    const workspaceDeps = runtimeDeps(types!).filter((d) => d.startsWith('@dfr/'));
    expect(workspaceDeps, 'Types must be a leaf of the dependency graph').toEqual([]);
  });

  it('Core depends on no Adapter (Core must have no chain-specific branches)', () => {
    const core = find('packages/core');
    expect(core, 'missing packages/core').toBeTruthy();
    const adapters = runtimeDeps(core!).filter((d) => d.startsWith('@dfr/adapter-'));
    expect(adapters, 'Core depending directly on an Adapter would let chain semantics seep into the orchestration layer').toEqual([]);
  });

  it('Provider depends on no Adapter (Provider does not understand chain business semantics)', () => {
    const provider = find('packages/provider');
    expect(provider, 'missing packages/provider').toBeTruthy();
    const adapters = runtimeDeps(provider!).filter((d) => d.startsWith('@dfr/adapter-'));
    expect(adapters).toEqual([]);
  });

  it('Adapters do not depend on Gateway or Storage (the chain-semantics layer must not depend backwards)', () => {
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

describe('@dfr/transaction package boundary (DFR-M1-A04)', () => {
  it('the package exists and uses the monorepo-agreed entry shape', () => {
    const tx = find('packages/transaction');
    expect(tx, 'missing packages/transaction').toBeTruthy();
    expect(tx!.manifest.name).toBe('@dfr/transaction');
    expect(existsSync(resolve(repoRoot, 'packages/transaction/src/index.ts'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'packages/transaction/tsconfig.json'))).toBe(true);
  });

  it('runtime dependencies allow only "leaf utility packages" (types / errors / metrics)', () => {
    const tx = find('packages/transaction');
    expect(tx, 'missing packages/transaction').toBeTruthy();
    // Under ADR-001's modular monolith, Transaction may depend on **leaf utility packages with zero domain
    // knowledge**. The point is not "only two", but that these packages themselves must not depend on any
    // business layer — the loop below asserts that property too, so adding a new utility package does not
    // weaken the constraint.
    const allowed = new Set(['@dfr/types', '@dfr/errors', '@dfr/metrics']);
    const unexpected = runtimeDeps(tx!).filter((d) => !allowed.has(d));
    expect(unexpected, 'Transaction must not depend on Core/Adapter/Provider/Registry/Storage/database drivers').toEqual(
      [],
    );

    // The allowed "leaf utility packages" must be real leaves: their dependencies may only be these utility
    // packages. Otherwise a "utility package" becomes a back door around the boundary (e.g. metrics depending
    // on Provider would bring chain semantics in).
    for (const dep of allowed) {
      const dir = { '@dfr/types': 'packages/types', '@dfr/errors': 'packages/errors', '@dfr/metrics': 'packages/metrics' }[dep]!;
      const pkg = find(dir);
      expect(pkg, `missing ${dir}`).toBeTruthy();
      const transitive = runtimeDeps(pkg!).filter((d) => !allowed.has(d));
      expect(transitive, `${dep} must depend only on leaf utility packages`).toEqual([]);
    }
  });

  it('declares a typecheck script so the pnpm -r gate covers this package', () => {
    const manifest = readManifest('packages/transaction/package.json') as
      | (PackageManifest & { scripts?: Record<string, string> })
      | null;
    expect(manifest?.scripts?.typecheck, 'missing typecheck script; pnpm -r would silently skip it').toBeTruthy();
  });

  it('the Store port does not leak database driver types (pg / SQL / connection pool)', () => {
    // m1-storage-model §8: ports express behaviour, not tables. The implementer keeps driver details
    // in packages/storage-postgres; once a pg type appears in the Store interface,
    // Core and all unit tests get bound to a concrete database.
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
        if (pattern.test(source)) offenders.push(`${file} matched ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Core only does a compatibility re-export of Store, not redefining the port', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/core/src/stores.ts'), 'utf8');
    // interface / class definitions are not allowed; only export ... from '...' is.
    expect(source).not.toMatch(/^\s*(export\s+)?(interface|class)\s/m);
    expect(source).toMatch(/from '@dfr\/transaction'/);
  });
});

describe('@dfr/storage-postgres package boundary (DFR-M1-A07)', () => {
  it('the package exists (introduced in A07)', () => {
    const storage = find('packages/storage-postgres');
    expect(storage, 'missing packages/storage-postgres').toBeTruthy();
    expect(storage!.manifest.name).toBe('@dfr/storage-postgres');
  });

  it('only implements the Store port: dependencies limited to transaction / types / errors / pg', () => {
    const storage = find('packages/storage-postgres');
    expect(storage, 'missing packages/storage-postgres').toBeTruthy();
    const allowed = new Set(['@dfr/transaction', '@dfr/types', '@dfr/errors', 'pg']);
    const unexpected = runtimeDeps(storage!).filter((d) => !allowed.has(d));
    expect(unexpected, 'Storage must not depend on Core/Adapter/Provider/Registry/Gateway').toEqual([]);
    // Port ownership is in transaction: Storage must depend on it, otherwise it cannot implement the interface.
    expect(runtimeDeps(storage!)).toContain('@dfr/transaction');
  });

  it('only the package holding the Gateway composition root may depend on Storage', () => {
    const offenders: string[] = [];
    for (const pkg of packages) {
      if (pkg.dir === 'packages/storage-postgres' || pkg.dir === 'apps/gateway') continue;
      for (const dep of runtimeDeps(pkg)) {
        if (dep.startsWith('@dfr/storage-')) offenders.push(`${pkg.dir} → ${dep}`);
      }
    }
    expect(offenders, 'Core/Transaction must not depend on a concrete database driver').toEqual([]);
    expect(runtimeDeps(find('apps/gateway')!)).toContain('@dfr/storage-postgres');
  });

  it('only the Gateway main composition root may import concrete Storage', () => {
    const srcDir = resolve(repoRoot, 'apps/gateway/src');
    const offenders: string[] = [];
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts') || file === 'main.ts') continue;
      const source = readFileSync(resolve(srcDir, file), 'utf8');
      if (source.includes('@dfr/storage-')) offenders.push(file);
    }
    expect(offenders, 'Storage must not seep into Gateway routes/auth/server').toEqual([]);
  });

  it('only storage-postgres may depend on pg', () => {
    const offenders: string[] = [];
    for (const pkg of packages) {
      if (pkg.dir === 'packages/storage-postgres') continue;
      if (runtimeDeps(pkg).includes('pg')) offenders.push(pkg.dir);
    }
    expect(offenders, 'no package other than Storage may bring in pg').toEqual([]);
  });
});

describe('Viem dependency boundary (ADR-016)', () => {
  it('only adapters/evm may depend on viem', () => {
    // ADR-016 §2: Viem may only live in the EVM Adapter; once Types / Transaction / Gateway depend on it,
    // third-party transaction-library types leak into the domain contract.
    const offenders: string[] = [];
    for (const pkg of packages) {
      if (pkg.dir === 'adapters/evm') continue;
      if (runtimeDeps(pkg).includes('viem')) offenders.push(pkg.dir);
    }
    expect(offenders, 'Viem must not leak outside the EVM Adapter').toEqual([]);
    expect(runtimeDeps(find('adapters/evm')!)).toContain('viem');
  });

  it('adapters/evm uses an exact Viem version (ADR-016 §6)', () => {
    const evm = find('adapters/evm');
    expect(evm, 'missing adapters/evm').toBeTruthy();
    // An exact version, not ^ / ~ / latest: an upgrade must explicitly change the lockfile and re-run the golden vectors.
    expect(evm!.manifest.dependencies?.['viem']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
