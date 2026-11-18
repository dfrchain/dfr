/**
 * Loading and compiling chains.schema.json.
 *
 * Rule (packages/registry/config/README.md): startup validation (DFR-005) and CI must
 * evaluate the **same** schema, so rules cannot drift with the implementation (review fix R-13).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';

/** ajv-formats is a CJS package and must be explicitly required under NodeNext + verbatimModuleSyntax. */
const requireCjs = createRequire(import.meta.url);
const addFormats = requireCjs('ajv-formats') as FormatsPlugin;

/** Absolute path of this package's config directory. */
export const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../config');

/** Default registry file path. */
export const DEFAULT_REGISTRY_FILE = resolve(CONFIG_DIR, 'chains.yaml');

/** Schema file path. */
export const REGISTRY_SCHEMA_FILE = resolve(CONFIG_DIR, 'chains.schema.json');

/** Read and parse the schema (JSON). */
export function loadSchema(path: string = REGISTRY_SCHEMA_FILE): object {
  return JSON.parse(readFileSync(path, 'utf8')) as object;
}

/**
 * Compile the validator.
 *
 * `strict: true` is deliberate: a bad schema should fail startup, not be silently ignored.
 */
export function compileSchema(path: string = REGISTRY_SCHEMA_FILE) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(loadSchema(path));
}
