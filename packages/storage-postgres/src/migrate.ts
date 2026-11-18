/**
 * Migration runner (DFR-M1-A08).
 *
 * Authoritative sources: ADR-015 §3, docs/architecture/m1-storage-model.md.
 *
 * Semantics (each has a corresponding test):
 *   1. **Filename order**: `0001_*.sql` runs before `0002_*.sql`;
 *   2. **Version table + checksum**: applied migrations record their sha256, and changed content is an error,
 *      preventing "editing a shipped migration and forking schemas across environments";
 *   3. **One transaction per migration**: the migration SQL and its version row commit in the same transaction;
 *      a mid-way failure must roll back everything, leaving no half-applied state;
 *   4. **Forward only**: no down migration is provided (ADR-015 §3); fixes come via new migrations;
 *   5. The version table is separate from the business schema, so it does not pollute `transaction_data`'s table set.
 *
 * Boundaries:
 *   - This module only executes SQL; it does not generate SQL, diff schemas, or manage connection pools;
 *   - The caller (CLI / composition root / tests) provides a connected `Client`
 *     and the list of migrations to run.
 *
 * Transaction-control statements (BEGIN/COMMIT/ROLLBACK) are **forbidden** in migration SQL:
 * the runner already opens a transaction per migration, and nesting would break the "failure rolls back everything" guarantee.
 * Violations throw `transaction_control_in_migration` instead of executing silently.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';

/** A migration to run. `name` is both the sort key and the version-table primary key. */
export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

/** Default schema name for the version table. Deliberately separate from the business schema `transaction_data`. */
export const DEFAULT_MIGRATIONS_SCHEMA = 'dfr_migrations';
/** Default version-table name. */
export const DEFAULT_MIGRATIONS_TABLE = 'schema_migrations';

export type MigrationErrorReason =
  /** An applied migration's content was modified (checksum mismatch). */
  | 'checksum_mismatch'
  /** The version table has a record, but the file is missing from this run's migration list. */
  | 'applied_migration_missing'
  /** Duplicate migration name. */
  | 'duplicate_migration_name'
  /** Migration SQL contains transaction-control statements. */
  | 'transaction_control_in_migration'
  /** Schema / table name is not a safe identifier. */
  | 'invalid_identifier';

export class MigrationError extends Error {
  readonly reason: MigrationErrorReason;
  /** The migration name involved (if applicable). */
  readonly migrationName?: string;

  constructor(reason: MigrationErrorReason, message: string, migrationName?: string) {
    super(message);
    this.name = 'MigrationError';
    this.reason = reason;
    if (migrationName !== undefined) this.migrationName = migrationName;
  }
}

/** Compute the sha256 (hex) of migration content. Sensitive to whitespace differences — deliberately so. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Load all `*.sql` files from a directory, in ascending filename order.
 *
 * Sorting uses the default string comparison (not locale-aware), for cross-platform consistency;
 * so names must use zero-padded numeric prefixes (`0001_`, `0002_`).
 */
export function loadMigrations(dir: string): readonly MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return names.map((name) => ({
    name,
    sql: readFileSync(join(dir, name), 'utf8'),
  }));
}

export interface RunMigrationsOptions {
  /** A connected client. Transactions are managed by this function. */
  readonly client: Client;
  readonly migrations: readonly MigrationFile[];
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
}

export interface MigrationRunResult {
  /** Names of migrations actually executed this run (in execution order). */
  readonly applied: readonly string[];
  /** Names of migrations skipped this run (already applied with matching checksum). */
  readonly skipped: readonly string[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\s*;/imu;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new MigrationError('invalid_identifier', `${label} is not a safe identifier: ${value}`);
  }
}

function assertNoTransactionControl(migration: MigrationFile): void {
  if (TRANSACTION_CONTROL.test(migration.sql)) {
    throw new MigrationError(
      'transaction_control_in_migration',
      `migration ${migration.name} contains transaction-control statements; the runner already opens a transaction per migration, ` +
        'and nesting would break the "failure rolls back everything" guarantee.',
      migration.name,
    );
  }
}

function ensureUniqueNames(migrations: readonly MigrationFile[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.name)) {
      throw new MigrationError(
        'duplicate_migration_name',
        `duplicate migration name: ${migration.name}`,
        migration.name,
      );
    }
    seen.add(migration.name);
  }
}

/**
 * Execute migrations forward.
 *
 * No errors are swallowed: any failure is thrown upward, and the caller decides how to present it.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationRunResult> {
  const { client } = options;
  const schema = options.migrationsSchema ?? DEFAULT_MIGRATIONS_SCHEMA;
  const table = options.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE;
  assertIdentifier(schema, 'migrationsSchema');
  assertIdentifier(table, 'migrationsTable');

  ensureUniqueNames(options.migrations);

  // The version table comes before everything: it must itself be repeatable.
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${schema}.${table} (
       name        text PRIMARY KEY,
       checksum    text NOT NULL,
       applied_at  timestamptz NOT NULL DEFAULT clock_timestamp()
     )`,
  );

  const { rows } = await client.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM ${schema}.${table}`,
  );
  const appliedBefore = new Map(rows.map((r) => [r.name, r.checksum]));

  const ordered = [...options.migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const provided = new Set(ordered.map((m) => m.name));

  // In the version table but not in this run's list: a migration file was deleted or the directory was swapped.
  // Silently ignoring it would permanently fork schemas across environments, so it must fail explicitly.
  for (const name of appliedBefore.keys()) {
    if (!provided.has(name)) {
      throw new MigrationError(
        'applied_migration_missing',
        `migration ${name} is recorded in the version table, but was not provided this run; ` +
          'migration files must never be deleted; fix by adding a new forward migration.',
        name,
      );
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of ordered) {
    const checksum = checksumOf(migration.sql);
    const previous = appliedBefore.get(migration.name);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new MigrationError(
          'checksum_mismatch',
          `migration ${migration.name} was already applied, but its content changed (expected ${previous}, actual ${checksum}). ` +
            'Applied migrations must never be modified; add a new forward migration instead.',
          migration.name,
        );
      }
      skipped.push(migration.name);
      continue;
    }

    assertNoTransactionControl(migration);

    // Migration SQL and version row share one transaction: on failure everything rolls back, leaving no half-applied state.
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${schema}.${table} (name, checksum) VALUES ($1, $2)`,
        [migration.name, checksum],
      );
      await client.query('COMMIT');
      applied.push(migration.name);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A failed rollback must not mask the original error: the original error is the root cause.
      }
      throw error;
    }
  }

  return { applied, skipped };
}
