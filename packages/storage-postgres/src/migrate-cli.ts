// Migration CLI (DFR-M1-E02).
//
// Why it exists: `runMigrations()` is only a library function, and a containerized / brand-new environment has no entry point that can
// "apply migrations". E01's runbook described the migration steps but provided no executable command; E02 adds this entry point
// so that "deploying from a clean environment" is actually executable.
//
// Separation from runtime (ADR-015 / m1-local-database.md):
//   - This CLI only reads `DFR_TRANSACTION_MIGRATION_DATABASE_URL` (the migration identity, which may run DDL);
//   - The application process only reads `DFR_TRANSACTION_DATABASE_URL` (the runtime identity, DML only);
//   - The two identities share no credentials, and the application container holds no migration identity.
//
// Security: never print the DSN or raw driver exception text (it may contain a password); failures only report a fixed message + exit code.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { loadMigrations, runMigrations, type MigrationRunResult } from './migrate.js';

export interface MigrateCliOptions {
  /** Injection point: `process.env` by default. */
  readonly env?: NodeJS.ProcessEnv;
  /** Injection point: the package's `migrations/` by default. */
  readonly migrationsDir?: string;
}

export class MigrateCliError extends Error {
  override readonly name = 'MigrateCliError';
}

function defaultMigrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

/**
 * Apply all forward migrations. Re-running is idempotent: already-applied migrations with a matching checksum are skipped.
 *
 * A `MigrateCliError` means the DSN is missing; other errors (connectivity, checksum mismatch,
 * missing migration files) are rethrown as-is; the caller decides the exit code, but must **never** echo the raw text.
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
