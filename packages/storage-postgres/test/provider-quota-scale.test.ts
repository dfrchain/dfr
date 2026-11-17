/**
 * ProviderQuotaStore 规模与边界测试（E5）。
 *
 * 目标不是重复并发正确性，而是证明长期运行下：
 *   - 旧日期数据不会影响当天计数；
 *   - usage 查询走主键，不需要全表扫描；
 *   - 单条 UPSERT 在 50 路并发下仍不超过上限。
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
  if (!/_test$/u.test(rows[0]!.db)) throw new Error('拒绝在非测试库执行');

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
    // Pool 已结束后不用 FORCE：强杀仍在关闭中的客户端会向 Vitest 抛 57P01，
    // 使断言虽通过但数据库门禁失败。若连接没有正常释放，让 DROP 失败即可暴露泄漏。
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB}`);
    await admin.end();
  }
}, 60_000);

describe.skipIf(!ENABLED)('ProviderQuotaStore 规模与边界（E5）', () => {
  it('50 路并发抢 10 个额度：恰好 10 个 allowed，used=10', async () => {
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

  it('历史日期行存在时，当天计数不受影响', async () => {
    await inspector.query('TRUNCATE transaction_data.provider_quota_daily');
    const base = { providerId: 'day-provider', chain: 'base-sepolia' as never, limit: 2 };
    await store.consume({ ...base, day: '2026-10-01' });
    await store.consume({ ...base, day: '2026-10-01' });
    expect((await store.consume({ ...base, day: '2026-10-02' })).allowed).toBe(true);
    expect(await store.usage({ ...base, day: '2026-10-02' })).toBe(1);
    expect(await store.usage({ ...base, day: '2026-10-01' })).toBe(2);
  });

  it('usage 查询使用主键索引（EXPLAIN 不出现 Seq Scan）', async () => {
    await inspector.query('TRUNCATE transaction_data.provider_quota_daily');
    // 插入足够多的无关行，让规划器有理由选择索引。
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
