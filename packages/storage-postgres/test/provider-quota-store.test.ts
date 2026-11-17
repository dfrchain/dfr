/**
 * PostgresProviderQuotaStore 契约测试（E5）。
 *
 * 权威来源：docs/architecture/provider-spec-v0.1.md §8.1。
 *
 * 关键验证不是“顺序调用不超过上限”，而是**两个独立连接并发预占**
 * 也必须只有一个成功；否则跨实例部署仍会超发。
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

const PRIVATE_DB = 'dfr_t_quota_test';
const SCHEMA = 'transaction_data';

let admin: Client;
let inspector: Client;
let poolA: Pool;
let poolB: Pool;
let storeA: PostgresProviderQuotaStore;
let storeB: PostgresProviderQuotaStore;

function dsnFor(database: string): string {
  return ADMIN_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

async function reset(): Promise<void> {
  await inspector.query(`TRUNCATE ${SCHEMA}.provider_quota_daily`);
}

beforeAll(async () => {
  if (!ENABLED) return;
  admin = new Client({ connectionString: ADMIN_DSN });
  await admin.connect();
  const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
  if (!/_test$/u.test(rows[0]!.db)) {
    throw new Error(`拒绝在非测试库 "${rows[0]!.db}" 上执行（库名必须以 _test 结尾）`);
  }

  await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${PRIVATE_DB}`);

  const setup = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await setup.connect();
  await runMigrations({ client: setup, migrations: loadMigrations(migrationsDir) });
  await setup.end();

  poolA = new Pool({ connectionString: dsnFor(PRIVATE_DB), max: 4 });
  poolB = new Pool({ connectionString: dsnFor(PRIVATE_DB), max: 4 });
  inspector = new Client({ connectionString: dsnFor(PRIVATE_DB) });
  await inspector.connect();
  storeA = new PostgresProviderQuotaStore(poolA);
  storeB = new PostgresProviderQuotaStore(poolB);
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  if (inspector) await inspector.end();
  if (poolA) await poolA.end();
  if (poolB) await poolB.end();
  if (admin) {
    // Pool/inspector have been closed above. FORCE kills backend clients
    // asynchronously and emits an unhandled 57P01 into Vitest after tests
    // have passed. A normal DROP is intentional: leaked clients must fail
    // this teardown instead of being silently terminated.
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB}`);
    await admin.end();
  }
}, 60_000);

describe.skipIf(!ENABLED)('PostgresProviderQuotaStore（E5）', () => {
  it('首次消费创建计数，usage 返回真实消耗', async () => {
    await reset();
    const first = await storeA.consume({
      providerId: 'p1',
      chain: 'ethereum-sepolia' as never,
      day: '2026-10-08',
      limit: 3,
    });
    expect(first).toEqual({ allowed: true, used: 1 });
    expect(
      await storeA.usage({ providerId: 'p1', chain: 'ethereum-sepolia' as never, day: '2026-10-08' }),
    ).toBe(1);
  });

  it('达到上限后拒绝，且不会把 used 增加到 limit 以上', async () => {
    await reset();
    const input = {
      providerId: 'p2',
      chain: 'ethereum-sepolia' as never,
      day: '2026-10-08',
      limit: 1,
    };
    expect((await storeA.consume(input)).allowed).toBe(true);
    expect(await storeA.consume(input)).toEqual({ allowed: false, used: 1 });
    expect(await storeB.consume(input)).toEqual({ allowed: false, used: 1 });
    expect(
      await storeA.usage({ providerId: 'p2', chain: 'ethereum-sepolia' as never, day: '2026-10-08' }),
    ).toBe(1);
  });

  it('两个独立连接并发预占：额度 1 时恰好一个成功', async () => {
    await reset();
    const input = {
      providerId: 'p3',
      chain: 'ethereum-sepolia' as never,
      day: '2026-10-08',
      limit: 1,
    };
    const [a, b] = await Promise.all([storeA.consume(input), storeB.consume(input)]);
    expect([a.allowed, b.allowed].filter(Boolean)).toHaveLength(1);
    expect([a.used, b.used].sort()).toEqual([1, 1]);
  });

  it('日期维度独立：新的一天从 0 开始', async () => {
    await reset();
    const base = { providerId: 'p4', chain: 'ethereum-sepolia' as never, limit: 1 };
    expect((await storeA.consume({ ...base, day: '2026-10-08' })).allowed).toBe(true);
    expect((await storeA.consume({ ...base, day: '2026-10-09' })).allowed).toBe(true);
  });
});
