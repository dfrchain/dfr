// Migration CLI contract test (DFR-M1-E02).
//
// By default only offline assertions run (fail-closed without a DSN); the real-database part needs
// `DFR_TRANSACTION_RUNNER_DATABASE_URL` (exported by `pnpm test:db`).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MigrateCliError, runMigrateCli } from '../src/migrate-cli.js';

const RUNNER_DSN = process.env['DFR_TRANSACTION_RUNNER_DATABASE_URL'];
const ENABLED = typeof RUNNER_DSN === 'string' && RUNNER_DSN.length > 0;

describe('migration CLI (DFR-M1-E02)', () => {
  it('fails closed without DFR_TRANSACTION_MIGRATION_DATABASE_URL, and echoes no DSN', async () => {
    let caught: unknown;
    try {
      await runMigrateCli({ env: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MigrateCliError);
    expect((caught as Error).message).toContain('DFR_TRANSACTION_MIGRATION_DATABASE_URL');
    // Migration identity and runtime identity must be two separate variables: it should still fail without a runtime DSN.
    await expect(
      runMigrateCli({ env: { DFR_TRANSACTION_DATABASE_URL: 'postgres://x:y@z/db' } }),
    ).rejects.toBeInstanceOf(MigrateCliError);
  });

  it.skipIf(!ENABLED)('idempotent on a real database: the second run applies no migrations and covers all known migrations', async () => {
    // Note: the runner database is shared with migrations.test.ts, so the migrations may already have been applied there,
    // so "the first run always applies everything" cannot be assumed. Assert **idempotency** and **migration-set completeness** instead.
    const first = await runMigrateCli({
      env: { DFR_TRANSACTION_MIGRATION_DATABASE_URL: RUNNER_DSN },
    });

    const second = await runMigrateCli({
      env: { DFR_TRANSACTION_MIGRATION_DATABASE_URL: RUNNER_DSN },
    });
    expect([...second.applied]).toEqual([]);
    // The second run's skipped set = first run's applied + first run's skipped, i.e. all migrations on disk.
    expect(new Set(second.skipped)).toEqual(new Set([...first.applied, ...first.skipped]));
    expect(second.skipped.length).toBeGreaterThanOrEqual(5);
    // The latest migration must be the ADR-022 state_version lower-bound fix.
    expect([...second.skipped]).toContain('0005_transaction_state_version_zero.sql');
  });

  it.skipIf(!ENABLED)('a migration SQL error fails the whole run, and the error carries no DSN', async () => {
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
