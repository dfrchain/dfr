/**
 * PostgresTrackerLeaseStore (DFR-M1-A12).
 *
 * All lease-validity checks use clock_timestamp() inside SQL. Takeover, renewal, and release all use a single
 * write statement with owner/expiry conditions, so a stale worker cannot regain ownership in the read-write window.
 */
import type {
  AcquireTrackerLeaseInput,
  AcquireTrackerLeaseResult,
  ListRecoverableTrackerLeasesInput,
  ReleaseTrackerLeaseInput,
  ReleaseTrackerLeaseResult,
  RenewTrackerLeaseInput,
  RenewTrackerLeaseResult,
  TrackerLease,
  TrackerLeaseStore,
} from '@dfr/transaction';
import type { ChainId, Iso8601 } from '@dfr/types';
import type { Pool, QueryResultRow } from 'pg';

const TABLE = 'transaction_data.tracker_leases';
const MAX_RECOVERY_BATCH = 500;
const SELECT_COLUMNS = `
  chain_id, tx_hash, owner_token, lease_expires_at, heartbeat_at
`;

interface TrackerLeaseRow extends QueryResultRow {
  chain_id: string;
  tx_hash: string;
  owner_token: string;
  lease_expires_at: Date | string;
  heartbeat_at: Date | string;
  active?: boolean;
}

function toIso(value: Date | string): Iso8601 {
  return (value instanceof Date ? value.toISOString() : value) as Iso8601;
}

function rowToLease(row: TrackerLeaseRow): TrackerLease {
  return {
    chain: row.chain_id as ChainId,
    txHash: row.tx_hash,
    ownerToken: row.owner_token,
    leaseExpiresAt: toIso(row.lease_expires_at),
    heartbeatAt: toIso(row.heartbeat_at),
  };
}

export class PostgresTrackerLeaseStore implements TrackerLeaseStore {
  constructor(private readonly pool: Pool) {}

  async acquire(input: AcquireTrackerLeaseInput): Promise<AcquireTrackerLeaseResult> {
    const inserted = await this.pool.query<TrackerLeaseRow>(
      `INSERT INTO ${TABLE}
         (chain_id, tx_hash, owner_token, lease_expires_at, heartbeat_at)
       VALUES ($1, $2, $3,
               clock_timestamp() + ($4::text || ' milliseconds')::interval,
               clock_timestamp())
       ON CONFLICT (chain_id, tx_hash) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [input.chain, input.txHash, input.ownerToken, input.leaseTtlMs],
    );
    if (inserted.rows[0] !== undefined) {
      return { kind: 'acquired', lease: rowToLease(inserted.rows[0]) };
    }

    const existing = await this.getWithActive(input.chain, input.txHash);
    if (existing === undefined) {
      // Concurrent with a release, the row is gone; retry the INSERT claim.
      return this.acquire(input);
    }
    if (existing.active === true) {
      return existing.owner_token === input.ownerToken
        ? { kind: 'acquired', lease: rowToLease(existing) }
        : { kind: 'held_by_other', lease: rowToLease(existing) };
    }

    // Expired: takeover is only allowed while it still matches the owner just read and is still expired.
    const takeover = await this.pool.query<TrackerLeaseRow>(
      `UPDATE ${TABLE}
          SET owner_token = $3,
              lease_expires_at = clock_timestamp() + ($4::text || ' milliseconds')::interval,
              heartbeat_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE chain_id = $1 AND tx_hash = $2
          AND owner_token = $5
          AND lease_expires_at <= clock_timestamp()
        RETURNING ${SELECT_COLUMNS}`,
      [input.chain, input.txHash, input.ownerToken, input.leaseTtlMs, existing.owner_token],
    );
    if (takeover.rows[0] !== undefined) {
      return { kind: 'acquired', lease: rowToLease(takeover.rows[0]) };
    }

    // Another owner took over first, or the row was released; read the latest facts and return them without overwriting the winner.
    const current = await this.getWithActive(input.chain, input.txHash);
    if (current === undefined) return this.acquire(input);
    return current.owner_token === input.ownerToken
      ? { kind: 'acquired', lease: rowToLease(current) }
      : { kind: 'held_by_other', lease: rowToLease(current) };
  }

  async renew(input: RenewTrackerLeaseInput): Promise<RenewTrackerLeaseResult> {
    const { rows } = await this.pool.query<TrackerLeaseRow>(
      `UPDATE ${TABLE}
          SET lease_expires_at = clock_timestamp() + ($4::text || ' milliseconds')::interval,
              heartbeat_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE chain_id = $1 AND tx_hash = $2 AND owner_token = $3
          AND lease_expires_at > clock_timestamp()
        RETURNING ${SELECT_COLUMNS}`,
      [input.chain, input.txHash, input.ownerToken, input.leaseTtlMs],
    );
    return rows[0] === undefined
      ? { kind: 'lost' }
      : { kind: 'renewed', lease: rowToLease(rows[0]) };
  }

  async release(input: ReleaseTrackerLeaseInput): Promise<ReleaseTrackerLeaseResult> {
    const result = await this.pool.query(
      `DELETE FROM ${TABLE}
        WHERE chain_id = $1 AND tx_hash = $2 AND owner_token = $3
          AND lease_expires_at > clock_timestamp()`,
      [input.chain, input.txHash, input.ownerToken],
    );
    return result.rowCount === 1 ? { kind: 'released' } : { kind: 'lost' };
  }

  async listRecoverable(
    input: ListRecoverableTrackerLeasesInput,
  ): Promise<readonly TrackerLease[]> {
    if (!Number.isFinite(input.limit) || input.limit <= 0) return [];
    const limit = Math.min(MAX_RECOVERY_BATCH, Math.trunc(input.limit));
    const { rows } = await this.pool.query<TrackerLeaseRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM ${TABLE}
        WHERE chain_id = $1
          AND lease_expires_at <= clock_timestamp()
          AND ($3::text IS NULL OR tx_hash > $3)
        ORDER BY tx_hash
        LIMIT $2`,
      [input.chain, limit, input.afterTxHash ?? null],
    );
    return rows.map(rowToLease);
  }

  private async getWithActive(
    chain: ChainId,
    txHash: string,
  ): Promise<TrackerLeaseRow | undefined> {
    const { rows } = await this.pool.query<TrackerLeaseRow>(
      `SELECT ${SELECT_COLUMNS}, lease_expires_at > clock_timestamp() AS active
         FROM ${TABLE}
        WHERE chain_id = $1 AND tx_hash = $2`,
      [chain, txHash],
    );
    return rows[0];
  }
}
