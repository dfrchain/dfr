/** PostgreSQL TrackerLeaseStore 契约测试（DFR-M1-A12）。 */
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import type { ChainId } from '@dfr/types';
import { PostgresTrackerLeaseStore } from '../src/tracker-lease-store.js';
import { loadMigrations, runMigrations } from '../src/migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', 'migrations');
const ADMIN_DSN = process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
const RUNTIME_DSN = process.env['DFR_TRANSACTION_DATABASE_URL'];
const ENABLED =
  typeof ADMIN_DSN === 'string' && ADMIN_DSN.length > 0 &&
  typeof RUNTIME_DSN === 'string' && RUNTIME_DSN.length > 0;

const PRIVATE_DB = 'dfr_t_tracker_test';
const SCHEMA = 'transaction_data';
const chain = 'ethereum-sepolia' as ChainId;
let admin: Client;
let inspector: Client;
let pool: Pool;
let store: PostgresTrackerLeaseStore;

function dsnFor(dsn: string, database: string): string {
  return dsn.replace(/\/[^/]*$/u, `/${database}`);
}

async function reset(): Promise<void> {
  await inspector.query(`TRUNCATE ${SCHEMA}.tracker_leases`);
}

async function acquire(txHash: string, ownerToken: string, leaseTtlMs = 60_000) {
  return store.acquire({ chain, txHash, ownerToken, leaseTtlMs });
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

  const setup = new Client({ connectionString: dsnFor(ADMIN_DSN!, PRIVATE_DB) });
  await setup.connect();
  await runMigrations({ client: setup, migrations: loadMigrations(migrationsDir) });
  await setup.end();

  pool = new Pool({ connectionString: dsnFor(RUNTIME_DSN!, PRIVATE_DB), max: 20 });
  inspector = new Client({ connectionString: dsnFor(ADMIN_DSN!, PRIVATE_DB) });
  await inspector.connect();
  store = new PostgresTrackerLeaseStore(pool);
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  if (inspector) await inspector.end();
  if (pool) await pool.end();
  if (admin) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { rows } = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1`,
        [PRIVATE_DB],
      );
      if (rows[0]!.count === '0') break;
      await delay(10);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB}`);
    await admin.end();
  }
}, 60_000);

describe.skipIf(!ENABLED)('PostgresTrackerLeaseStore（DFR-M1-A12）', () => {
  it('首次 acquire 获得租约，时间由数据库生成', async () => {
    await reset();
    const result = await acquire('0xtrack-1', 'owner-a');
    expect(result).toMatchObject({
      kind: 'acquired',
      lease: { chain, txHash: '0xtrack-1', ownerToken: 'owner-a' },
    });
    expect(Date.parse(result.lease.leaseExpiresAt)).toBeGreaterThan(Date.parse(result.lease.heartbeatAt));
  });

  it('12 个不同 owner 并发 acquire，只有一个 acquired', async () => {
    await reset();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => acquire('0xtrack-race', `owner-${index}`)),
    );
    expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'held_by_other')).toHaveLength(11);
    expect(new Set(results.map((result) => result.lease.ownerToken)).size).toBe(1);
  });

  it('有效租约阻止第二 owner，且原 owner/到期时间不被覆盖', async () => {
    await reset();
    const first = await acquire('0xtrack-held', 'owner-a');
    const second = await acquire('0xtrack-held', 'owner-b', 600_000);
    expect(second).toMatchObject({ kind: 'held_by_other', lease: { ownerToken: 'owner-a' } });
    expect(second.lease.leaseExpiresAt).toBe(first.lease.leaseExpiresAt);
  });

  it('租约过期后新 owner 可以接管', async () => {
    await reset();
    await acquire('0xtrack-takeover', 'owner-old', -1);
    const takeover = await acquire('0xtrack-takeover', 'owner-new');
    expect(takeover).toMatchObject({
      kind: 'acquired',
      lease: { ownerToken: 'owner-new' },
    });
  });

  it('过期租约被 10 个新 owner 并发接管时只有一个赢家', async () => {
    await reset();
    await acquire('0xtrack-takeover-race', 'owner-old', -1);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        acquire('0xtrack-takeover-race', `owner-new-${index}`),
      ),
    );
    expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'held_by_other')).toHaveLength(9);
    expect(new Set(results.map((result) => result.lease.ownerToken)).size).toBe(1);
  });

  it('接管后旧 owner renew 失败，新 owner renew 成功并推进 heartbeat', async () => {
    await reset();
    await acquire('0xtrack-renew', 'owner-old', -1);
    const takeover = await acquire('0xtrack-renew', 'owner-new');
    const stale = await store.renew({
      chain,
      txHash: '0xtrack-renew',
      ownerToken: 'owner-old',
      leaseTtlMs: 60_000,
    });
    expect(stale).toEqual({ kind: 'lost' });

    const renewed = await store.renew({
      chain,
      txHash: '0xtrack-renew',
      ownerToken: 'owner-new',
      leaseTtlMs: 120_000,
    });
    expect(renewed.kind).toBe('renewed');
    if (renewed.kind === 'renewed') {
      expect(Date.parse(renewed.lease.leaseExpiresAt)).toBeGreaterThan(
        Date.parse(takeover.lease.leaseExpiresAt),
      );
      expect(Date.parse(renewed.lease.heartbeatAt)).toBeGreaterThanOrEqual(
        Date.parse(takeover.lease.heartbeatAt),
      );
    }
  });

  it('已过期 owner 即使尚未被接管也不能 renew', async () => {
    await reset();
    await acquire('0xtrack-expired-renew', 'owner-old', -1);
    expect(
      await store.renew({
        chain,
        txHash: '0xtrack-expired-renew',
        ownerToken: 'owner-old',
        leaseTtlMs: 60_000,
      }),
    ).toEqual({ kind: 'lost' });
  });

  it('release 校验 owner 与有效期；成功后同一 owner 再释放也返回 lost', async () => {
    await reset();
    await acquire('0xtrack-release', 'owner-a');
    expect(
      await store.release({ chain, txHash: '0xtrack-release', ownerToken: 'owner-wrong' }),
    ).toEqual({ kind: 'lost' });
    expect(
      await store.release({ chain, txHash: '0xtrack-release', ownerToken: 'owner-a' }),
    ).toEqual({ kind: 'released' });
    expect(
      await store.release({ chain, txHash: '0xtrack-release', ownerToken: 'owner-a' }),
    ).toEqual({ kind: 'lost' });
  });

  it('已过期 owner 不能 release', async () => {
    await reset();
    await acquire('0xtrack-expired-release', 'owner-old', -1);
    expect(
      await store.release({ chain, txHash: '0xtrack-expired-release', ownerToken: 'owner-old' }),
    ).toEqual({ kind: 'lost' });
  });

  it('listRecoverable 只返回过期租约，按 txHash 键集分页', async () => {
    await reset();
    await acquire('0x01', 'o1', -1);
    await acquire('0x02', 'o2', 60_000);
    await acquire('0x03', 'o3', -1);
    await acquire('0x04', 'o4', -1);

    const first = await store.listRecoverable({ chain, limit: 2 });
    expect(first.map((lease) => lease.txHash)).toEqual(['0x01', '0x03']);
    const second = await store.listRecoverable({ chain, limit: 2, afterTxHash: '0x03' });
    expect(second.map((lease) => lease.txHash)).toEqual(['0x04']);
  });

  it('listRecoverable 对非正 limit 返回空列表', async () => {
    await reset();
    await acquire('0xtrack-limit', 'owner-a', -1);
    expect(await store.listRecoverable({ chain, limit: 0 })).toEqual([]);
    expect(await store.listRecoverable({ chain, limit: -1 })).toEqual([]);
  });

  it('listRecoverable 无论调用方 limit 多大，每批最多返回 500 条', async () => {
    await reset();
    await inspector.query(
      `INSERT INTO ${SCHEMA}.tracker_leases
         (chain_id, tx_hash, owner_token, lease_expires_at, heartbeat_at)
       SELECT $1, '0xbulk-' || lpad(i::text, 4, '0'), 'bulk-owner',
              clock_timestamp() - interval '1 second', clock_timestamp()
         FROM generate_series(1, 501) AS i`,
      [chain],
    );
    expect(await store.listRecoverable({ chain, limit: 10_000 })).toHaveLength(500);
  });

  it('恢复分页按 chain 隔离，相同 txHash 不会跨链互相跳过', async () => {
    await reset();
    const otherChain = 'base-sepolia' as ChainId;
    await acquire('0xsame', 'owner-eth', -1);
    await store.acquire({
      chain: otherChain,
      txHash: '0xsame',
      ownerToken: 'owner-base',
      leaseTtlMs: -1,
    });

    const ethereum = await store.listRecoverable({ chain, limit: 1 });
    const base = await store.listRecoverable({ chain: otherChain, limit: 1 });
    expect(ethereum.map((lease) => [lease.chain, lease.txHash])).toEqual([[chain, '0xsame']]);
    expect(base.map((lease) => [lease.chain, lease.txHash])).toEqual([[otherChain, '0xsame']]);
  });
});
