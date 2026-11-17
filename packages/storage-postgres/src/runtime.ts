/** PostgreSQL Store 运行时工厂（ADR-017）。 */
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
   * M3-A01：Solana blockhash 排序租约（ADR-032 方案 A，与 `nonce` 并存）。
   *
   * 可选：M3 之前的部署不需要它；EVM 写路径也不用它。Solana 写路径装配后必填。
   */
  readonly sequencing?: SequencingStore;
  /** E5：Provider 日配额的跨实例原子计数。 */
  readonly providerQuota: PostgresProviderQuotaStore;
}

export interface PostgresTransactionRuntime {
  readonly stores: PostgresTransactionStores;
  /**
   * 依赖就绪探针（DFR-M1-E02）：执行 `SELECT 1`。
   *
   * 供 Gateway `/readyz` 使用；失败时抛 `PostgresRuntimeUnavailableError`，
   * **不**携带 DSN 或驱动原文。与 `close()` 一样是幂等只读操作。
   */
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

export interface CreatePostgresTransactionRuntimeOptions {
  /** 敏感值：只传给 pg，不写入错误、日志或返回值。 */
  readonly databaseUrl: string;
  readonly connectionTimeoutMs?: number;
  /**
   * 空闲连接被上游切断时的通知（可选）。
   *
   * `pg.Pool` 在空闲客户端出错时会发 `error` 事件；没有监听器时 Node 会把
   * 它当成未捕获异常并退出进程。Gateway 必须保持存活（只让 `/readyz` 变 503），
   * 因此运行时始终安装处理器，并通过本回调交给 composition root 记固定日志。
   * 回调必须容错；其异常不得影响进程存活。
   */
  readonly onPoolError?: () => void;
}

export class PostgresRuntimeUnavailableError extends Error {
  override readonly name = 'PostgresRuntimeUnavailableError';

  constructor() {
    super('M1 transaction database is unavailable');
  }
}

/** 创建 Pool、执行 readiness probe，并只暴露 Store 端口与 close。 */
export async function createPostgresTransactionRuntime(
  options: CreatePostgresTransactionRuntimeOptions,
): Promise<PostgresTransactionRuntime> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
  });

  // 关键：必须先安装 error 监听器。数据库重启/网络抖动会切断空闲连接，
  // 没有监听器时 pg 的池级 error 会以未捕获异常结束进程——表现为整个 Gateway
  // 消失（连接被拒），而不是 fail-closed 的 /readyz 503。回调只传固定信号，
  // 不接收或记录驱动异常，避免 DSN/口令进入日志。
  pool.on('error', () => {
    try {
      options.onPoolError?.();
    } catch {
      // 观测回调失败不能反过来杀死进程。
    }
  });

  try {
    await pool.query('SELECT 1');
  } catch {
    try {
      await pool.end();
    } catch {
      // 保留固定的脱敏错误，不暴露驱动异常或 DSN。
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
        // 与启动探针同一约定：对外只暴露固定的脱敏错误。
        throw new PostgresRuntimeUnavailableError();
      }
    },
    close: () => {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
