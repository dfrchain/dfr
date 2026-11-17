/**
 * PostgresIdempotencyStore（DFR-M1-A10）。
 *
 * 权威来源：docs/architecture/m1-storage-model.md 第 3.3 节、ADR-015。
 *
 * 语义要点：
 *   - scope 为 `(project_id, chain_id, key)`，由表上的复合主键保证唯一；
 *   - `begin` 用 `INSERT ... ON CONFLICT DO NOTHING` 抢占，冲突后再判定四种结果；
 *   - **不同 fingerprint 永不覆盖原记录**（永久冲突，不是"最后写入者获胜"）；
 *   - 租约使用 `lease_expires_at`，过期后允许换 owner 接管；
 *     接管通过带条件的 UPDATE 完成，因此并发接管也只有一个赢家；
 *   - **所有时间判断使用数据库 `clock_timestamp()`**，不用进程时钟
 *     （ADR-015 §7：避免多进程主机时钟漂移导致双 owner）。
 *
 * 边界：本 Store 只维护幂等记录状态。它**不**决定"接管后能否再次广播"——
 * 那是 Transaction Engine 的职责（过期接管 broadcast 前必须按 expectedHash 查链，
 * 见 m1-storage-model §3.3 与 C 系列任务）。
 */

import type {
  BeginIdempotencyInput,
  BeginIdempotencyResult,
  CompleteIdempotencyInput,
  CompleteIdempotencyResult,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyStore,
  PruneExpiredIdempotencyInput,
} from '@dfr/transaction';
import type { ChainId, Iso8601, TransactionId } from '@dfr/types';
import type { Pool, QueryResultRow } from 'pg';

const SCHEMA = 'transaction_data';
const TABLE = `${SCHEMA}.idempotency_records`;

const SELECT_COLUMNS = `
  project_id, chain_id, key, fingerprint, state, owner_token,
  lease_expires_at, transaction_id, status_code, response_body, expires_at
`;

interface IdempotencyRow extends QueryResultRow {
  project_id: string;
  chain_id: string;
  key: string;
  fingerprint: string;
  state: string;
  owner_token: string;
  lease_expires_at: Date | string;
  transaction_id: string | null;
  status_code: number | null;
  response_body: unknown;
  expires_at: Date | string;
  /** 仅在需要时由 SQL 计算（毫秒，字符串以防精度问题）。 */
  retry_after_ms?: string | null;
}

function toIso(value: Date | string): Iso8601 {
  return (value instanceof Date ? value.toISOString() : value) as Iso8601;
}

function rowToRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    scope: {
      projectId: row.project_id,
      chain: row.chain_id as ChainId,
      key: row.key,
    },
    fingerprint: row.fingerprint,
    state: row.state as IdempotencyRecord['state'],
    ownerToken: row.owner_token,
    leaseExpiresAt: toIso(row.lease_expires_at),
    expiresAt: toIso(row.expires_at),
    ...(row.transaction_id !== null ? { transactionId: row.transaction_id as TransactionId } : {}),
    ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
    ...(row.response_body !== null && row.response_body !== undefined
      ? { responseBody: row.response_body }
      : {}),
  };
}

/** 记录整体 TTL：默认创建后 24h（m1-storage-model §3.3）。 */
const DEFAULT_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

export interface PostgresIdempotencyStoreOptions {
  /** 记录整体保留时长；默认 24h。 */
  readonly recordTtlMs?: number;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly recordTtlMs: number;

  constructor(
    private readonly pool: Pool,
    options: PostgresIdempotencyStoreOptions = {},
  ) {
    this.recordTtlMs = options.recordTtlMs ?? DEFAULT_RECORD_TTL_MS;
    if (!Number.isSafeInteger(this.recordTtlMs) || this.recordTtlMs <= 0) {
      throw new RangeError('recordTtlMs must be a positive safe integer');
    }
  }

  /**
   * TX-05: a committed transaction identity is stronger evidence than a
   * stale in_flight lease. Promote it to a replayable completed record, with
   * a SQL check that the pointed-to transaction belongs to this scope and
   * fingerprint. No second build/nonce allocation may follow this path.
   */
  private async recoverCommitted(
    scope: IdempotencyScope, fingerprint: string,
  ): Promise<BeginIdempotencyResult> {
    const { rows } = await this.pool.query<IdempotencyRow>(
      `UPDATE ${TABLE} idem
          SET state = 'completed', status_code = COALESCE(idem.status_code, 201),
              response_body = COALESCE(
                idem.response_body,
                jsonb_build_object('transactionId', idem.transaction_id)
              ),
              updated_at = clock_timestamp()
        WHERE idem.project_id = $1 AND idem.chain_id = $2 AND idem.key = $3
          AND idem.fingerprint = $4
          AND idem.state = 'in_flight' AND idem.transaction_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${SCHEMA}.transactions t
             WHERE t.id = idem.transaction_id AND t.project_id = idem.project_id
               AND t.chain_id = idem.chain_id AND t.request_fingerprint = idem.fingerprint
               AND t.unsigned_payload IS NOT NULL
          )
        RETURNING ${SELECT_COLUMNS}`,
      [scope.projectId, scope.chain, scope.key, fingerprint],
    );
    if (rows[0] !== undefined) return { kind: 'replayed', record: rowToRecord(rows[0]) };
    const latest = await this.get(scope);
    if (latest?.state === 'completed' && latest.fingerprint === fingerprint &&
        latest.transactionId !== undefined) {
      return { kind: 'replayed', record: latest };
    }
    // Orphan/corrupt binding: failing closed is safer than assigning a second
    // owner and creating another transaction for the same idempotency key.
    throw new Error('begin: committed idempotency transaction binding is inconsistent');
  }

  async begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult> {
    const { scope, fingerprint, ownerToken, leaseTtlMs } = input;
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new RangeError('leaseTtlMs must be a positive safe integer');
    }

    // 第一步：尝试抢占。失败（已存在）不报错，交给下一步判定。
    const inserted = await this.pool.query<IdempotencyRow>(
      `INSERT INTO ${TABLE}
         (project_id, chain_id, key, fingerprint, state, owner_token,
          lease_expires_at, expires_at)
       VALUES ($1, $2, $3, $4, 'in_flight', $5,
               clock_timestamp() + ($6::text || ' milliseconds')::interval,
               clock_timestamp() + ($7::text || ' milliseconds')::interval)
       ON CONFLICT (project_id, chain_id, key) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [scope.projectId, scope.chain, scope.key, fingerprint, ownerToken, leaseTtlMs, this.recordTtlMs],
    );

    if (inserted.rows[0] !== undefined) {
      return { kind: 'acquired', record: rowToRecord(inserted.rows[0]) };
    }

    // 第二步：已有记录，按 fingerprint / state / 租约判定。
    // 用一条语句同时取回记录与剩余租约毫秒数，避免两次往返产生竞态。
    const { rows } = await this.pool.query<IdempotencyRow>(
      `SELECT ${SELECT_COLUMNS},
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000))::bigint::text
                AS retry_after_ms
         FROM ${TABLE}
        WHERE project_id = $1 AND chain_id = $2 AND key = $3`,
      [scope.projectId, scope.chain, scope.key],
    );

    const existing = rows[0];
    if (existing === undefined) {
      // 记录在冲突与读取之间被清理（例如 pruneExpired）；这是合法竞态，
      // 递归一次重新抢占，而不是返回一个语义不明的结果。
      return this.begin(input);
    }

    if (existing.fingerprint !== fingerprint) {
      return { kind: 'conflict', record: rowToRecord(existing) };
    }

    if (existing.state === 'completed') {
      return { kind: 'replayed', record: rowToRecord(existing) };
    }
    if (existing.transaction_id !== null) {
      return this.recoverCommitted(scope, fingerprint);
    }

    // in_flight：判断租约是否已过期。
    const retryAfterMs = Number(existing.retry_after_ms ?? '0');
    if (retryAfterMs > 0) {
      return { kind: 'in_flight', record: rowToRecord(existing), retryAfterMs };
    }

    // 租约已过期 → 尝试接管。条件 UPDATE 保证并发接管只有一个赢家：
    // owner_token 必须是读到的旧值，且租约仍是过期状态（由 DB 时钟判定）。
    const takenOver = await this.pool.query<IdempotencyRow>(
      `UPDATE ${TABLE}
          SET owner_token = $4,
              lease_expires_at = clock_timestamp() + ($5::text || ' milliseconds')::interval,
              updated_at = clock_timestamp()
        WHERE project_id = $1 AND chain_id = $2 AND key = $3
          AND owner_token = $6
          AND state = 'in_flight'
          AND transaction_id IS NULL
          AND lease_expires_at <= clock_timestamp()
        RETURNING ${SELECT_COLUMNS}`,
      [
        scope.projectId,
        scope.chain,
        scope.key,
        ownerToken,
        leaseTtlMs,
        existing.owner_token,
      ],
    );

    if (takenOver.rows[0] !== undefined) {
      return { kind: 'acquired', record: rowToRecord(takenOver.rows[0]) };
    }

    // 被别人抢先接管：重新读取最新状态并回报 in_flight。
    const latest = await this.pool.query<IdempotencyRow>(
      `SELECT ${SELECT_COLUMNS},
              GREATEST(0, CEIL(EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000))::bigint::text
                AS retry_after_ms
         FROM ${TABLE}
        WHERE project_id = $1 AND chain_id = $2 AND key = $3`,
      [scope.projectId, scope.chain, scope.key],
    );

    const current = latest.rows[0];
    if (current === undefined) {
      return this.begin(input);
    }
    if (current.state === 'completed') {
      return { kind: 'replayed', record: rowToRecord(current) };
    }
    if (current.fingerprint !== fingerprint) {
      return { kind: 'conflict', record: rowToRecord(current) };
    }
    if (current.transaction_id !== null) {
      return this.recoverCommitted(scope, fingerprint);
    }
    return {
      kind: 'in_flight',
      record: rowToRecord(current),
      retryAfterMs: Math.max(1, Number(current.retry_after_ms ?? '1')),
    };
  }

  async complete(input: CompleteIdempotencyInput): Promise<CompleteIdempotencyResult> {
    const { scope, ownerToken } = input;

    // 带 owner_token 条件的 UPDATE：失去所有权时影响 0 行，结果必须丢弃。
    const { rows } = await this.pool.query<IdempotencyRow>(
      `UPDATE ${TABLE}
          SET state = 'completed',
              status_code = $4,
              response_body = $5,
              transaction_id = $6,
              updated_at = clock_timestamp()
        WHERE project_id = $1 AND chain_id = $2 AND key = $3
          AND owner_token = $7
          AND state = 'in_flight'
          AND lease_expires_at > clock_timestamp()
        RETURNING ${SELECT_COLUMNS}`,
      [
        scope.projectId,
        scope.chain,
        scope.key,
        input.statusCode,
        input.responseBody ?? null,
        input.transactionId ?? null,
        ownerToken,
      ],
    );

    if (rows[0] !== undefined) {
      return { kind: 'completed', record: rowToRecord(rows[0]) };
    }

    // 影响 0 行：区分"不存在"与"所有权已丢失"。
    const existing = await this.get(scope);
    if (existing === null) return { kind: 'not_found' };
    return { kind: 'lost_ownership' };
  }

  async get(scope: IdempotencyScope): Promise<IdempotencyRecord | null> {
    const { rows } = await this.pool.query<IdempotencyRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
        WHERE project_id = $1 AND chain_id = $2 AND key = $3`,
      [scope.projectId, scope.chain, scope.key],
    );
    return rows[0] === undefined ? null : rowToRecord(rows[0]);
  }

  async pruneExpired(input: PruneExpiredIdempotencyInput): Promise<number> {
    // B51 / TX-05: TTL expiry does NOT prove an in-flight transaction was
    // abandoned. Deleting its idempotency key can re-acquire it and rebuild
    // a second transaction despite an existing durable transaction identity.
    // Only a terminally completed key may be pruned after the retention TTL.
    // Pending keys stay recoverable until a separately audited resolution
    // explicitly completes them (or a governed operational procedure acts).
    const { rowCount } = await this.pool.query(
      `WITH doomed AS (
         SELECT project_id, chain_id, key
           FROM ${TABLE}
          WHERE state = 'completed' AND expires_at <= clock_timestamp()
          ORDER BY expires_at
          LIMIT $1
       )
       DELETE FROM ${TABLE} t
        USING doomed d
        WHERE t.project_id = d.project_id
          AND t.chain_id = d.chain_id
          AND t.key = d.key
          AND t.state = 'completed'`,
      [input.limit],
    );
    return rowCount ?? 0;
  }
}
