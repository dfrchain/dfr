/**
 * @dfr/storage-postgres — PostgreSQL implementation of the M1 Store ports (ADR-015).
 *
 * Responsibility: implement `@dfr/transaction`'s four Store ports with `pg` + explicit parameterized SQL,
 * pinning the concurrency semantics (row locks, optimistic versions, leases, unique constraints) in the SQL layer.
 *
 * Not responsible for: state-machine semantics, HTTP, Providers, chain RPC.
 *
 * Dependency direction: this package → `@dfr/transaction` (ports) → `@dfr/types`.
 * Reverse dependencies (Transaction/Core depending on this package or on `pg`) are forbidden, and are guarded by
 * tests/contract/module-boundaries.test.ts.
 *
 * Status: DFR-M1-A07 only set up the package skeleton and the first migration; the Store implementations are A09–A12,
 * and the migration runner is A08.
 */

/** Directory holding the migration files (relative to the package root). A08's migration runner executes them in filename order. */
export const MIGRATIONS_DIR = 'migrations' as const;

export {
  DEFAULT_MIGRATIONS_SCHEMA,
  DEFAULT_MIGRATIONS_TABLE,
  MigrationError,
  checksumOf,
  loadMigrations,
  runMigrations,
} from './migrate.js';
export type {
  MigrationErrorReason,
  MigrationFile,
  MigrationRunResult,
  RunMigrationsOptions,
} from './migrate.js';

export { PostgresTransactionStore, RECOVERABLE_STATUSES } from './transaction-store.js';

export { PostgresIdempotencyStore } from './idempotency-store.js';
export type { PostgresIdempotencyStoreOptions } from './idempotency-store.js';

export { PostgresNonceStore } from './nonce-store.js';

export { PostgresSequencingStore } from './sequencing-store.js';

export { PostgresTrackerLeaseStore } from './tracker-lease-store.js';

export { PostgresProviderQuotaStore } from './provider-quota-store.js';

export {
  PostgresRuntimeUnavailableError,
  createPostgresTransactionRuntime,
} from './runtime.js';
export type {
  CreatePostgresTransactionRuntimeOptions,
  PostgresTransactionRuntime,
  PostgresTransactionStores,
} from './runtime.js';
