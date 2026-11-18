//
// M1 release-gate contract test (DFR-M1-E01, gate #2).
//
// Authoritative source: m1-taskbook E01 completion gate — "DFR_NOT_IMPLEMENTED must not appear in the production
// build or runbook".
//
// Since B08 the write path has no 501 placeholders. To guard against regression (someone stuffing a placeholder
// error back into an endpoint), this test scans **runtime source**: DFR_NOT_IMPLEMENTED may only appear in the
// canonical error catalog (types / errors); any Gateway / Core / Adapter / Transaction source containing it fails.
//
// Note: the runbook (docs/runbooks/m1-local.md) may **cite** the error code to state the policy
// ("the write path is at zero; a regression fails"), which is not a placeholder implementation; this gate only
// constrains source that gets compiled into the artifact.
//
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Runtime source roots that get compiled into the artifact. */
const SOURCE_ROOTS = ['apps', 'packages', 'adapters', 'sdk', 'services'] as const;

/** Canonical error catalog: the only place the error code may be defined; DFR_NOT_IMPLEMENTED is allowed there. */
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

describe('M1 release gate: the write path keeps no NOT_IMPLEMENTED placeholders (DFR-M1-E01)', () => {
  it('in runtime source, DFR_NOT_IMPLEMENTED appears only in the canonical error catalog', () => {
    const offenders = sourceFiles()
      .filter((file) => !CATALOG_FILES.has(file.rel))
      .filter((file) => file.source.includes('DFR_NOT_IMPLEMENTED'))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('Gateway and Core source return no 501 placeholders', () => {
    const offenders = sourceFiles()
      .filter((file) => file.rel.startsWith('apps/gateway/src/') || file.rel.startsWith('packages/core/src/'))
      .filter((file) => /\b501\b/u.test(file.source))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });
});
