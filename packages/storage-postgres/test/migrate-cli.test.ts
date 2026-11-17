// 迁移 CLI 契约测试（DFR-M1-E02）。
//
// 默认只跑离线断言（缺 DSN 的 fail-closed）；真实数据库部分需要
// `DFR_TRANSACTION_RUNNER_DATABASE_URL`（`pnpm test:db` 会导出）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MigrateCliError, runMigrateCli } from '../src/migrate-cli.js';

const RUNNER_DSN = process.env['DFR_TRANSACTION_RUNNER_DATABASE_URL'];
const ENABLED = typeof RUNNER_DSN === 'string' && RUNNER_DSN.length > 0;

describe('迁移 CLI（DFR-M1-E02）', () => {
  it('缺少 DFR_TRANSACTION_MIGRATION_DATABASE_URL 时 fail-closed，且不回显任何 DSN', async () => {
    let caught: unknown;
    try {
      await runMigrateCli({ env: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrateCliError);
    expect((caught as Error).message).toContain('DFR_TRANSACTION_MIGRATION_DATABASE_URL');
    // 迁移身份与运行时身份必须是两个变量：不给 runtime DSN 也应当照样失败。
    await expect(
      runMigrateCli({ env: { DFR_TRANSACTION_DATABASE_URL: 'postgres://x:y@z/db' } }),
    ).rejects.toBeInstanceOf(MigrateCliError);
  });

  it.skipIf(!ENABLED)('真实库上幂等：第二次执行不再应用任何迁移，且覆盖全部已知迁移', async () => {
    // 注意：runner 库与 migrations.test.ts 共用，迁移可能已被前者应用，
    // 因此不能假设"第一次一定全量应用"。改为断言**幂等性**与**迁移集合完整**。
    const first = await runMigrateCli({
      env: { DFR_TRANSACTION_MIGRATION_DATABASE_URL: RUNNER_DSN },
    });

    const second = await runMigrateCli({
      env: { DFR_TRANSACTION_MIGRATION_DATABASE_URL: RUNNER_DSN },
    });
    expect([...second.applied]).toEqual([]);
    // 第二次跳过的集合 = 第一次应用 + 第一次跳过，即磁盘上全部迁移。
    expect(new Set(second.skipped)).toEqual(new Set([...first.applied, ...first.skipped]));
    expect(second.skipped.length).toBeGreaterThanOrEqual(5);
    // 最新迁移必须是 ADR-022 的 state_version 下界修复。
    expect([...second.skipped]).toContain('0005_transaction_state_version_zero.sql');
  });

  it.skipIf(!ENABLED)('迁移 SQL 报错时整体失败，且错误不携带 DSN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfr-migrate-cli-'));
    try {
      writeFileSync(join(dir, '0001_bad.sql'), 'THIS IS NOT SQL;\n');
      let caught: unknown;
      try {
        await runMigrateCli({
          env: { DFR_TRANSACTION_MIGRATION_DATABASE_URL: RUNNER_DSN },
          migrationsDir: dir,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(JSON.stringify(caught)).not.toContain(RUNNER_DSN!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
