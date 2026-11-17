#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', 'out']);

function parseArgs(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 2 && argv[0] === '--root') return resolve(argv[1]);
  throw new Error('usage: node scripts/check-dependency-lock.mjs [--root <repository-root>]');
}

function packageManifests(root) {
  const manifests = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(resolve(dir, entry.name));
      } else if (entry.name === 'package.json') {
        manifests.push(resolve(dir, entry.name));
      }
    }
  }
  walk(root);
  return manifests.sort();
}

function declaredDependencies(manifest) {
  return Object.assign({}, manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies);
}

function fail(message) {
  process.stderr.write(`dependency-lock: ${message}\n`);
  process.exitCode = 1;
}

try {
  const root = parseArgs(process.argv.slice(2));
  const lockPath = resolve(root, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) throw new Error(`missing pnpm-lock.yaml in ${root}`);

  const lock = YAML.parse(readFileSync(lockPath, 'utf8'));
  if (!lock || typeof lock !== 'object' || !lock.importers || typeof lock.importers !== 'object') {
    throw new Error('pnpm-lock.yaml must contain an importers map');
  }

  const errors = [];
  const manifestImporters = new Set();
  for (const manifestPath of packageManifests(root)) {
    const packageDir = resolve(manifestPath, '..');
    const importerName = relative(root, packageDir) || '.';
    manifestImporters.add(importerName);

    const importer = lock.importers[importerName];
    if (!importer || typeof importer !== 'object') {
      errors.push(`${importerName}: package.json has no matching pnpm-lock importer`);
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const locked = declaredDependencies(importer);
    for (const [name, specifier] of Object.entries(declaredDependencies(manifest))) {
      const entry = locked[name];
      if (!entry || typeof entry !== 'object') {
        errors.push(`${importerName}: ${name} is declared in package.json but missing from pnpm-lock.yaml`);
      } else if (entry.specifier !== specifier) {
        errors.push(`${importerName}: ${name} specifier differs (package.json=${specifier}, pnpm-lock.yaml=${entry.specifier})`);
      } else if (typeof entry.version !== 'string' || entry.version.length === 0) {
        errors.push(`${importerName}: ${name} has no resolved version in pnpm-lock.yaml`);
      }
    }
  }

  for (const importerName of Object.keys(lock.importers)) {
    if (!manifestImporters.has(importerName)) {
      errors.push(`${importerName}: pnpm-lock importer has no matching package.json`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors.sort()) fail(error);
  } else {
    process.stdout.write('dependency-lock: package.json declarations match pnpm-lock.yaml importers\n');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
