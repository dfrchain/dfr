/** PostgreSQL Store runtime factory (ADR-017). */
import type {
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLeaseStore,
  TransactionStore,
} from '@dfr/transaction';
import { Pool } from 'pg';
import { PostgresIdempotencyStore } from './idempotency-store.js';
import { PostgresNonceStore } from './nonce-store.js';
import { PostgresProviderQuotaStore } from './provider-quota-store.js';
import { PostgresSequencingStore } from './sequencing-store.js';
import { PostgresTrackerLeaseStore } from './tracker-lease-store.js';
import { PostgresTransactionStore } from './transaction-store.js';

export interface PostgresTransactionStores {
  readonly transaction: TransactionStore;
  readonly idempotency: IdempotencyStore;
  readonly nonce: NonceStore;
  readonly tracker: TrackerLeaseStore;
  /**
   * M3-A01: Solana blockhash sequencing leases (ADR-032 option A, coexisting with `nonce`).
   *
   * Optional: pre-M3 deployments do not need it; neither does the EVM write path. Required once the Solana write path is assembled.
   */
  readonly sequencing?: SequencingStore;
  /** E5: cross-instance atomic counting of the Provider daily quota. */
  readonly providerQuota: PostgresProviderQuotaStore;
}

export interface PostgresTransactionRuntime {
  readonly stores: PostgresTransactionStores;
  /**
   * Dependency readiness probe (DFR-M1-E02): runs `SELECT 1`.
   *
   * Used by Gateway `/readyz`; on failure it throws `PostgresRuntimeUnavailableError`,
   * carrying **no** DSN or raw driver text. Like `close()`, it is an idempotent read-only operation.
   */
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

export interface CreatePostgresTransactionRuntimeOptions {
  /** Sensitive value: passed only to pg, never written into errors, logs, or return values. */
  readonly databaseUrl: string;
  readonly connectionTimeoutMs?: number;
  /**
   * Notification when an idle connection is cut by the upstream side (optional).
   *
   * When an idle client errors, `pg.Pool` emits an `error` event; with no listener, Node treats it
   * as an uncaught exception and exits the process. The Gateway must stay alive (only `/readyz` becomes 503),
   * so the runtime always installs a handler and passes it to the composition root via this callback for fixed-message logging.
   * The callback must be fault-tolerant; its exceptions must not affect process survival.
   */
  readonly onPoolError?: () => void;
}

export class PostgresRuntimeUnavailableError extends Error {
  override readonly name = 'PostgresRuntimeUnavailableError';

  constructor() {
    super('M1 transaction database is unavailable');
  }
}

/** Create the Pool, run the readiness probe, and expose only the Store ports and close. */
export async function createPostgresTransactionRuntime(
  options: CreatePostgresTransactionRuntimeOptions,
): Promise<PostgresTransactionRuntime> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });

  // Critical: install the error listener first. Database restarts / network jitter cut idle connections,
  // and without a listener the pg pool-level error ends the process as an uncaught exception — the whole Gateway
  // disappears (connections refused) instead of a fail-closed /readyz 503. The callback only passes a fixed signal,
  // and never receives or records driver exceptions, so no DSN/password enters the logs.
  pool.on('error', () => {
    try {
      options.onPoolError?.();
    } catch {
      // A failing observability callback must not kill the process in return.
    }
  });

  try {
    await pool.query('SELECT 1');
  } catch {
    try {
      await pool.end();
    } catch {
      // Keep the fixed redacted error; do not expose driver exceptions or the DSN.
    }
    throw new PostgresRuntimeUnavailableError();
  }

  let closePromise: Promise<void> | undefined;

  return {
    stores: {
      transaction: new PostgresTransactionStore(pool),
      idempotency: new PostgresIdempotencyStore(pool),
      nonce: new PostgresNonceStore(pool),
      tracker: new PostgresTrackerLeaseStore(pool),
      sequencing: new PostgresSequencingStore(pool),
      providerQuota: new PostgresProviderQuotaStore(pool),
    },
    healthCheck: async () => {
      try {
        await pool.query('SELECT 1');
      } catch {
        // Same convention as the startup probe: only the fixed redacted error is exposed.
        throw new PostgresRuntimeUnavailableError();
      }
    },
    close: () => {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
