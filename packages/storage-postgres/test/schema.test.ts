/**
 * M1 存储 schema 契约测试（DFR-M1-A07）。
 *
 * 权威来源：docs/architecture/m1-storage-model.md 第 3 节、ADR-015。
 *
 * 默认**跳过**：CI 与本地默认门禁不依赖数据库（与 testnet 用例同一约定）。
 * 显式开启：
 *
 *   DFR_TRANSACTION_MIGRATION_DATABASE_URL=postgres://dfr_migrator:...@127.0.0.1:55432/dfr_m1_test \
 *   DFR_TRANSACTION_DATABASE_URL=postgres://dfr_runtime:...@127.0.0.1:55432/dfr_m1_test \
 *   pnpm vitest run packages/storage-postgres/test/schema.test.ts
 *
 * 变量名与 docs/development/configuration-reference.md 一致：
 *   - `DFR_TRANSACTION_MIGRATION_DATABASE_URL` 是**迁移身份**（可 DDL）；
 *   - `DFR_TRANSACTION_DATABASE_URL` 是**运行时身份**（仅 DML）。
 *
 * 本测试直接执行 `migrations/*.sql`，验证的是**迁移产物**而不是实现假设：
 *   - 空库可迁移；
 *   - 表/列/类型/约束/索引与 m1-storage-model 第 3 节一致；
 *   - 数据库不存在任何敏感列（禁止列清单）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const migrationsDir = join(packageRoot, 'migrations');

/** 迁移身份连接串：本测试需要 DDL（DROP SCHEMA / CREATE TABLE）。 */
const MIGRATION_DSN = process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
const ENABLED = typeof MIGRATION_DSN === 'string' && MIGRATION_DSN.length > 0;

/**
 * 运行时身份连接串（可选）。
 *
 * 设置后额外验证"migration 身份与 runtime 身份分离"：
 * runtime 只能 DML，不能 DDL。未设置时该组用例跳过。
 */
const RUNTIME_DSN = process.env['DFR_TRANSACTION_DATABASE_URL'];
const ROLE_TEST_ENABLED = ENABLED && typeof RUNTIME_DSN === 'string' && RUNTIME_DSN.length > 0;

const SCHEMA = 'transaction_data';

/**
 * 八张表（m1-storage-model §1；`sequencing_leases` 由 M3-A01 / ADR-032 引入，
 * `provider_quota_daily` 由 E5 引入）。
 */
const TABLES = [
  'transactions',
  'transaction_transitions',
  'idempotency_records',
  'nonce_accounts',
  'nonce_leases',
  'tracker_leases',
  'sequencing_leases',
  'provider_quota_daily',
] as const;

/** TransactionStatus 全集（packages/types/src/transaction.ts）。 */
const TX_STATUSES = [
  'built',
  'simulated',
  'signed',
  'broadcast',
  'pending',
  'included',
  'confirmed',
  'finalized',
  'failed',
  'reverted',
  'dropped',
  'replaced',
  'unknown',
] as const;

/** 安全负对照名单：这些列名绝不允许出现在 transaction_data 中。 */
const FORBIDDEN_COLUMN_PATTERNS = [
  /private_?key/i,
  /mnemonic/i,
  /seed_?phrase/i,
  /api_?key/i,
  /credential/i,
  // 必须带词边界：否则会误伤 `unsigned_payload`（"un" + "signed_payload"）。
  /\bsigned_?payload\b/i,
  /^secret/i,
  /password/i,
  /passphrase/i,
  /cookie/i,
];

function migrationFiles(): readonly string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

let client: Client;

/** 安全护栏：只允许对明确的测试库做 DROP/建表。 */
function assertTestDatabase(database: string): void {
  if (!/_test$/u.test(database)) {
    throw new Error(
      `拒绝在非测试库 "${database}" 上执行 schema 测试（库名必须以 _test 结尾）`,
    );
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  client = new Client({ connectionString: MIGRATION_DSN });
  await client.connect();

  const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
  assertTestDatabase(rows[0]!.db);

  // 空库前提：清掉上一次运行留下的 schema，再执行迁移。
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await client.query(sql);
  }
}, 60_000);

afterAll(async () => {
  if (ENABLED && client) await client.end();
});

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

async function columns(): Promise<readonly ColumnRow[]> {
  const { rows } = await client.query<ColumnRow>(
    `SELECT table_name, column_name, data_type, is_nullable,
            numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [SCHEMA],
  );
  return rows;
}

function columnOf(rows: readonly ColumnRow[], table: string, column: string): ColumnRow {
  const found = rows.find((r) => r.table_name === table && r.column_name === column);
  if (found === undefined) throw new Error(`${table}.${column} 不存在`);
  return found;
}

describe.skipIf(!ENABLED)('M1 schema（DFR-M1-A07）', () => {
  it('迁移文件按文件名可排序且非空', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^0001_/u);
  });

  it('创建了 transaction_data schema 与八张表（无多余表）', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [SCHEMA],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
  });

  it('transactions 的列与类型符合 m1-storage-model §3.1', async () => {
    const rows = await columns();

    // 主键与版本
    expect(columnOf(rows, 'transactions', 'id').data_type).toBe('text');
    expect(columnOf(rows, 'transactions', 'state_version').data_type).toBe('bigint');
    expect(columnOf(rows, 'transactions', 'chain_id').is_nullable).toBe('NO');
    expect(columnOf(rows, 'transactions', 'status').is_nullable).toBe('NO');
    expect(columnOf(rows, 'transactions', 'request_fingerprint').is_nullable).toBe('NO');

    // nonce 必须是 numeric(78,0)，不能用 float/double（金额与 nonce 禁浮点）
    const nonce = columnOf(rows, 'transactions', 'nonce');
    expect(nonce.data_type).toBe('numeric');
    expect(nonce.numeric_precision).toBe(78);
    expect(nonce.numeric_scale).toBe(0);

    // 结构载荷与时间
    expect(columnOf(rows, 'transactions', 'block_ref').data_type).toBe('jsonb');
    expect(columnOf(rows, 'transactions', 'canonical_block_hash').data_type).toBe('text');
    expect(columnOf(rows, 'transactions', 'canonical_block_hash').is_nullable).toBe('YES');
    expect(columnOf(rows, 'transactions', 'created_at').data_type).toBe('timestamp with time zone');
    expect(columnOf(rows, 'transactions', 'updated_at').data_type).toBe('timestamp with time zone');

    // 可空字段
    for (const nullable of ['to_address', 'nonce', 'tx_hash', 'expected_hash', 'min_finality']) {
      expect(columnOf(rows, 'transactions', nullable).is_nullable, nullable).toBe('YES');
    }
  });

  it('transactions.status 受 CHECK 约束保护，只允许 TransactionStatus 全集', async () => {
    // 逐个合法状态都能写入 → 说明 CHECK 没有漏掉任何状态。
    for (const status of TX_STATUSES) {
      await client.query(
        `INSERT INTO ${SCHEMA}.transactions
           (id, project_id, chain_id, request_fingerprint, status, from_address)
         VALUES ($1, 'default', 'ethereum-sepolia', $2, $3, '0xabc')`,
        [`txn_check_${status}`, 'a'.repeat(64), status],
      );
    }
    // 非法状态必须被拒绝。
    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.transactions
           (id, project_id, chain_id, request_fingerprint, status, from_address)
         VALUES ('txn_bad', 'default', 'ethereum-sepolia', $1, 'orphaned', '0xabc')`,
        ['a'.repeat(64)],
      ),
    ).rejects.toThrow(/check|constraint/iu);
    // orphaned 不是交易状态（DFR-M1-A05 决议），必须在数据库层也被拒绝。
  });

  it('transactions.state_version 允许初始值 0，拒绝负值（DFR-M1-D07）', async () => {
    // TransactionEngine.build 首次落库写 state_version='0'，第一次 CAS 后为 1。
    // 0001 的 CHECK (state_version >= 1) 曾与该契约冲突，使真实 PostgreSQL 上
    // engine.build 必然失败——本断言把初始值 0 固定为数据库层的可写契约。
    await client.query(
      `INSERT INTO ${SCHEMA}.transactions
         (id, project_id, chain_id, request_fingerprint, status, state_version, from_address)
       VALUES ('txn_sv_zero', 'default', 'ethereum-sepolia', $1, 'built', 0, '0xabc')`,
      ['a'.repeat(64)],
    );
    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.transactions
           (id, project_id, chain_id, request_fingerprint, status, state_version, from_address)
         VALUES ('txn_sv_neg', 'default', 'ethereum-sepolia', $1, 'built', -1, '0xabc')`,
        ['b'.repeat(64)],
      ),
    ).rejects.toThrow(/check|constraint/iu);
  });

  it('transactions 对 (chain_id, tx_hash) 与 (chain_id, expected_hash) 有唯一约束', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'transactions'`,
      [SCHEMA],
    );
    const all = rows.map((r) => r.indexdef).join('\n');
    expect(all).toMatch(/UNIQUE.*\(chain_id, tx_hash\)/su);
    expect(all).toMatch(/UNIQUE.*\(chain_id, expected_hash\)/su);
  });

  it('transaction_transitions 有 FK、occurred_at 与审计索引（§3.2）', async () => {
    const rows = await columns();
    expect(columnOf(rows, 'transaction_transitions', 'id').data_type).toBe('bigint');
    expect(columnOf(rows, 'transaction_transitions', 'transaction_id').data_type).toBe('text');
    expect(columnOf(rows, 'transaction_transitions', 'metadata').data_type).toBe('jsonb');
    expect(columnOf(rows, 'transaction_transitions', 'occurred_at').data_type).toBe(
      'timestamp with time zone',
    );

    const { rows: fks } = await client.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = $1 AND table_name = 'transaction_transitions'
          AND constraint_type = 'FOREIGN KEY'`,
      [SCHEMA],
    );
    expect(fks.length).toBeGreaterThan(0);

    const { rows: idx } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'transaction_transitions'`,
      [SCHEMA],
    );
    expect(idx.map((r) => r.indexdef).join('\n')).toMatch(/\(transaction_id, id\)/u);
  });

  it('idempotency_records 对 (project_id, chain_id, key) 唯一，且 state 受 CHECK 约束（§3.3）', async () => {
    const { rows: idx } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'idempotency_records'`,
      [SCHEMA],
    );
    expect(idx.map((r) => r.indexdef).join('\n')).toMatch(
      /UNIQUE.*\(project_id, chain_id, key\)/su,
    );

    const rows = await columns();
    expect(columnOf(rows, 'idempotency_records', 'lease_expires_at').data_type).toBe(
      'timestamp with time zone',
    );
    expect(columnOf(rows, 'idempotency_records', 'response_body').data_type).toBe('jsonb');

    const insert = `INSERT INTO ${SCHEMA}.idempotency_records
        (project_id, chain_id, key, fingerprint, state, owner_token, lease_expires_at, expires_at)
      VALUES ('default', 'ethereum-sepolia', $1, $2, $3, 'o1', now(), now() + interval '1 day')`;
    await expect(client.query(insert, ['k1', 'a'.repeat(64), 'bogus'])).rejects.toThrow(
      /check|constraint/iu,
    );
    await client.query(insert, ['k1', 'a'.repeat(64), 'in_flight']);
  });

  it('nonce_accounts / nonce_leases 有规定的唯一键与状态 CHECK（§3.4）', async () => {
    const { rows: idx } = await client.query<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename IN ('nonce_accounts', 'nonce_leases')`,
      [SCHEMA],
    );
    const combined = idx.map((r) => r.indexdef).join('\n');
    expect(combined).toMatch(/UNIQUE.*\(chain_id, account_address\)/su);
    expect(combined).toMatch(/UNIQUE.*\(chain_id, account_address, nonce\)/su);
    expect(combined).toMatch(/UNIQUE.*\(transaction_id\)/su);

    const rows = await columns();
    expect(columnOf(rows, 'nonce_accounts', 'next_nonce').numeric_precision).toBe(78);
    expect(columnOf(rows, 'nonce_leases', 'nonce').numeric_precision).toBe(78);

    // nonce_leases.transaction_id 有 FK，所以必须先有父交易行。
    await client.query(
      `INSERT INTO ${SCHEMA}.transactions
         (id, project_id, chain_id, request_fingerprint, status, from_address)
       VALUES ('txn_nonce_parent', 'default', 'ethereum-sepolia', $1, 'built', '0xabc')
       ON CONFLICT (id) DO NOTHING`,
      ['b'.repeat(64)],
    );

    const insert = `INSERT INTO ${SCHEMA}.nonce_leases
        (chain_id, account_address, nonce, transaction_id, status, expires_at)
      VALUES ('ethereum-sepolia', '0xabc', 1, 'txn_nonce_parent', $1, now() + interval '5 min')`;
    await expect(client.query(insert, ['not-a-status'])).rejects.toThrow(/check|constraint/iu);
    await client.query(insert, ['reserved']);

    // 同一 transactionId 不得再绑定第二个 nonce；Store 行锁之外还有 DB 约束兜底。
    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.nonce_leases
           (chain_id, account_address, nonce, transaction_id, status, expires_at)
         VALUES ('ethereum-sepolia', '0xabc', 2, 'txn_nonce_parent', 'reserved',
                 now() + interval '5 min')`,
      ),
    ).rejects.toThrow(/unique|duplicate|唯一|重复/iu);
  });

  it('tracker_leases 对 (chain_id, tx_hash) 唯一（§3.5）', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'tracker_leases'`,
      [SCHEMA],
    );
    expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/UNIQUE.*\(chain_id, tx_hash\)/su);

    const cols = await columns();
    for (const c of ['owner_token', 'lease_expires_at', 'heartbeat_at']) {
      expect(columnOf(cols, 'tracker_leases', c), c).toBeTruthy();
    }
  });

  it('sequencing_leases 以 transaction_id 唯一（ADR-032：blockhash 可被多笔交易共用）', async () => {
    const { rows: idx } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'sequencing_leases'`,
      [SCHEMA],
    );
    const combined = idx.map((r) => r.indexdef).join('\n');
    // 身份列是 transaction_id；绝不能出现 token_value 上的唯一约束。
    expect(combined).toMatch(/UNIQUE.*\(transaction_id\)/su);
    expect(combined).toMatch(/sequencing_leases_account_idx/u);
    expect(combined).not.toMatch(/UNIQUE.*token_value/u);

    const rows = await columns();
    const height = columnOf(rows, 'sequencing_leases', 'last_valid_block_height');
    expect(height.data_type).toBe('numeric');
    expect(height.numeric_precision).toBe(78);
    expect(height.numeric_scale).toBe(0);
    expect(height.is_nullable).toBe('YES');
    expect(columnOf(rows, 'sequencing_leases', 'token_value').data_type).toBe('text');
    expect(columnOf(rows, 'sequencing_leases', 'transaction_id').is_nullable).toBe('NO');

    const insert = `INSERT INTO ${SCHEMA}.sequencing_leases
        (chain_id, account_address, token_kind, token_value, last_valid_block_height,
         transaction_id, status, expires_at)
      VALUES ('solana-devnet', 'So11111111111111111111111111111111111111112', $1, $2, 1, $3, $4,
              now() + interval '5 min')`;
    // token_kind 只允许 blockhash（M3 只服务 Solana；nonce 走 nonce_leases）。
    await expect(client.query(insert, ['nonce', '1', 'txn_seq_kind', 'reserved'])).rejects.toThrow(
      /check|constraint/iu,
    );
    // 非法状态被拒绝。
    await expect(
      client.query(insert, ['blockhash', 'BH1', 'txn_seq_status', 'bogus']),
    ).rejects.toThrow(/check|constraint/iu);
    await client.query(insert, ['blockhash', 'BH1', 'txn_seq_ok', 'reserved']);
    // 同一 token_value 再插一行（不同 transaction）必须成功——这是 Solana 语义。
    await client.query(insert, ['blockhash', 'BH1', 'txn_seq_ok2', 'reserved']);
    // 同一 transaction_id 不得有两个租约。
    await expect(
      client.query(insert, ['blockhash', 'BH2', 'txn_seq_ok', 'reserved']),
    ).rejects.toThrow(/unique|duplicate|唯一|重复/iu);
  });

  it('恢复扫描有可用索引（非终态 + 租约到期）', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1`,
      [SCHEMA],
    );
    const all = rows.map((r) => r.indexdef).join('\n');
    // 交易恢复扫描按 status 过滤 + 按 id 键集分页。
    expect(all).toMatch(/transactions.*\(status/u);
    // 租约接管按到期时间过滤。
    expect(all).toMatch(/lease_expires_at/u);
  });

  it('安全负对照：transaction_data 中不存在任何敏感列', async () => {
    const rows = await columns();
    const offenders = rows
      .filter((r) => FORBIDDEN_COLUMN_PATTERNS.some((p) => p.test(r.column_name)))
      .map((r) => `${r.table_name}.${r.column_name}`);
    expect(offenders, '数据库不得出现私钥/助记词/API Key/credential/signedPayload 等列').toEqual(
      [],
    );
  });

  it('transactions.sequencing_ref 为可空 jsonb，且形状 CHECK 保护判别联合（ADR-033）', async () => {
    const rows = await columns();
    const ref = columnOf(rows, 'transactions', 'sequencing_ref');
    expect(ref.data_type).toBe('jsonb');
    expect(ref.is_nullable).toBe('YES');

    const insertTx = `INSERT INTO ${SCHEMA}.transactions
        (id, project_id, chain_id, request_fingerprint, status, from_address, sequencing_ref)
      VALUES ($1, 'default', 'solana-devnet', $2, 'built', '0xabc', $3::jsonb)`;
    // 合法 blockhash 形状。
    await client.query(insertTx, ['txn_ref_bh', 'f'.repeat(64), JSON.stringify({ kind: 'blockhash', value: 'BH', lastValidBlockHeight: '1' })]);
    // 合法 nonce 形状。
    await client.query(insertTx, ['txn_ref_nonce', 'e'.repeat(64), JSON.stringify({ kind: 'nonce', value: '42' })]);
    // 非法：blockhash 缺 lastValidBlockHeight。
    await expect(
      client.query(insertTx, ['txn_ref_bad1', 'd'.repeat(64), JSON.stringify({ kind: 'blockhash', value: 'BH' })]),
    ).rejects.toThrow(/check|constraint/iu);
    // 非法：nonce 带 lastValidBlockHeight。
    await expect(
      client.query(insertTx, ['txn_ref_bad2', 'c'.repeat(64), JSON.stringify({ kind: 'nonce', value: '1', lastValidBlockHeight: '9' })]),
    ).rejects.toThrow(/check|constraint/iu);
    // 非法：未知 kind。
    await expect(
      client.query(insertTx, ['txn_ref_bad3', 'b'.repeat(64), JSON.stringify({ kind: 'wat', value: 'x' })]),
    ).rejects.toThrow(/check|constraint/iu);
    // NULL 合法（历史行形态）。
    await client.query(
      `INSERT INTO ${SCHEMA}.transactions (id, project_id, chain_id, request_fingerprint, status, from_address)
       VALUES ('txn_ref_null', 'default', 'ethereum-sepolia', $1, 'built', '0xabc')`,
      ['a'.repeat(64)],
    );
  });

  it('unsigned_payload 存在但不是 Secret；signed_payload 必须不存在', async () => {
    const rows = await columns();
    expect(columnOf(rows, 'transactions', 'unsigned_payload').data_type).toBe('text');
    expect(rows.some((r) => r.column_name === 'signed_payload')).toBe(false);
  });
});

/**
 * 身份分离负对照（infrastructure/README.md："migration 身份与 runtime 数据库身份分离"）。
 *
 * 用 runtime 角色连接，证明 DML 放行、DDL 被拒。
 * 若数据库被配成单一超级用户，这组断言会失败——这正是我们要防的配置漂移。
 */
describe.skipIf(!ROLE_TEST_ENABLED)('runtime 身份权限边界（DFR-M1-A07）', () => {
  let runtime: Client;

  beforeAll(async () => {
    runtime = new Client({ connectionString: RUNTIME_DSN });
    await runtime.connect();
  }, 30_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
  });

  it('runtime 可以通过 DML 读写 transaction_data', async () => {
    await expect(
      runtime.query(`SELECT count(*) FROM ${SCHEMA}.transactions`),
    ).resolves.toBeTruthy();
  });

  it('runtime 不能执行 DDL（建表 / 删表 / 改表 / 建 schema）', async () => {
    const ddl = [
      `CREATE TABLE ${SCHEMA}.runtime_should_fail (i int)`,
      `DROP TABLE ${SCHEMA}.transactions`,
      `ALTER TABLE ${SCHEMA}.transactions ADD COLUMN runtime_should_fail int`,
      'CREATE SCHEMA runtime_should_fail',
    ];
    for (const statement of ddl) {
      // 42501 = insufficient_privilege
      await expect(runtime.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('runtime 不能删除 public schema 的建表权限（回归：REVOKE CREATE 生效）', async () => {
    await expect(runtime.query('CREATE TABLE public.runtime_should_fail (i int)')).rejects.toThrow(
      /permission denied|权限/iu,
    );
  });
});
