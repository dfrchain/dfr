/**
 * PostgresSequencingStore (M3-A01, ADR-032 option A).
 *
 * **Deliberate differences** from `PostgresNonceStore`:
 *   - The token is a discriminated union (currently only blockhash); the Store only stores, never judges —
 *     expiry semantics belong to the chain, i.e. the Adapter (`isSequencingExpired`);
 *   - There is no "watermark": a blockhash is a chain-wide shared reference, not a sequence that must advance monotonically;
 *   - Row identity is **(chain, account, transaction_id)**, not the token value. One blockhash
 *     may legitimately serve many transactions, so "one row per token" would be wrong;
 *   - Precisely because a row is never rebound once created, "a late caller mistakenly updating someone else's lease" (the ADR-030 ABA) is structurally
 *     impossible, so the nonce gap-reclamation machinery is unneeded.
 *
 * **Shared points** with `PostgresNonceStore`:
 *   - `(chain_id, account_address)` is the **serialization point** (builds for the same account must be stable);
 *   - It is not a Capability and never touches signing material; `releaseExpiredOrphaned` is bounded (LIMIT + SKIP LOCKED).
 *
 * Not responsible for: whether a blockhash has expired (the Adapter judges by chain height), Provider selection, or state-machine semantics.
 */

import type {
  AdvanceSequencingResult,
  ReleaseExpiredOrphanedSequencingLeasesInput,
  ReleaseSequencingResult,
  ReserveSequencingInput,
  ReserveSequencingResult,
  SequencingLease,
  SequencingLeaseRef,
  SequencingStore,
} from '@dfr/transaction';
import type {
  AccountRef,
  ChainId,
  DecimalUint,
  Iso8601,
  TransactionId,
} from '@dfr/types';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const SCHEMA = 'transaction_data';
const LEASES = `${SCHEMA}.sequencing_leases`;

/** Per-round reclamation cap, matching NonceStore (recovery tasks must never scan unboundedly). */
const MAX_RELEASE_LIMIT = 500;

const LEASE_COLUMNS = `
  chain_id, account_address, token_kind, token_value,
  last_valid_block_height::text AS last_valid_block_height,
  transaction_id, status, expires_at
`;

interface SequencingLeaseRow extends QueryResultRow {
  chain_id: string;
  account_address: string;
  token_kind: string;
  token_value: string;
  last_valid_block_height: string | null;
  transaction_id: string;
  status: string;
  expires_at: Date | string;
}

function toIso(value: Date | string): Iso8601 {
  return (value instanceof Date ? value.toISOString() : value) as Iso8601;
}

/**
 * Row → domain object.
 *
 * The migration's CHECK restricts `token_kind` to `blockhash`, so no nonce branch appears here;
 * but reads never silently degrade: a mismatched shape (missing height) throws, so a half-formed lease is never treated as a valid reference.
 */
function rowToLease(row: SequencingLeaseRow): SequencingLease {
  const chain = row.chain_id as ChainId;
  const account: AccountRef = { chain, address: row.account_address };
  if (row.token_kind !== 'blockhash' || row.last_valid_block_height === null) {
    throw new Error('sequencing lease: expected a blockhash token (with last_valid_block_height)');
  }
  return {
    chain,
    account,
    token: {
      kind: 'blockhash',
      value: row.token_value,
      lastValidBlockHeight: row.last_valid_block_height as DecimalUint,
    },
    transactionId: row.transaction_id as TransactionId,
    status: row.status as SequencingLease['status'],
    expiresAt: toIso(row.expires_at),
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Keep the original error.
  }
}

function assertMatchingAccount(input: ReserveSequencingInput): void {
  if (input.account.chain !== input.chain) {
    throw new Error('reserve: account.chain does not match chain');
  }
}

export class PostgresSequencingStore implements SequencingStore {
  constructor(private readonly pool: Pool) {}

  async reserve(input: ReserveSequencingInput): Promise<ReserveSequencingResult> {
    assertMatchingAccount(input);
    if (input.token.kind !== 'blockhash') {
      // The migration's CHECK also accepts only blockhash; failing closed here before entering the transaction gives a clearer error.
      throw new Error('SequencingStore currently accepts only blockhash tokens (ADR-032)');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Serialization point: reserves for the same (chain, account) are mutually exclusive.
      //
      // Why an advisory lock instead of the `nonce_accounts` pattern of "upsert the watermark row first, then FOR UPDATE":
      // sequencing has no watermark to maintain — its serialization only needs "one reserve per account at a time".
      // hashtext folds (chain, account) into a 32-bit key pair, scoped to the transaction (xact).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        input.chain,
        input.account.address,
      ]);

      // The same transactionId already has a lease → concurrent call / replay: return the original lease (no duplicate allocation).
      // The unique constraint on transaction_id is the idempotency anchor here (the same requirement ADR-018 sets for build replays).
      const existing = await client.query<SequencingLeaseRow & { unexpired: boolean }>(
        `SELECT ${LEASE_COLUMNS}, (expires_at > clock_timestamp()) AS unexpired
           FROM ${LEASES} WHERE transaction_id = $1 FOR UPDATE`,
        [input.transactionId],
      );
      if (existing.rows[0] !== undefined) {
        const prior = existing.rows[0];
        // B40: transaction_id is permanent, NOT proof that the lease remains
        // active. Never hand an expired/released/consumed blockhash back to
        // a repeated builder, or silently accept a different token/chain.
        // DB time is the authority for this lease's reservation TTL;
        // chain height validity remains the Adapter's responsibility.
        const safeReplay = prior.status === 'reserved'
          && prior.unexpired === true
          && prior.chain_id === input.chain
          && prior.account_address === input.account.address
          && prior.token_kind === 'blockhash'
          && prior.token_value === input.token.value
          && prior.last_valid_block_height === input.token.lastValidBlockHeight;
        if (!safeReplay) {
          throw new Error('sequencing lease replay is inactive or token/owner differs');
        }
        await client.query('COMMIT');
        return { kind: 'reused', lease: rowToLease(prior) };
      }

      const inserted = await client.query<SequencingLeaseRow>(
        `INSERT INTO ${LEASES}
           (chain_id, account_address, token_kind, token_value,
            last_valid_block_height, transaction_id, status, expires_at)
         VALUES ($1, $2, $3, $4, $5::numeric, $6, 'reserved',
                 clock_timestamp() + ($7::text || ' milliseconds')::interval)
         RETURNING ${LEASE_COLUMNS}`,
        [
          input.chain,
          input.account.address,
          input.token.kind,
          input.token.value,
          input.token.lastValidBlockHeight,
          input.transactionId,
          input.leaseTtlMs,
        ],
      );
      await client.query('COMMIT');
      return { kind: 'reserved', lease: rowToLease(inserted.rows[0]!) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markConsumed(ref: SequencingLeaseRef): Promise<AdvanceSequencingResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await this.lockLease(client, ref);
      if (locked === undefined) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }
      if (locked.token_value !== ref.tokenValue) {
        // Row identity is decided by transactionId; a mismatched token means the caller's reference is inconsistent with the lease,
        // so fail closed (do not mark consumed on a lease it did not intend to use).
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }
      // consumed is a terminal state: repeated calls stay idempotent (one signing/broadcast fact, unchanged by replays).
      if (locked.status === 'consumed') {
        await client.query('COMMIT');
        return { kind: 'updated', lease: rowToLease(locked) };
      }
      // B40: released/expired are terminal and must never be resurrected by
      // delayed markConsumed. A still-reserved lease may be consumed even if
      // its administrative TTL elapsed before the sweep; token expiration by
      // chain height remains an Adapter responsibility.
      if (locked.status !== 'reserved') {
        await client.query('COMMIT');
        return { kind: 'not_found' };
      }
      const updated = await client.query<SequencingLeaseRow>(
        `UPDATE ${LEASES}
            SET status = 'consumed', updated_at = clock_timestamp()
          WHERE chain_id = $1 AND account_address = $2 AND transaction_id = $3
          RETURNING ${LEASE_COLUMNS}`,
        [ref.chain, ref.account.address, ref.transactionId],
      );
      await client.query('COMMIT');
      return { kind: 'updated', lease: rowToLease(updated.rows[0]!) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseIfSafe(ref: SequencingLeaseRef): Promise<ReleaseSequencingResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await this.lockLease(client, ref);
      if (locked === undefined) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }
      if (locked.token_value !== ref.tokenValue) {
        // The reference contradicts itself: not a legitimate holder of this lease.
        await client.query('COMMIT');
        return { kind: 'forbidden', lease: rowToLease(locked), reason: 'not_owner' };
      }
      if (locked.status === 'released') {
        await client.query('COMMIT');
        return { kind: 'released', lease: rowToLease(locked) };
      }
      // A signed/broadcast reference must not be released: releasing would hide the fact that "this blockhash has been used".
      if (locked.status === 'consumed') {
        await client.query('COMMIT');
        return { kind: 'forbidden', lease: rowToLease(locked), reason: 'already_consumed' };
      }

      const released = await client.query<SequencingLeaseRow>(
        `UPDATE ${LEASES}
            SET status = 'released', updated_at = clock_timestamp()
          WHERE chain_id = $1 AND account_address = $2 AND transaction_id = $3
          RETURNING ${LEASE_COLUMNS}`,
        [ref.chain, ref.account.address, ref.transactionId],
      );
      await client.query('COMMIT');
      return { kind: 'released', lease: rowToLease(released.rows[0]!) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseExpiredOrphaned(
    input: ReleaseExpiredOrphanedSequencingLeasesInput,
  ): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_RELEASE_LIMIT) {
      throw new RangeError(`limit must be 1..${MAX_RELEASE_LIMIT}`);
    }
    // Only reclaim `reserved` rows whose **lease TTL has passed** (crashed after reserve, never marked consumed).
    // consumed is never reclaimed: it records that a signed/broadcast transaction referenced the token.
    // This is not blockhash-expiry reclamation — that is judged by the Adapter by chain height (`isSequencingExpired`).
    const { rowCount } = await this.pool.query(
      `UPDATE ${LEASES}
          SET status = 'expired', updated_at = clock_timestamp()
        WHERE ctid IN (
          SELECT ctid FROM ${LEASES}
           WHERE status = 'reserved' AND expires_at <= clock_timestamp()
           ORDER BY expires_at, transaction_id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )`,
      [input.limit],
    );
    return rowCount ?? 0;
  }

  /**
   * Fetch a lease by `transactionId` (row identity) and lock the row.
   *
   * Deliberately **not** looked up by `token_value`: one blockhash serves many transactions, so that lookup would hit many rows,
   * and semantically "another transaction is also using the same blockhash" must not count as a conflict.
   */
  private async lockLease(
    client: PoolClient,
    ref: SequencingLeaseRef,
  ): Promise<SequencingLeaseRow | undefined> {
    if (ref.account.chain !== ref.chain) return undefined;
    const { rows } = await client.query<SequencingLeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM ${LEASES}
        WHERE chain_id = $1 AND account_address = $2 AND transaction_id = $3
        FOR UPDATE`,
      [ref.chain, ref.account.address, ref.transactionId],
    );
    return rows[0];
  }
}
