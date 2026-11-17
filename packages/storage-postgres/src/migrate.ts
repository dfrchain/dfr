/**
 * 迁移运行器（DFR-M1-A08）。
 *
 * 权威来源：ADR-015 §3、docs/architecture/m1-storage-model.md。
 *
 * 语义（每一条都有对应测试）：
 *   1. **按文件名顺序**执行：`0001_*.sql` 先于 `0002_*.sql`；
 *   2. **版本表 + checksum**：已应用的迁移记录 sha256，内容改变即报错，
 *      防止"改了已上线的迁移导致各环境 schema 分叉"；
 *   3. **每个迁移一个事务**：迁移 SQL 与版本行同事务提交；
 *      中途失败必须整体回滚，不留半应用状态；
 *   4. **只前向**：不提供 down migration（ADR-015 §3），修复靠新迁移；
 *   5. 版本表独立于业务 schema，避免污染 `transaction_data` 的表集合。
 *
 * 边界：
 *   - 本模块只负责执行 SQL，不生成 SQL、不做 schema diff、不连接池管理；
 *   - 调用方（CLI / composition root / 测试）负责提供已连接的 `Client`
 *     与要执行的迁移列表。
 *
 * 迁移 SQL 中**禁止**出现事务控制语句（BEGIN/COMMIT/ROLLBACK）：
 * 运行器已经为每个迁移开事务，嵌套会让"失败整体回滚"的保证失效。
 * 违反时抛出 `transaction_control_in_migration` 而不是静默执行。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';

/** 一个待执行的迁移。`name` 同时是排序键与版本表主键。 */
export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** 版本表所在 schema 的默认名。刻意与业务 schema `transaction_data` 分离。 */
export const DEFAULT_MIGRATIONS_SCHEMA = 'dfr_migrations';
/** 版本表默认名。 */
export const DEFAULT_MIGRATIONS_TABLE = 'schema_migrations';

export type MigrationErrorReason =
  /** 已应用的迁移内容被修改（checksum 不匹配）。 */
  | 'checksum_mismatch'
  /** 版本表里有记录，但本次提供的迁移列表中缺失该文件。 */
  | 'applied_migration_missing'
  /** 迁移名重复。 */
  | 'duplicate_migration_name'
  /** 迁移 SQL 含事务控制语句。 */
  | 'transaction_control_in_migration'
  /** schema / 表名不是安全标识符。 */
  | 'invalid_identifier';

export class MigrationError extends Error {
  readonly reason: MigrationErrorReason;
  /** 涉及的迁移名（若适用）。 */
  readonly migrationName?: string;

  constructor(reason: MigrationErrorReason, message: string, migrationName?: string) {
    super(message);
    this.name = 'MigrationError';
    this.reason = reason;
    if (migrationName !== undefined) this.migrationName = migrationName;
  }
}

/** 计算迁移内容的 sha256（hex）。对空白差异敏感——这是刻意的。 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * 从目录加载全部 `*.sql`，按文件名升序。
 *
 * 排序使用默认的字符串比较（非 locale 相关），保证跨平台一致；
 * 因此命名必须用零填充数字前缀（`0001_`、`0002_`）。
 */
export function loadMigrations(dir: string): readonly MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return names.map((name) => ({
    name,
    sql: readFileSync(join(dir, name), 'utf8'),
  }));
}

export interface RunMigrationsOptions {
  /** 已连接的客户端。事务由本函数管理。 */
  readonly client: Client;
  readonly migrations: readonly MigrationFile[];
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
}

export interface MigrationRunResult {
  /** 本次实际执行的迁移名（按执行顺序）。 */
  readonly applied: readonly string[];
  /** 本次跳过（已应用且 checksum 一致）的迁移名。 */
  readonly skipped: readonly string[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*;/imu;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new MigrationError('invalid_identifier', `${label} 不是安全标识符：${value}`);
  }
}

function assertNoTransactionControl(migration: MigrationFile): void {
  if (TRANSACTION_CONTROL.test(migration.sql)) {
    throw new MigrationError(
      'transaction_control_in_migration',
      `迁移 ${migration.name} 含事务控制语句；运行器已为每个迁移开事务，` +
        '嵌套会破坏"失败整体回滚"的保证。',
      migration.name,
    );
  }
}

function ensureUniqueNames(migrations: readonly MigrationFile[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.name)) {
      throw new MigrationError(
        'duplicate_migration_name',
        `迁移名重复：${migration.name}`,
        migration.name,
      );
    }
    seen.add(migration.name);
  }
}

/**
 * 前向执行迁移。
 *
 * 不吞异常：任何失败都会向上抛出，调用方决定如何呈现。
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationRunResult> {
  const { client } = options;
  const schema = options.migrationsSchema ?? DEFAULT_MIGRATIONS_SCHEMA;
  const table = options.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE;
  assertIdentifier(schema, 'migrationsSchema');
  assertIdentifier(table, 'migrationsTable');

  ensureUniqueNames(options.migrations);

  // 版本表先于一切：它自身也必须可重复执行。
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${schema}.${table} (
       name        text PRIMARY KEY,
       checksum    text NOT NULL,
       applied_at  timestamptz NOT NULL DEFAULT clock_timestamp()
     )`,
  );

  const { rows } = await client.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM ${schema}.${table}`,
  );
  const appliedBefore = new Map(rows.map((r) => [r.name, r.checksum]));

  const ordered = [...options.migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const provided = new Set(ordered.map((m) => m.name));

  // 版本表里有、但本次列表里没有：说明迁移文件被删除或目录被换过。
  // 静默忽略会让各环境 schema 永久分叉，所以必须显式失败。
  for (const name of appliedBefore.keys()) {
    if (!provided.has(name)) {
      throw new MigrationError(
        'applied_migration_missing',
        `版本表已记录迁移 ${name}，但本次未提供该文件；` +
          '迁移文件不得删除，修复请新增前向迁移。',
        name,
      );
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of ordered) {
    const checksum = checksumOf(migration.sql);
    const previous = appliedBefore.get(migration.name);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new MigrationError(
          'checksum_mismatch',
          `迁移 ${migration.name} 已应用，但内容已改变（期望 ${previous}，实际 ${checksum}）。` +
            '已应用的迁移不得修改，请新增前向迁移。',
          migration.name,
        );
      }
      skipped.push(migration.name);
      continue;
    }

    assertNoTransactionControl(migration);

    // 迁移 SQL 与版本行同事务：失败则整体回滚，不留半应用状态。
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${schema}.${table} (name, checksum) VALUES ($1, $2)`,
        [migration.name, checksum],
      );
      await client.query('COMMIT');
      applied.push(migration.name);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 回滚失败不覆盖原始错误：原始错误才是根因。
      }
      throw error;
    }
  }

  return { applied, skipped };
}
