/**
 * 迁移运行器契约测试（DFR-M1-A08）。
 *
 * 权威来源：ADR-015 §3、docs/architecture/m1-storage-model.md。
 *
 * 默认**跳过**；显式开启：
 *
 *   DFR_TRANSACTION_RUNNER_DATABASE_URL=postgres://dfr_migrator:...@127.0.0.1:55432/dfr_m1_runner_test \
 *   pnpm vitest run packages/storage-postgres/test/migrations.test.ts
 *
 * 或直接 `pnpm test:db`（脚本会导出全部所需 DSN）。
 *
 * 该库是**独立**的（`dfr_m1_runner_test`）：schema 契约测试会在自己的库上
 * DROP SCHEMA，两个测试文件若共用同一数据库会互相破坏。
 *
 * 覆盖任务卡要求的四种情形：首次应用、重复运行、checksum 改变、半途失败回滚。
 * 另加三类防御性边界：已应用迁移缺失、事务控制语句、迁移名重复。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import {
  DEFAULT_MIGRATIONS_SCHEMA,
  checksumOf,
  loadMigrations,
  runMigrations,
  type MigrationFile,
} from '../src/migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const realMigrationsDir = resolve(packageRoot, 'migrations');

const RUNNER_DSN = process.env['DFR_TRANSACTION_RUNNER_DATABASE_URL'];
const ENABLED = typeof RUNNER_DSN === 'string' && RUNNER_DSN.length > 0;

/** 合成迁移使用的 scratch schema，刻意与 transaction_data 分开。 */
const SCRATCH = 'mig_probe';

const M1: MigrationFile = {
  name: '0001_probe_base.sql',
  sql: `CREATE SCHEMA IF NOT EXISTS ${SCRATCH};\nCREATE TABLE ${SCRATCH}.base (id int PRIMARY KEY);\n`,
};
const M2: MigrationFile = {
  name: '0002_probe_more.sql',
  sql: `ALTER TABLE ${SCRATCH}.base ADD COLUMN note text;\n`,
};
/** 先建表再故意报错：用于验证"半途失败整体回滚"。 */
const M_FAIL: MigrationFile = {
  name: '0003_probe_fail.sql',
  sql: `CREATE TABLE ${SCRATCH}.half (i int);\nSELECT 1 / 0;\n`,
};

/**
 * 迁移 SQL 自身成功，但**版本行写入失败**。
 *
 * 这是唯一能区分"运行器是否显式管理事务"的场景：
 * PostgreSQL 会把单条多语句查询放进隐式事务，所以「迁移 SQL 内部报错」
 * 不依赖运行器也会回滚。但版本行由运行器在**另一条** query 中写入，
 * 只有显式 BEGIN/COMMIT 才能让"迁移已执行的 DDL"与"版本行"同生共死。
 *
 * 这里让迁移 SQL 抢先插入一条同名版本行，使运行器随后的 INSERT 触发主键冲突。
 */
const M_COLLIDE: MigrationFile = {
  name: '0004_probe_collide.sql',
  sql:
    `CREATE TABLE ${SCRATCH}.collide (i int);\n` +
    `INSERT INTO ${DEFAULT_MIGRATIONS_SCHEMA}.schema_migrations (name, checksum)\n` +
    `VALUES ('0004_probe_collide.sql', 'placeholder');\n`,
};

let client: Client;

async function resetSchemas(): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${DEFAULT_MIGRATIONS_SCHEMA} CASCADE`);
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return rows[0]!.n !== '0';
}

async function appliedNames(): Promise<readonly string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT name FROM ${DEFAULT_MIGRATIONS_SCHEMA}.schema_migrations ORDER BY name`,
  );
  return rows.map((r) => r.name);
}

beforeAll(async () => {
  if (!ENABLED) return;
  client = new Client({ connectionString: RUNNER_DSN });
  await client.connect();
  const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
  const db = rows[0]!.db;
  // 安全护栏：只允许对测试库操作（本文件会 DROP SCHEMA）。
  if (!/_test$/u.test(db)) {
    throw new Error(`拒绝在非测试库 "${db}" 上执行迁移测试（库名必须以 _test 结尾）`);
  }
  await resetSchemas();
}, 60_000);

afterAll(async () => {
  if (ENABLED && client) await client.end();
});

describe.skipIf(!ENABLED)('迁移运行器（DFR-M1-A08）', () => {
  it('仓库中 D04 migration 只扩展 nullable anchor 列（0004）', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const d04 = migrations.find((m) => m.name === '0004_transaction_canonical_block_hash.sql');
    expect(d04).toBeDefined();
    expect(d04?.sql).toMatch(/ADD COLUMN canonical_block_hash text\s*;/u);
    expect(d04?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE/iu);
  });

  it('仓库迁移按文件名严格升序且无重复，0005 只放宽 state_version 下界', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const names = migrations.map((m) => m.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);

    const d07 = migrations.find((m) => m.name === '0005_transaction_state_version_zero.sql');
    expect(d07).toBeDefined();
    // 只允许放宽 state_version 约束，不得顺手改列类型或删数据。
    expect(d07?.sql).toMatch(/CHECK\s*\(state_version\s*>=\s*0\)/u);
    expect(d07?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE|DELETE\s+FROM/iu);
  });

  it('仓库迁移 0006 只新增 sequencing 表与索引（ADR-032，不动历史表）', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const seq = migrations.find((m) => m.name === '0006_sequencing_leases.sql');
    expect(seq).toBeDefined();
    expect(seq?.sql).toMatch(/CREATE TABLE transaction_data\.sequencing_leases/u);
    expect(seq?.sql).toMatch(/UNIQUE \(transaction_id\)/u);
    // 不得改列类型 / 删数据 / 删历史表。
    expect(seq?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE|DELETE\s+FROM/iu);
  });

  it('仓库迁移 0007 只新增 sequencing_ref 列与形状约束（ADR-033，不动历史表）', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const ref = migrations.find((m) => m.name === '0007_transaction_sequencing_ref.sql');
    expect(ref).toBeDefined();
    expect(ref?.sql).toMatch(/ADD COLUMN IF NOT EXISTS sequencing_ref jsonb/u);
    expect(ref?.sql).toMatch(/transactions_sequencing_ref_shape/u);
    expect(ref?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE|DELETE\s+FROM/iu);
  });

  it('仓库迁移 0009 只新增 Provider 日配额表与索引（E5，不动历史表）', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const quota = migrations.find((m) => m.name === '0009_provider_quota_daily.sql');
    expect(quota).toBeDefined();
    expect(quota?.sql).toMatch(/CREATE TABLE transaction_data\.provider_quota_daily/u);
    expect(quota?.sql).toMatch(/PRIMARY KEY \(provider_id, chain_id, day\)/u);
    expect(quota?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE|DELETE\s+FROM/iu);
  });

  it('首次应用：按文件名顺序执行并写入版本表', async () => {
    await resetSchemas();
    const result = await runMigrations({ client, migrations: [M2, M1] }); // 故意乱序传入

    // 运行器必须自己排序，而不是依赖调用方顺序。
    expect(result.applied).toEqual([M1.name, M2.name]);
    expect(result.skipped).toEqual([]);
    expect(await tableExists(SCRATCH, 'base')).toBe(true);
    expect(await appliedNames()).toEqual([M1.name, M2.name]);
  });

  it('重复运行：已应用且 checksum 一致时全部跳过，不重复执行', async () => {
    const result = await runMigrations({ client, migrations: [M1, M2] });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([M1.name, M2.name]);
  });

  it('checksum 改变：已应用迁移被修改时拒绝执行', async () => {
    const tampered: MigrationFile = { ...M2, sql: `${M2.sql}-- 事后修改\n` };
    await expect(runMigrations({ client, migrations: [M1, tampered] })).rejects.toMatchObject({
      name: 'MigrationError',
      reason: 'checksum_mismatch',
      migrationName: M2.name,
    });
    // 版本表内容不得被污染。
    expect(await appliedNames()).toEqual([M1.name, M2.name]);
  });

  it('半途失败回滚：迁移内已执行的 DDL 与版本行一并回滚', async () => {
    await expect(
      runMigrations({ client, migrations: [M1, M2, M_FAIL] }),
    ).rejects.toThrow(/division by zero|除以零/iu);

    // 失败迁移建的表必须不存在（DDL 也回滚）。
    expect(await tableExists(SCRATCH, 'half')).toBe(false);
    // 失败迁移不得留下版本行。
    expect(await appliedNames()).toEqual([M1.name, M2.name]);
    // 之前已提交的迁移不受影响。
    expect(await tableExists(SCRATCH, 'base')).toBe(true);
  });

  it('应用一个合法迁移后，同一批中的后续迁移失败不回退前者', async () => {
    await resetSchemas();
    const ok: MigrationFile = { name: '0001_probe_base.sql', sql: M1.sql };
    await expect(
      runMigrations({ client, migrations: [ok, M2, M_FAIL] }),
    ).rejects.toThrow(/division by zero|除以零/iu);
    expect(await appliedNames()).toEqual([M1.name, M2.name]);
  });

  it('已应用迁移在本次列表缺失时拒绝执行（防止删除迁移文件）', async () => {
    await expect(runMigrations({ client, migrations: [M1] })).rejects.toMatchObject({
      reason: 'applied_migration_missing',
      migrationName: M2.name,
    });
  });

  it('迁移 DDL 与版本行原子：版本行写入失败时迁移的 DDL 也被回滚', async () => {
    await resetSchemas();
    await expect(
      runMigrations({ client, migrations: [{ ...M1 }, M_COLLIDE] }),
    ).rejects.toThrow(/duplicate key|already exists|唯一|重复/iu);

    // 关键断言：迁移里已经执行成功的 CREATE TABLE 必须一并回滚。
    // 若运行器不显式开事务，这条会失败（DDL 会随隐式事务提交）。
    expect(await tableExists(SCRATCH, 'collide')).toBe(false);
    // 版本表里不得留下迁移 SQL 抢先写入的占位行。
    expect(await appliedNames()).toEqual([M1.name]);
  });

  it('迁移 SQL 含事务控制语句时拒绝执行（避免破坏回滚保证）', async () => {
    await resetSchemas();
    const withBegin: MigrationFile = {
      name: '0001_probe_begin.sql',
      sql: `BEGIN;\nCREATE SCHEMA IF NOT EXISTS ${SCRATCH};\nCOMMIT;\n`,
    };
    await expect(runMigrations({ client, migrations: [withBegin] })).rejects.toMatchObject({
      reason: 'transaction_control_in_migration',
    });
  });

  it('迁移名重复时拒绝执行', async () => {
    await resetSchemas();
    await expect(
      runMigrations({ client, migrations: [M1, { ...M1, sql: 'SELECT 1;' }] }),
    ).rejects.toMatchObject({ reason: 'duplicate_migration_name' });
  });

  it('schema / 表名非法时拒绝执行（防注入）', async () => {
    await expect(
      runMigrations({ client, migrations: [M1], migrationsSchema: 'bad; DROP SCHEMA public' }),
    ).rejects.toMatchObject({ reason: 'invalid_identifier' });
    await expect(
      runMigrations({ client, migrations: [M1], migrationsTable: 'bad-name' }),
    ).rejects.toMatchObject({ reason: 'invalid_identifier' });
  });
});

describe.skipIf(!ENABLED)('真实迁移目录（DFR-M1-A08）', () => {
  it('loadMigrations 按文件名升序返回，且以 0001 开头', () => {
    const migrations = loadMigrations(realMigrationsDir);
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]!.name).toBe('0001_transaction_data.sql');
    const names = migrations.map((m) => m.name);
    expect([...names]).toEqual([...names].sort());
  });

  it('checksum 对同一内容稳定、对空白改动敏感', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const first = migrations[0]!;
    expect(checksumOf(first.sql)).toBe(checksumOf(first.sql));
    expect(checksumOf(first.sql)).not.toBe(checksumOf(`${first.sql}\n`));
  });

  it('真实迁移端到端：从零应用，再次运行全部跳过', async () => {
    await resetSchemas();
    await client.query('DROP SCHEMA IF EXISTS transaction_data CASCADE');

    const migrations = loadMigrations(realMigrationsDir);
    const first = await runMigrations({ client, migrations });
    expect(first.applied).toEqual(migrations.map((m) => m.name));
    expect(first.skipped).toEqual([]);

    // 八张业务表就位，且版本表不混进业务 schema。
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'transaction_data' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'idempotency_records',
      'nonce_accounts',
      'nonce_leases',
      'provider_quota_daily',
      'sequencing_leases',
      'tracker_leases',
      'transaction_transitions',
      'transactions',
    ]);

    const second = await runMigrations({ client, migrations });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(migrations.map((m) => m.name));
  }, 60_000);
});
