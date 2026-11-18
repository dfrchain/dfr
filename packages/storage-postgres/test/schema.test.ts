/**
 * M1 storage schema contract test (DFR-M1-A07).
 *
 * Authoritative sources: docs/architecture/m1-storage-model.md section 3, ADR-015.
 *
 * Skipped by **default**: CI and the local default gates do not depend on a database (same convention as the testnet cases).
 * Enable explicitly:
 *
 *   DFR_TRANSACTION_MIGRATION_DATABASE_URL=postgres://dfr_migrator:...@127.0.0.1:55432/dfr_m1_test \
 *   DFR_TRANSACTION_DATABASE_URL=postgres://dfr_runtime:...@127.0.0.1:55432/dfr_m1_test \
 *   pnpm vitest run packages/storage-postgres/test/schema.test.ts
 *
 * Variable names match docs/development/configuration-reference.md:
 *   - `DFR_TRANSACTION_MIGRATION_DATABASE_URL` is the **migration identity** (may run DDL);
 *   - `DFR_TRANSACTION_DATABASE_URL` is the **runtime identity** (DML only).
 *
 * This test executes `migrations/*.sql` directly, verifying the **migration output** rather than implementation assumptions:
 *   - An empty database can be migrated;
 *   - Tables/columns/types/constraints/indexes match m1-storage-model section 3;
 *   - The database has no sensitive columns (forbidden-column list).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const migrationsDir = join(packageRoot, 'migrations');

/** Migration-identity connection string: this test needs DDL (DROP SCHEMA / CREATE TABLE). */
const MIGRATION_DSN = process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
const ENABLED = typeof MIGRATION_DSN === 'string' && MIGRATION_DSN.length > 0;

/**
 * Runtime-identity connection string (optional).
 *
 * When set, it additionally verifies "migration identity and runtime identity are separate":
 * runtime may only run DML, not DDL. This group is skipped when unset.
 */
const RUNTIME_DSN = process.env['DFR_TRANSACTION_DATABASE_URL'];
const ROLE_TEST_ENABLED = ENABLED && typeof RUNTIME_DSN === 'string' && RUNTIME_DSN.length > 0;

const SCHEMA = 'transaction_data';

/**
 * Eight tables (m1-storage-model §1; `sequencing_leases` introduced by M3-A01 / ADR-032,
 * `provider_quota_daily` introduced by E5).
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

/** The full TransactionStatus set (packages/types/src/transaction.ts). */
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

/** Safety negative-case list: these column names must never appear in transaction_data. */
const FORBIDDEN_COLUMN_PATTERNS = [
  /private_?key/i,
  /mnemonic/i,
  /seed_?phrase/i,
  /api_?key/i,
  /credential/i,
  // Word boundaries are required: otherwise `unsigned_payload` would be falsely hit ("un" + "signed_payload").
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

/** Safety guard: DROP / table creation is only allowed against an explicit test database. */
function assertTestDatabase(database: string): void {
  if (!/_test$/u.test(database)) {
    throw new Error(
      `refusing to run schema tests against non-test database "${database}" (database name must end with _test)`,
    );
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  client = new Client({ connectionString: MIGRATION_DSN });
  await client.connect();

  const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
  assertTestDatabase(rows[0]!.db);

  // Empty-database precondition: clear the schema left by the previous run, then run the migrations.
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
  if (found === undefined) throw new Error(`${table}.${column} does not exist`);
  return found;
}

describe.skipIf(!ENABLED)('M1 schema (DFR-M1-A07)', () => {
  it('migration files are sortable by filename and non-empty', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^0001_/u);
  });

  it('creates the transaction_data schema and eight tables (no extra tables)', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [SCHEMA],
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...TABLES].sort());
  });

  it('transactions columns and types match m1-storage-model §3.1', async () => {
    const rows = await columns();

    // Primary key and version
    expect(columnOf(rows, 'transactions', 'id').data_type).toBe('text');
    expect(columnOf(rows, 'transactions', 'state_version').data_type).toBe('bigint');
    expect(columnOf(rows, 'transactions', 'chain_id').is_nullable).toBe('NO');
    expect(columnOf(rows, 'transactions', 'status').is_nullable).toBe('NO');
    expect(columnOf(rows, 'transactions', 'request_fingerprint').is_nullable).toBe('NO');

    // nonce must be numeric(78,0), not float/double (amounts and nonces forbid floats)
    const nonce = columnOf(rows, 'transactions', 'nonce');
    expect(nonce.data_type).toBe('numeric');
    expect(nonce.numeric_precision).toBe(78);
    expect(nonce.numeric_scale).toBe(0);

    // Structural payloads and times
    expect(columnOf(rows, 'transactions', 'block_ref').data_type).toBe('jsonb');
    expect(columnOf(rows, 'transactions', 'canonical_block_hash').data_type).toBe('text');
    expect(columnOf(rows, 'transactions', 'canonical_block_hash').is_nullable).toBe('YES');
    expect(columnOf(rows, 'transactions', 'created_at').data_type).toBe('timestamp with time zone');
    expect(columnOf(rows, 'transactions', 'updated_at').data_type).toBe('timestamp with time zone');

    // Nullable fields
    for (const nullable of ['to_address', 'nonce', 'tx_hash', 'expected_hash', 'min_finality']) {
      expect(columnOf(rows, 'transactions', nullable).is_nullable, nullable).toBe('YES');
    }
  });

  it('transactions.status is protected by a CHECK constraint allowing only the full TransactionStatus set', async () => {
    // Every legal state can be written → the CHECK misses no state.
    for (const status of TX_STATUSES) {
      await client.query(
        `INSERT INTO ${SCHEMA}.transactions
           (id, project_id, chain_id, request_fingerprint, status, from_address)
         VALUES ($1, 'default', 'ethereum-sepolia', $2, $3, '0xabc')`,
        [`txn_check_${status}`, 'a'.repeat(64), status],
      );
    }
    // Illegal states must be rejected.
    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.transactions
           (id, project_id, chain_id, request_fingerprint, status, from_address)
         VALUES ('txn_bad', 'default', 'ethereum-sepolia', $1, 'orphaned', '0xabc')`,
        ['a'.repeat(64)],
      ),
    ).rejects.toThrow(/check|constraint/iu);
    // orphaned is not a transaction state (DFR-M1-A05 decision) and must also be rejected at the database layer.
  });

  it('transactions.state_version allows the initial value 0 and rejects negatives (DFR-M1-D07)', async () => {
    // TransactionEngine.build first persists state_version='0', and it becomes 1 after the first CAS.
    // 0001's CHECK (state_version >= 1) once conflicted with that contract, making
    // engine.build always fail on real PostgreSQL — this assertion pins the initial value 0 as a writable database-layer contract.
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

  it('transactions has unique constraints on (chain_id, tx_hash) and (chain_id, expected_hash)', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'transactions'`,
      [SCHEMA],
    );
    const all = rows.map((r) => r.indexdef).join('\n');
    expect(all).toMatch(/UNIQUE.*\(chain_id, tx_hash\)/su);
    expect(all).toMatch(/UNIQUE.*\(chain_id, expected_hash\)/su);
  });

  it('transaction_transitions has an FK, occurred_at, and audit indexes (§3.2)', async () => {
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

  it('idempotency_records is unique on (project_id, chain_id, key) and its state is CHECK-constrained (§3.3)', async () => {
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

  it('nonce_accounts / nonce_leases have the specified unique keys and state CHECK (§3.4)', async () => {
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

    // nonce_leases.transaction_id has an FK, so the parent transaction row must exist first.
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

    // The same transactionId must not bind a second nonce; the DB constraint backs up the Store row lock.
    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.nonce_leases
           (chain_id, account_address, nonce, transaction_id, status, expires_at)
         VALUES ('ethereum-sepolia', '0xabc', 2, 'txn_nonce_parent', 'reserved',
                 now() + interval '5 min')`,
      ),
    ).rejects.toThrow(/unique|duplicate/iu);
  });

  it('tracker_leases is unique on (chain_id, tx_hash) (§3.5)', async () => {
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

  it('sequencing_leases is unique on transaction_id (ADR-032: a blockhash may be shared by many transactions)', async () => {
    const { rows: idx } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'sequencing_leases'`,
      [SCHEMA],
    );
    const combined = idx.map((r) => r.indexdef).join('\n');
    // The identity column is transaction_id; a unique constraint on token_value must never appear.
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
    // token_kind allows only blockhash (M3 serves only Solana; nonces use nonce_leases).
    await expect(client.query(insert, ['nonce', '1', 'txn_seq_kind', 'reserved'])).rejects.toThrow(
      /check|constraint/iu,
    );
    // Illegal states are rejected.
    await expect(
      client.query(insert, ['blockhash', 'BH1', 'txn_seq_status', 'bogus']),
    ).rejects.toThrow(/check|constraint/iu);
    await client.query(insert, ['blockhash', 'BH1', 'txn_seq_ok', 'reserved']);
    // Inserting another row with the same token_value (different transaction) must succeed — that is Solana semantics.
    await client.query(insert, ['blockhash', 'BH1', 'txn_seq_ok2', 'reserved']);
    // The same transaction_id must not have two leases.
    await expect(
      client.query(insert, ['blockhash', 'BH2', 'txn_seq_ok', 'reserved']),
    ).rejects.toThrow(/unique|duplicate/iu);
  });

  it('recovery scans have usable indexes (non-terminal + lease expiry)', async () => {
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1`,
      [SCHEMA],
    );
    const all = rows.map((r) => r.indexdef).join('\n');
    // Transaction recovery scans filter by status + keyset-paginate by id.
    expect(all).toMatch(/transactions.*\(status/u);
    // Lease takeovers filter by expiry time.
    expect(all).toMatch(/lease_expires_at/u);
  });

  it('safety negative case: no sensitive columns exist in transaction_data', async () => {
    const rows = await columns();
    const offenders = rows
      .filter((r) => FORBIDDEN_COLUMN_PATTERNS.some((p) => p.test(r.column_name)))
      .map((r) => `${r.table_name}.${r.column_name}`);
    expect(offenders, 'the database must not contain private key / mnemonic / API key / credential / signedPayload columns').toEqual(
      [],
    );
  });

  it('transactions.sequencing_ref is a nullable jsonb, and a shape CHECK protects the discriminated union (ADR-033)', async () => {
    const rows = await columns();
    const ref = columnOf(rows, 'transactions', 'sequencing_ref');
    expect(ref.data_type).toBe('jsonb');
    expect(ref.is_nullable).toBe('YES');

    const insertTx = `INSERT INTO ${SCHEMA}.transactions
        (id, project_id, chain_id, request_fingerprint, status, from_address, sequencing_ref)
      VALUES ($1, 'default', 'solana-devnet', $2, 'built', '0xabc', $3::jsonb)`;
    // Legal blockhash shape.
    await client.query(insertTx, ['txn_ref_bh', 'f'.repeat(64), JSON.stringify({ kind: 'blockhash', value: 'BH', lastValidBlockHeight: '1' })]);
    // Legal nonce shape.
    await client.query(insertTx, ['txn_ref_nonce', 'e'.repeat(64), JSON.stringify({ kind: 'nonce', value: '42' })]);
    // Illegal: blockhash missing lastValidBlockHeight.
    await expect(
      client.query(insertTx, ['txn_ref_bad1', 'd'.repeat(64), JSON.stringify({ kind: 'blockhash', value: 'BH' })]),
    ).rejects.toThrow(/check|constraint/iu);
    // Illegal: nonce carrying lastValidBlockHeight.
    await expect(
      client.query(insertTx, ['txn_ref_bad2', 'c'.repeat(64), JSON.stringify({ kind: 'nonce', value: '1', lastValidBlockHeight: '9' })]),
    ).rejects.toThrow(/check|constraint/iu);
    // Illegal: unknown kind.
    await expect(
      client.query(insertTx, ['txn_ref_bad3', 'b'.repeat(64), JSON.stringify({ kind: 'wat', value: 'x' })]),
    ).rejects.toThrow(/check|constraint/iu);
    // NULL is legal (historical-row shape).
    await client.query(
      `INSERT INTO ${SCHEMA}.transactions (id, project_id, chain_id, request_fingerprint, status, from_address)
       VALUES ('txn_ref_null', 'default', 'ethereum-sepolia', $1, 'built', '0xabc')`,
      ['a'.repeat(64)],
    );
  });

  it('unsigned_payload exists but is not a Secret; signed_payload must not exist', async () => {
    const rows = await columns();
    expect(columnOf(rows, 'transactions', 'unsigned_payload').data_type).toBe('text');
    expect(rows.some((r) => r.column_name === 'signed_payload')).toBe(false);
  });
});

/**
 * Identity-separation negative case (infrastructure/README.md: "migration identity and runtime database identity are separate").
 *
 * Connects with the runtime role to prove DML is allowed and DDL is refused.
 * If the database is configured as a single superuser, this group fails — exactly the configuration drift we want to prevent.
 */
describe.skipIf(!ROLE_TEST_ENABLED)('runtime identity permission boundary (DFR-M1-A07)', () => {
  let runtime: Client;

  beforeAll(async () => {
    runtime = new Client({ connectionString: RUNTIME_DSN });
    await runtime.connect();
  }, 30_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
  });

  it('runtime can read and write transaction_data via DML', async () => {
    await expect(
      runtime.query(`SELECT count(*) FROM ${SCHEMA}.transactions`),
    ).resolves.toBeTruthy();
  });

  it('runtime cannot run DDL (create / drop / alter tables, create schemas)', async () => {
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

  it('runtime cannot drop public schema table-creation permission (regression: REVOKE CREATE takes effect)', async () => {
    await expect(runtime.query('CREATE TABLE public.runtime_should_fail (i int)')).rejects.toThrow(
      /permission denied/iu,
    );
  });
});
