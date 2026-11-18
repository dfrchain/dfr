/**
 * ProviderQuotaStore scale and boundary tests (E5).
 *
 * The goal is not to repeat concurrency correctness, but to prove that over long runs:
 *   - old-date data does not affect the current day's counts;
 *   - usage queries use the primary key and need no full-table scan;
 *   - a single UPSERT still never exceeds the cap under 50-way concurrency.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { loadMigrations, runMigrations } from '../src/migrate.js';
import { PostgresProviderQuotaStore } from '../src/provider-quota-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');
const ADMIN_DSN = process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
const ENABLED = typeof ADMIN_DSN === 'string' && ADMIN_DSN.length > 0;

const PRIVATE_DB = 'dfr_t_quota_scale_test';
let admin: Client;
let inspector: Client;
let pool: Pool;
let store: PostgresProviderQuotaStore;

function dsnFor(database: string): string {
  return ADMIN_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

beforeAll(async () => {
  if (!ENABLED) return;
  admin = new Client({ connectionString: ADMIN_DSN });
  await admin.connect();
  const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
  if (!/_test$/u.test(rows[0]!.db)) throw new Error('refusing to run against a non-test database');

  await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${PRIVATE_DB}`);
  const setup = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await setup.connect();
  await runMigrations({ client: setup, migrations: loadMigrations(migrationsDir) });
  await setup.end();

  pool = new Pool({ connectionString: dsnFor(PRIVATE_DB), max: 20 });
  inspector = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await inspector.connect();
  store = new PostgresProviderQuotaStore(pool);
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  if (inspector) await inspector.end();
  if (pool) await pool.end();
  if (admin) {
    // After the pool ends, do not use FORCE: force-killing clients that are still closing throws 57P01 at Vitest,
    // making assertions pass but the database gate fail. If connections are not released cleanly, let the DROP fail to expose the leak.
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB}`);
    await admin.end();
  }
}, 60_000);

describe.skipIf(!ENABLED)('ProviderQuotaStore scale and boundaries (E5)', () => {
  it('50 concurrent contenders for 10 units of quota: exactly 10 allowed, used=10', async () => {
    await inspector.query('TRUNCATE transaction_data.provider_quota_daily');
    const input = {
      providerId: 'scale-provider',
      chain: 'base-sepolia' as never,
      day: '2026-10-09',
      limit: 10,
    };
    const results = await Promise.all(Array.from({ length: 50 }, () => store.consume(input)));
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(await store.usage(input)).toBe(10);
  });

  it('historical-date rows do not affect the current day\'s counts', async () => {
    await inspector.query('TRUNCATE transaction_data.provider_quota_daily');
    const base = { providerId: 'day-provider', chain: 'base-sepolia' as never, limit: 2 };
    await store.consume({ ...base, day: '2026-10-01' });
    await store.consume({ ...base, day: '2026-10-01' });
    expect((await store.consume({ ...base, day: '2026-10-02' })).allowed).toBe(true);
    expect(await store.usage({ ...base, day: '2026-10-02' })).toBe(1);
    expect(await store.usage({ ...base, day: '2026-10-01' })).toBe(2);
  });

  it('usage queries use the primary-key index (EXPLAIN shows no Seq Scan)', async () => {
    await inspector.query('TRUNCATE transaction_data.provider_quota_daily');
    // Insert enough unrelated rows to give the planner a reason to choose the index.
    for (let i = 0; i < 200; i += 1) {
      await inspector.query(
        `INSERT INTO transaction_data.provider_quota_daily (provider_id, chain_id, day, used)
         VALUES ($1, 'base-sepolia', DATE '2026-10-09', 1)`,
        [`bulk-${i}`],
      );
    }
    const { rows } = await inspector.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT used FROM transaction_data.provider_quota_daily
        WHERE provider_id = 'bulk-1' AND chain_id = 'base-sepolia' AND day = DATE '2026-10-09'`,
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(plan).not.toMatch(/Seq Scan/iu);
  });
});
