// 迁移 CLI（DFR-M1-E02）。
//
// 为什么需要它：`runMigrations()` 只是库函数，容器化/全新环境没有任何入口能
// "应用迁移"。E01 的运行手册写了迁移步骤，却没有可执行命令；E02 补上这个入口，
// 让"从干净环境部署"真的可执行。
//
// 与运行时的分离（ADR-015 / m1-local-database.md）：
//   - 本 CLI 只读 `DFR_TRANSACTION_MIGRATION_DATABASE_URL`（可 DDL 的迁移身份）；
//   - 应用进程只读 `DFR_TRANSACTION_DATABASE_URL`（仅 DML 的运行时身份）；
//   - 两个身份不共用凭证，应用容器不持有迁移身份。
//
// 安全：永不打印 DSN 或驱动异常原文（可能含口令）；失败只报固定文案 + 退出码。
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { loadMigrations, runMigrations, type MigrationRunResult } from './migrate.js';

export interface MigrateCliOptions {
  /** 注入点：默认 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 注入点：默认包内 `migrations/`。 */
  readonly migrationsDir?: string;
}

export class MigrateCliError extends Error {
  override readonly name = 'MigrateCliError';
}

function defaultMigrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

/**
 * 应用全部前向迁移。重复执行是幂等的：已应用且 checksum 一致的会被跳过。
 *
 * 抛出 `MigrateCliError` 表示缺少 DSN；其它异常（连通性、checksum 不一致、
 * 迁移文件缺失）原样上抛，由调用方决定退出码，但**不得**回显原文。
 */
export async function runMigrateCli(options: MigrateCliOptions = {}): Promise<MigrationRunResult> {
  const env = options.env ?? process.env;
  const databaseUrl = env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new MigrateCliError('DFR_TRANSACTION_MIGRATION_DATABASE_URL is required');
  }

  const migrations = loadMigrations(options.migrationsDir ?? defaultMigrationsDir());
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await runMigrations({ client, migrations });
  } finally {
    await client.end();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  void runMigrateCli()
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({
          level: 'info',
          msg: 'migrations applied',
          applied: result.applied.length,
          skipped: result.skipped.length,
        })}\n`,
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof MigrateCliError ? error.message : 'migration failed';
      process.stderr.write(`${JSON.stringify({ level: 'error', msg: message })}\n`);
      process.exitCode = 1;
    });
}
