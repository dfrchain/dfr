import { describe, expect, it } from 'vitest';
import {
  integrationDatabaseUrls,
  prepareIntegrationTestDatabase,
} from '../src/integration-test-db-preflight.js';

const migrator = 'postgres://dfr_migrator:test-secret@127.0.0.1:55432/dfr_m1_test';
const runtime = 'postgres://dfr_runtime:test-secret@127.0.0.1:55432/dfr_m1_test';

describe('M1 integration DB gate isolation', () => {
  it('redirects only the integration stage to a separately named database', () => {
    const prepared = integrationDatabaseUrls({ migrator, runtime });
    expect(new URL(prepared.migrator).pathname).toBe('/dfr_m1_integration_test');
    expect(new URL(prepared.runtime).pathname).toBe('/dfr_m1_integration_test');
    expect(new URL(prepared.migrator).username).toBe('dfr_migrator');
    expect(new URL(prepared.runtime).username).toBe('dfr_runtime');
    expect(new URL(migrator).pathname).toBe('/dfr_m1_test');
  });

  it('refuses production/remote host or wrong database, roles, ports', () => {
    const bad = [
      { migrator: migrator.replace('127.0.0.1', 'db.production.example'), runtime },
      { migrator: migrator.replace('dfr_m1_test', 'dfr_production'), runtime },
      { migrator: migrator.replace('dfr_migrator', 'dfr_bootstrap'), runtime },
      { migrator, runtime: runtime.replace('55432', '65432') },
      { migrator, runtime: runtime.replace('dfr_runtime', 'dfr_migrator') },
      { migrator, runtime: runtime.replace('dfr_m1_test', 'other_test') },
    ];
    for (const pair of bad) {
      expect(() => integrationDatabaseUrls(pair)).toThrow();
    }
  });

  it.skipIf(!process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'])(
    'provisions and migrates an independent integration PostgreSQL database without altering source schema',
    async () => {
      const urls = await prepareIntegrationTestDatabase({
        migrator: process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL']!,
        runtime: process.env['DFR_TRANSACTION_DATABASE_URL']!,
      });
      expect(new URL(urls.runtime).pathname).toBe('/dfr_m1_integration_test');
      const { Client } = await import('pg');
      const db = new Client({ connectionString: urls.runtime });
      await db.connect();
      try {
        const { rows } = await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'transaction_data'",
        );
        expect(rows[0]?.count).toBeGreaterThanOrEqual(8);
      } finally {
        await db.end();
      }
    },
  );
});
