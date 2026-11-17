/**
 * chains.schema.json 的加载与编译。
 *
 * 规范（packages/registry/config/README.md）：启动校验（DFR-005）与 CI 必须
 * 对**同一份** schema 求值，避免规则随实现漂移（评审修正 R-13）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';

/** ajv-formats 是 CJS 包，在 NodeNext + verbatimModuleSyntax 下必须显式 require。 */
const requireCjs = createRequire(import.meta.url);
const addFormats = requireCjs('ajv-formats') as FormatsPlugin;

/** 本包 config 目录的绝对路径。 */
export const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../config');

/** 默认注册表文件路径。 */
export const DEFAULT_REGISTRY_FILE = resolve(CONFIG_DIR, 'chains.yaml');

/** schema 文件路径。 */
export const REGISTRY_SCHEMA_FILE = resolve(CONFIG_DIR, 'chains.schema.json');

/** 读取并解析 schema（JSON）。 */
export function loadSchema(path: string = REGISTRY_SCHEMA_FILE): object {
  return JSON.parse(readFileSync(path, 'utf8')) as object;
}

/**
 * 编译校验器。
 *
 * `strict: true` 是刻意的：schema 写错时应当启动失败，而不是被静默忽略。
 */
export function compileSchema(path: string = REGISTRY_SCHEMA_FILE) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(loadSchema(path));
}
