/**
 * PostgresIdempotencyStore (DFR-M1-A10).
 *
 * Authoritative sources: docs/architecture/m1-storage-model.md section 3.3, ADR-015.
 *
 * Key semantics:
 *   - scope is `(project_id, chain_id, key)`, kept unique by the table's composite primary key;
 *   - `begin` claims with `INSERT ... ON CONFLICT DO NOTHING`, then decides among four outcomes on conflict;
 *   - **A different fingerprint never overwrites the original record** (a permanent conflict, not "last writer wins");
 *   - Leases use `lease_expires_at`; once expired, another owner may take over;
 *     takeovers happen via a conditional UPDATE, so concurrent takeovers still have exactly one winner;
 *   - **All time checks use the database `clock_timestamp()`**, not the process clock
 *     (ADR-015 §7: avoids two owners caused by clock drift across multi-process hosts).
 *
 * Boundary: this Store only maintains idempotency-record state. It does **not** decide "whether a rebroadcast is allowed after a takeover" —
 * that is the Transaction Engine's job (before broadcasting after an expired takeover, it must check the chain by expectedHash;
 * see m1-storage-model §3.3 and the C-series tasks).
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
  /** Computed by SQL only when needed (milliseconds, as a string to avoid precision issues). */
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

/** Whole-record TTL: 24h after creation by default (m1-storage-model §3.3). */
const DEFAULT_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

export interface PostgresIdempotencyStoreOptions {
  /** Whole-record retention period; 24h by default. */
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

    // Step 1: try to claim. Failing (already exists) is not an error; the next step decides.
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

    // Step 2: a record exists; decide by fingerprint / state / lease.
    // Fetch the record and the remaining lease milliseconds in one statement, avoiding a race from two round trips.
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
      // The record was cleaned up between the conflict and the read (e.g. by pruneExpired); this is a legitimate race,
      // so retry the claim once recursively instead of returning a semantically unclear result.
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

    // in_flight: check whether the lease has expired.
    const retryAfterMs = Number(existing.retry_after_ms ?? '0');
    if (retryAfterMs > 0) {
      return { kind: 'in_flight', record: rowToRecord(existing), retryAfterMs };
    }

    // The lease has expired → try a takeover. The conditional UPDATE guarantees exactly one winner among concurrent takeovers:
    // owner_token must be the old value just read, and the lease must still be expired (judged by the DB clock).
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

    // Someone else took over first: re-read the latest state and report in_flight.
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

    // UPDATE with an owner_token condition: when ownership is lost it affects 0 rows, and the result must be discarded.
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

    // 0 rows affected: distinguish "does not exist" from "ownership lost".
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
