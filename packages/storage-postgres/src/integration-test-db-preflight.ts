/**
 * Dedicated M1 integration-test database, completely separate from the
 * schema-contract suite which deliberately DROP SCHEMAs in dfr_m1_test.
 * No production DSN accepted, no existing database/schema is cleared.
 */
import { Client } from 'pg';
import { pathToFileURL } from 'node:url';
import { runMigrateCli } from './migrate-cli.js';

const SOURCE_DB = '/dfr_m1_test';
const INTEGRATION_DB = 'dfr_m1_integration_test';

export interface IntegrationDatabaseCredentials {
  readonly migrator: string;
  readonly runtime: string;
}

function checkedUrl(value: string, username: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || !url.port || !/^\d+$/.test(url.port)
    || url.pathname !== SOURCE_DB
    || url.username !== username
    || url.password.length === 0
  ) {
    throw new Error('refusing non-local, non-test or incorrectly scoped PostgreSQL connection');
  }
  return url;
}

/** Transform DSNs but never print credentials or mutate the input sources. */
export function integrationDatabaseUrls(input: IntegrationDatabaseCredentials): IntegrationDatabaseCredentials {
  const migrator = checkedUrl(input.migrator, 'dfr_migrator');
  const runtime = checkedUrl(input.runtime, 'dfr_runtime');
  if (migrator.hostname !== runtime.hostname || migrator.port !== runtime.port) {
    throw new Error('integration runtime must use the same local test PostgreSQL instance');
  }
  migrator.pathname = `/${INTEGRATION_DB}`;
  runtime.pathname = `/${INTEGRATION_DB}`;
  return { migrator: migrator.toString(), runtime: runtime.toString() };
}

/** Idempotent, create-only: never DROP a database or schema. */
export async function prepareIntegrationTestDatabase(
  input: IntegrationDatabaseCredentials,
): Promise<IntegrationDatabaseCredentials> {
  const destination = integrationDatabaseUrls(input);
  const admin = new Client({ connectionString: input.migrator });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [INTEGRATION_DB],
    );
    if (!rows[0]?.exists) {
      try {
        await admin.query(`CREATE DATABASE ${INTEGRATION_DB} OWNER dfr_migrator`);
      } catch (error: unknown) {
        // Two CI agents can start simultaneously; only tolerate an existing DB.
        if ((error as { code?: string }).code !== '42P04') throw error;
      }
    }
  } finally {
    await admin.end();
  }

  await runMigrateCli({
    env: { DFR_TRANSACTION_MIGRATION_DATABASE_URL: destination.migrator },
  });
  return destination;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void prepareIntegrationTestDatabase({
    migrator: process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'] ?? '',
    runtime: process.env['DFR_TRANSACTION_DATABASE_URL'] ?? '',
  }).then(
    () => process.stdout.write('integration-db: dedicated test schema ready\n'),
    // Fail without printing connection URIs, password or raw pg errors.
    () => {
      process.stderr.write('integration-db: local test preparation failed; no database was dropped\n');
      process.exitCode = 1;
    },
  );
}
