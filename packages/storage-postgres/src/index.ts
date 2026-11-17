/**
 * @dfr/storage-postgres —— M1 Store 端口的 PostgreSQL 实现（ADR-015）。
 *
 * 责任：用 `pg` + 显式参数化 SQL 实现 `@dfr/transaction` 的四个 Store 端口，
 * 并把并发语义（行锁、乐观版本、租约、唯一约束）固定在 SQL 层。
 *
 * 不负责：状态机语义、HTTP、Provider、链 RPC。
 *
 * 依赖方向：本包 → `@dfr/transaction`（端口）→ `@dfr/types`。
 * 反向依赖（Transaction/Core 依赖本包或 `pg`）被禁止，并由
 * tests/contract/module-boundaries.test.ts 守卫。
 *
 * 状态：DFR-M1-A07 只建立包骨架与第一版迁移；Store 实现见 A09–A12，
 * 迁移运行器见 A08。
 */

/** 迁移文件所在目录（相对包根）。A08 的迁移运行器按文件名顺序执行。 */
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
