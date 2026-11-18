/**
 * Migration runner contract test (DFR-M1-A08).
 *
 * Authoritative sources: ADR-015 §3, docs/architecture/m1-storage-model.md.
 *
 * Skipped by **default**; enable explicitly:
 *
 *   DFR_TRANSACTION_RUNNER_DATABASE_URL=postgres://dfr_migrator:...@127.0.0.1:55432/dfr_m1_runner_test \
 *   pnpm vitest run packages/storage-postgres/test/migrations.test.ts
 *
 * or run `pnpm test:db` directly (the script exports all required DSNs).
 *
 * This database is **separate** (`dfr_m1_runner_test`): the schema contract test DROPs schemas in its own database,
 * so the two test files would break each other if they shared one database.
 *
 * Covers the four scenarios the task card requires: first application, re-run, checksum change, mid-way failure rollback.
 * Plus three defensive boundaries: applied migration missing, transaction-control statements, duplicate migration names.
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

/** Scratch schema used by synthetic migrations, deliberately separate from transaction_data. */
const SCRATCH = 'mig_probe';

const M1: MigrationFile = {
  name: '0001_probe_base.sql',
  sql: `CREATE SCHEMA IF NOT EXISTS ${SCRATCH};\nCREATE TABLE ${SCRATCH}.base (id int PRIMARY KEY);\n`,
};
const M2: MigrationFile = {
  name: '0002_probe_more.sql',
  sql: `ALTER TABLE ${SCRATCH}.base ADD COLUMN note text;\n`,
};
/** Create a table and then deliberately error: used to verify "mid-way failure rolls back everything". */
const M_FAIL: MigrationFile = {
  name: '0003_probe_fail.sql',
  sql: `CREATE TABLE ${SCRATCH}.half (i int);\nSELECT 1 / 0;\n`,
};

/**
 * The migration SQL itself succeeds, but the **version-row write fails**.
 *
 * This is the only scenario that can distinguish "does the runner manage transactions explicitly":
 * PostgreSQL puts a single multi-statement query into an implicit transaction, so an "error inside the migration SQL"
 * rolls back even without the runner. But the version row is written by the runner in a **separate** query,
 * so only an explicit BEGIN/COMMIT makes "the migration's executed DDL" and "the version row" live or die together.
 *
 * Here the migration SQL pre-inserts a version row with the same name, so the runner's subsequent INSERT hits a primary-key conflict.
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
  // Safety guard: only test databases may be touched (this file DROPs schemas).
  if (!/_test$/u.test(db)) {
    throw new Error(`refusing to run migration tests against non-test database "${db}" (database name must end with _test)`);
  }
  await resetSchemas();
}, 60_000);

afterAll(async () => {
  if (ENABLED && client) await client.end();
});

describe.skipIf(!ENABLED)('migration runner (DFR-M1-A08)', () => {
  it('the in-repo D04 migration only extends nullable anchor columns (0004)', async () => {
    const migrations = loadMigrations(realMigrationsDir);
    const d04 = migrations.find((m) => m.name === '0004_transaction_canonical_block_hash.sql');
    expect(d04).toBeDefined();
    expect(d04?.sql).toMatch(/ADD COLUMN canonical_block_hash text\s*;/u);
    expect(d04?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE/iu);
  });

  it('in-repo migrations are strictly ascending by filename with no duplicates, and 0005 only relaxes the state_version lower bound', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const names = migrations.map((m) => m.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);

    const d07 = migrations.find((m) => m.name === '0005_transaction_state_version_zero.sql');
    expect(d07).toBeDefined();
    // Only relaxing the state_version constraint is allowed; column types must not be changed and data must not be deleted on the side.
    expect(d07?.sql).toMatch(/CHECK\s*\(state_version\s*>=\s*0\)/u);
    expect(d07?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE|DELETE\s+FROM/iu);
  });

  it('in-repo migration 0006 only adds sequencing tables and indexes (ADR-032, historical tables untouched)', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const seq = migrations.find((m) => m.name === '0006_sequencing_leases.sql');
    expect(seq).toBeDefined();
    expect(seq?.sql).toMatch(/CREATE TABLE transaction_data\.sequencing_leases/u);
    expect(seq?.sql).toMatch(/UNIQUE \(transaction_id\)/u);
    // Column types must not be changed, data must not be deleted, historical tables must not be dropped.
    expect(seq?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE|DELETE\s+FROM/iu);
  });

  it('in-repo migration 0007 only adds the sequencing_ref column and shape constraints (ADR-033, historical tables untouched)', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const ref = migrations.find((m) => m.name === '0007_transaction_sequencing_ref.sql');
    expect(ref).toBeDefined();
    expect(ref?.sql).toMatch(/ADD COLUMN IF NOT EXISTS sequencing_ref jsonb/u);
    expect(ref?.sql).toMatch(/transactions_sequencing_ref_shape/u);
    expect(ref?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE|DELETE\s+FROM/iu);
  });

  it('in-repo migration 0009 only adds the Provider daily-quota table and indexes (E5, historical tables untouched)', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const quota = migrations.find((m) => m.name === '0009_provider_quota_daily.sql');
    expect(quota).toBeDefined();
    expect(quota?.sql).toMatch(/CREATE TABLE transaction_data\.provider_quota_daily/u);
    expect(quota?.sql).toMatch(/PRIMARY KEY \(provider_id, chain_id, day\)/u);
    expect(quota?.sql).not.toMatch(/DROP\s+(COLUMN|TABLE)|ALTER\s+COLUMN\s+.*\s+TYPE|DELETE\s+FROM/iu);
  });

  it('first application: executes in filename order and writes the version table', async () => {
    await resetSchemas();
    const result = await runMigrations({ client, migrations: [M2, M1] }); // Deliberately passed out of order

    // The runner must sort by itself, not depend on caller order.
    expect(result.applied).toEqual([M1.name, M2.name]);
    expect(result.skipped).toEqual([]);
    expect(await tableExists(SCRATCH, 'base')).toBe(true);
    expect(await appliedNames()).toEqual([M1.name, M2.name]);
  });

  it('re-run: everything already applied with matching checksum is skipped, nothing re-executes', async () => {
    const result = await runMigrations({ client, migrations: [M1, M2] });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([M1.name, M2.name]);
  });

  it('checksum change: refuses to run when an applied migration was modified', async () => {
    const tampered: MigrationFile = { ...M2, sql: `${M2.sql}-- modified afterwards\n` };
    await expect(runMigrations({ client, migrations: [M1, tampered] })).rejects.toMatchObject({
      name: 'MigrationError',
      reason: 'checksum_mismatch',
      migrationName: M2.name,
    });
    // The version-table contents must not be polluted.
    expect(await appliedNames()).toEqual([M1.name, M2.name]);
  });

  it('mid-way failure rollback: DDL already executed inside the migration rolls back together with the version row', async () => {
    await expect(
      runMigrations({ client, migrations: [M1, M2, M_FAIL] }),
    ).rejects.toThrow(/division by zero/iu);

    // Tables created by the failed migration must not exist (DDL rolls back too).
    expect(await tableExists(SCRATCH, 'half')).toBe(false);
    // The failed migration must leave no version row.
    expect(await appliedNames()).toEqual([M1.name, M2.name]);
    // Previously committed migrations are unaffected.
    expect(await tableExists(SCRATCH, 'base')).toBe(true);
  });

  it('after one valid migration is applied, a later failing migration in the same batch does not roll back the former', async () => {
    await resetSchemas();
    const ok: MigrationFile = { name: '0001_probe_base.sql', sql: M1.sql };
    await expect(
      runMigrations({ client, migrations: [ok, M2, M_FAIL] }),
    ).rejects.toThrow(/division by zero/iu);
    expect(await appliedNames()).toEqual([M1.name, M2.name]);
  });

  it('refuses to run when an applied migration is missing from this run\'s list (prevents deleting migration files)', async () => {
    await expect(runMigrations({ client, migrations: [M1] })).rejects.toMatchObject({
      reason: 'applied_migration_missing',
      migrationName: M2.name,
    });
  });

  it('migration DDL and version row are atomic: when the version-row write fails, the migration\'s DDL is also rolled back', async () => {
    await resetSchemas();
    await expect(
      runMigrations({ client, migrations: [{ ...M1 }, M_COLLIDE] }),
    ).rejects.toThrow(/duplicate key|already exists/iu);

    // Key assertion: a CREATE TABLE already executed inside the migration must roll back too.
    // If the runner does not open a transaction explicitly, this fails (the DDL would commit with the implicit transaction).
    expect(await tableExists(SCRATCH, 'collide')).toBe(false);
    // No placeholder row pre-written by the migration SQL may remain in the version table.
    expect(await appliedNames()).toEqual([M1.name]);
  });

  it('refuses to run migration SQL containing transaction-control statements (to protect the rollback guarantee)', async () => {
    await resetSchemas();
    const withBegin: MigrationFile = {
      name: '0001_probe_begin.sql',
      sql: `BEGIN;\nCREATE SCHEMA IF NOT EXISTS ${SCRATCH};\nCOMMIT;\n`,
    };
    await expect(runMigrations({ client, migrations: [withBegin] })).rejects.toMatchObject({
      reason: 'transaction_control_in_migration',
    });
  });

  it('refuses to run when migration names are duplicated', async () => {
    await resetSchemas();
    await expect(
      runMigrations({ client, migrations: [M1, { ...M1, sql: 'SELECT 1;' }] }),
    ).rejects.toMatchObject({ reason: 'duplicate_migration_name' });
  });

  it('refuses to run when the schema / table name is invalid (injection guard)', async () => {
    await expect(
      runMigrations({ client, migrations: [M1], migrationsSchema: 'bad; DROP SCHEMA public' }),
    ).rejects.toMatchObject({ reason: 'invalid_identifier' });
    await expect(
      runMigrations({ client, migrations: [M1], migrationsTable: 'bad-name' }),
    ).rejects.toMatchObject({ reason: 'invalid_identifier' });
  });
});

describe.skipIf(!ENABLED)('real migration directory (DFR-M1-A08)', () => {
  it('loadMigrations returns migrations in ascending filename order, starting with 0001', () => {
    const migrations = loadMigrations(realMigrationsDir);
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]!.name).toBe('0001_transaction_data.sql');
    const names = migrations.map((m) => m.name);
    expect([...names]).toEqual([...names].sort());
  });

  it('checksums are stable for identical content and sensitive to whitespace changes', () => {
    const migrations = loadMigrations(realMigrationsDir);
    const first = migrations[0]!;
    expect(checksumOf(first.sql)).toBe(checksumOf(first.sql));
    expect(checksumOf(first.sql)).not.toBe(checksumOf(`${first.sql}\n`));
  });

  it('real migrations end to end: apply from scratch, then skip everything on the second run', async () => {
    await resetSchemas();
    await client.query('DROP SCHEMA IF EXISTS transaction_data CASCADE');

    const migrations = loadMigrations(realMigrationsDir);
    const first = await runMigrations({ client, migrations });
    expect(first.applied).toEqual(migrations.map((m) => m.name));
    expect(first.skipped).toEqual([]);

    // The eight business tables are in place, and the version table does not mix into the business schema.
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
