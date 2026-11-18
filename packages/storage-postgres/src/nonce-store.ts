/**
 * PostgresNonceStore (DFR-M1-A11).
 *
 * Concurrency and safety semantics (since M1-C00 / ADR-018):
 *   - **reserve runs before the transaction row is created**: the engine order is reserve → chain.build → create,
 *     so `nonce_leases.transaction_id` no longer has a foreign key (migration 0003),
 *     and this Store's reserve neither reads nor locks the transactions table;
 *   - The nonce_accounts row (FOR UPDATE) plus nonce_leases' two unique constraints
 *     `(chain_id, account_address, nonce)` and `(transaction_id)` together form the serialization point:
 *     after a failed insert, distinguish conflict (another transaction took the nonce) from reused (concurrent replay of the same transaction);
 *   - The allocated value is max(chain pending nonce, next_nonce), handled entirely as numeric/text;
 *   - releaseIfSafe checks the transaction snapshot and the lease state; when the transaction row does not exist yet, only `reserved`
 *     may be released (the lease is unsigned and unbroadcast); after signed/broadcast everything fails closed;
 *   - A released unsigned nonce may be reclaimed under strict ownership and on-chain pending-nonce conditions;
 *     the caller must carry the transactionId, so a stale worker cannot modify a rebound lease (ABA).
 *   - The "lease ↔ record" consistency check on the create side is PostgresTransactionStore's job,
 *     replacing the transaction-row chain/from check previously written in this Store.
 *
 * This Store never touches signed payloads and never calls Adapter, Provider, or Core.
 */

import type {
  AdvanceNonceLeaseResult,
  NonceLease,
  NonceLeaseRef,
  NonceStore,
  ReleaseExpiredOrphanedNonceLeasesInput,
  ReleaseNonceLeaseResult,
  ReserveNonceInput,
  ReserveNonceResult,
} from '@dfr/transaction';
import type {
  AccountRef,
  ChainId,
  DecimalUint,
  Iso8601,
  TransactionId,
  TransactionStatus,
} from '@dfr/types';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const SCHEMA = 'transaction_data';
const TRANSACTIONS = `${SCHEMA}.transactions`;
const ACCOUNTS = `${SCHEMA}.nonce_accounts`;
const LEASES = `${SCHEMA}.nonce_leases`;

const LEASE_COLUMNS = `
  chain_id, account_address, nonce::text AS nonce, transaction_id,
  status, expires_at
`;

interface NonceLeaseRow extends QueryResultRow {
  chain_id: string;
  account_address: string;
  nonce: string;
  transaction_id: string;
  status: string;
  expires_at: Date | string;
  /** Present in SELECTs that compare TTL against the authoritative DB clock. */
  unexpired?: boolean;
}

interface TransactionLockRow extends QueryResultRow {
  id: string;
  chain_id: string;
  from_address: string;
  status: string;
  expected_hash: string | null;
  tx_hash: string | null;
}

interface NonceAccountRow extends QueryResultRow {
  next_nonce: string;
  /** Raw watermark (before taking the max with the on-chain pending nonce); ADR-030 uses it to bound reclaimable gaps. */
  watermark: string;
}

function toIso(value: Date | string): Iso8601 {
  return (value instanceof Date ? value.toISOString() : value) as Iso8601;
}

function rowToLease(row: NonceLeaseRow): NonceLease {
  const chain = row.chain_id as ChainId;
  const account: AccountRef = { chain, address: row.account_address };
  return {
    chain,
    account,
    nonce: row.nonce as DecimalUint,
    transactionId: row.transaction_id as TransactionId,
    status: row.status as NonceLease['status'],
    expiresAt: toIso(row.expires_at),
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Keep the original error; pg cleans up the failed transaction when the connection is released.
  }
}

function assertMatchingAccount(input: ReserveNonceInput): void {
  if (input.account.chain !== input.chain) {
    throw new Error('reserve: account.chain does not match chain');
  }
}

export class PostgresNonceStore implements NonceStore {
  constructor(private readonly pool: Pool) {}

  async reserve(input: ReserveNonceInput): Promise<ReserveNonceResult> {
    assertMatchingAccount(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // M1-C00 (ADR-018): reserve happens **before** TransactionStore.create,
      // so the transaction row must not be required to exist here (0003 removed that foreign key).
      // The serialization point for a given transactionId is now the nonce_leases.transaction_id unique index
      // (0002); the `FOR UPDATE` reuse query below is based on it;
      // chain/from consistency with the record is covered by the fail-closed check on the create side (see ADR-018).
      const existing = await client.query<NonceLeaseRow>(
        `SELECT ${LEASE_COLUMNS}, (expires_at > clock_timestamp()) AS unexpired
           FROM ${LEASES}
          WHERE transaction_id = $1
          ORDER BY created_at, nonce
          LIMIT 1
          FOR UPDATE`,
        [input.transactionId],
      );
      if (existing.rows[0] !== undefined) {
        const active = existing.rows[0];
        const lease = rowToLease(active);
        // DB-01: replay is only safe while this *same* caller still owns a
        // live reserved nonce on the same account and chain. Released,
        // expired, changed-chain and chain-consumed leases are not reusable.
        const valid = active.status === 'reserved'
          && active.unexpired === true
          && active.chain_id === input.chain
          && active.account_address === input.account.address
          && BigInt(active.nonce) >= BigInt(input.chainPendingNonce);
        await client.query('COMMIT');
        return valid ? { kind: 'reused', lease } : { kind: 'conflict', lease };
      }

      await client.query(
        `INSERT INTO ${ACCOUNTS}
           (chain_id, account_address, next_nonce)
         VALUES ($1, $2, $3::numeric)
         ON CONFLICT (chain_id, account_address) DO NOTHING`,
        [input.chain, input.account.address, input.chainPendingNonce],
      );

      const account = await client.query<NonceAccountRow>(
        `SELECT next_nonce::text AS watermark,
                GREATEST(next_nonce, $3::numeric)::text AS next_nonce
           FROM ${ACCOUNTS}
          WHERE chain_id = $1 AND account_address = $2
          FOR UPDATE`,
        [input.chain, input.account.address, input.chainPendingNonce],
      );
      const candidate = account.rows[0]?.next_nonce;
      const watermark = account.rows[0]?.watermark;
      if (candidate === undefined || watermark === undefined) {
        throw new Error('reserve: failed to read the nonce account after upsert');
      }

      // ADR-030 / TX-05: fill the lowest provably unsigned gap INLINE during
      // reserve, not only after a periodic recovery sweep. A previous worker
      // may have lost its idempotency lease and failed transaction creation;
      // its nonce lease eventually expires without any transaction row. If a
      // new worker builds before the sweep, skipping that gap would strand
      // later higher nonces in a queued mempool. The account row lock above
      // serializes all competing reservations for this account.
      // ADR-030: prefer filling **safely reclaimable** gaps, so a failed build does not leave a permanent gap.
      //
      // The three conditions for reclaimability (all required):
      //   1. `released` OR an expired *reserved* lease (DB-time TTL):
      //      creation of a transaction after lease expiry fails closed in
      //      TransactionStore.create; a signed/broadcast lease is never
      //      eligible because its status is not reserved. Never seize a
      //      still-live lease even if no transaction row exists.
      //   2. **No transaction row**: only happens when build fails before create. A record with a transaction row, even if currently
      //      built/simulated, may still go through simulate→sign→broadcast later and must never be reused;
      //   3. `nonce >= on-chain pending nonce`: an on-chain-used nonce is never reused (the chain is the final authority).
      // The upper bound uses the raw watermark, so only gaps below the watermark are reclaimed; the watermark itself stays monotonic and never moves back.
      //
      // Concurrency safety here comes from the `nonce_accounts ... FOR UPDATE` above: reserves for the same (chain, account)
      // are serialized here, so two callers cannot race for the same gap.
      const gap = await client.query<NonceLeaseRow>(
        `SELECT ${LEASE_COLUMNS}
           FROM ${LEASES} l
          WHERE l.chain_id = $1
            AND l.account_address = $2
            AND (
              l.status = 'released'
              OR (l.status = 'reserved' AND l.expires_at <= clock_timestamp())
            )
            AND l.nonce < $3::numeric
            AND l.nonce >= $4::numeric
            -- ADR-037's **deliberate revision** of ADR-030 decision #2: the original condition was "no transaction row"
            -- (i.e. build failed before create). It is now relaxed to "no transaction row **or** the transaction is abandoned".
            -- Why it is safe: abandoned is a **terminal state** reachable only from built/simulated,
            -- but expected_hash / tx_hash must still be confirmed empty (guarding against anomalous historical data or import errors);
            -- only this kind of unsigned record's nonce may be reused.
            -- TX-01: a simulation failure in terminal reverted state that never saved expected_hash/tx_hash may also be reused.
            -- Records that are signed, broadcast, or reverted by on-chain execution still may not be reused.
            AND NOT EXISTS (
              SELECT 1 FROM ${TRANSACTIONS} t
               WHERE t.id = l.transaction_id
                 AND NOT (
                   (t.status = 'abandoned' AND t.expected_hash IS NULL AND t.tx_hash IS NULL)
                   OR (t.status = 'reverted' AND t.expected_hash IS NULL AND t.tx_hash IS NULL)
                 )
            )
          ORDER BY l.nonce ASC
          LIMIT 1
          FOR UPDATE`,
        [input.chain, input.account.address, watermark, input.chainPendingNonce],
      );
      const reclaimable = gap.rows[0];
      if (reclaimable !== undefined) {
        // Reuse that nonce: bind the released / strictly-expired lease row with no signable transaction to the new transaction
        // within the same transaction and lease row lock (no temporary release window,
        // and no dependence on a scheduled sweep running first).
        // next_nonce is unchanged — the watermark is an upper bound, and it stays monotonic once the gap is filled here.
        const reclaimed = await client.query<NonceLeaseRow>(
          `UPDATE ${LEASES}
              SET transaction_id = $4,
                  status = 'reserved',
                  expires_at = clock_timestamp() + ($5::text || ' milliseconds')::interval,
                  updated_at = clock_timestamp()
            WHERE chain_id = $1 AND account_address = $2 AND nonce = $3::numeric
            RETURNING ${LEASE_COLUMNS}`,
          [
            input.chain,
            input.account.address,
            reclaimable.nonce,
            input.transactionId,
            input.leaseTtlMs,
          ],
        );
        await client.query('COMMIT');
        return { kind: 'reserved', lease: rowToLease(reclaimed.rows[0]!) };
      }

      const inserted = await client.query<NonceLeaseRow>(
        `INSERT INTO ${LEASES}
           (chain_id, account_address, nonce, transaction_id, status, expires_at)
         VALUES ($1, $2, $3::numeric, $4, 'reserved',
                 clock_timestamp() + ($5::text || ' milliseconds')::interval)
         -- No conflict target is specified: nonce_leases has two unique constraints
         --   (chain_id, account_address, nonce) and (transaction_id),
         -- and both must be absorbed under concurrency, then distinguished as reused / conflict by the branches below.
         ON CONFLICT DO NOTHING
         RETURNING ${LEASE_COLUMNS}`,
        [
          input.chain,
          input.account.address,
          candidate,
          input.transactionId,
          input.leaseTtlMs,
        ],
      );

      const lease = inserted.rows[0];
      if (lease === undefined) {
        // Two unique constraints can make the insert fail, and they must be distinguished (or conflicts would be misreported):
        //   1. (chain_id, account_address, nonce): another transaction took the same nonce → conflict;
        //   2. transaction_id (0002): the same transaction already had a lease placed by a concurrent call → reused.
        // Case 2 could not occur before M1-C00, because the transaction row lock then serialized concurrent replays;
        // after ADR-018 that serialization point became a unique index, so it must be handled explicitly here.
        const conflict = await client.query<NonceLeaseRow>(
          `SELECT ${LEASE_COLUMNS}
             FROM ${LEASES}
            WHERE chain_id = $1 AND account_address = $2 AND nonce = $3::numeric
            FOR UPDATE`,
          [input.chain, input.account.address, candidate],
        );
        const conflictingLease = conflict.rows[0];
        if (conflictingLease !== undefined) {
          await client.query('COMMIT');
          return { kind: 'conflict', lease: rowToLease(conflictingLease) };
        }

        const sameTransaction = await client.query<NonceLeaseRow>(
          `SELECT ${LEASE_COLUMNS}, (expires_at > clock_timestamp()) AS unexpired
             FROM ${LEASES}
            WHERE transaction_id = $1
            FOR UPDATE`,
          [input.transactionId],
        );
        const replayedLease = sameTransaction.rows[0];
        if (replayedLease === undefined) {
          throw new Error('reserve: conflicting lease not found after nonce unique conflict');
        }
        // Unique-index replay must obey the same live-lease rule as the
        // early transactionId lookup. An expired/released conflicting lease
        // must never be handed out as a reusable nonce.
        const sameOwner = replayedLease.status === 'reserved'
          && replayedLease.unexpired === true
          && replayedLease.chain_id === input.chain
          && replayedLease.account_address === input.account.address
          && BigInt(replayedLease.nonce) >= BigInt(input.chainPendingNonce);
        await client.query('COMMIT');
        return sameOwner
          ? { kind: 'reused', lease: rowToLease(replayedLease) }
          : { kind: 'conflict', lease: rowToLease(replayedLease) };
      }

      await client.query(
        `UPDATE ${ACCOUNTS}
            SET next_nonce = $3::numeric + 1,
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE chain_id = $1 AND account_address = $2`,
        [input.chain, input.account.address, candidate],
      );

      await client.query('COMMIT');
      return { kind: 'reserved', lease: rowToLease(lease) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async markBroadcast(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult> {
    return this.advance(ref, 'broadcast');
  }

  async markConsumed(ref: NonceLeaseRef): Promise<AdvanceNonceLeaseResult> {
    return this.advance(ref, 'consumed');
  }

  async releaseIfSafe(ref: NonceLeaseRef): Promise<ReleaseNonceLeaseResult> {
    // B39: a nonce may have been rebound to an unrelated transaction after
    // release or expiry. Mutation based only on (chain, account, nonce)
    // cannot prove ownership and could release a NEW owner's live nonce.
    if (ref.transactionId === undefined || ref.transactionId === '') {
      return { kind: 'not_found' };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const transactionId = await this.findTransactionId(client, ref);
      if (transactionId === null) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      const transaction = await client.query<TransactionLockRow>(
        `SELECT id, chain_id, from_address, status, expected_hash, tx_hash
           FROM ${TRANSACTIONS}
          WHERE id = $1
          FOR UPDATE`,
        [transactionId],
      );
      const transactionStatus = transaction.rows[0]?.status as TransactionStatus | undefined;

      const locked = await this.lockLease(client, ref);
      if (locked === undefined) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      // ADR-030: the same nonce may already have been reclaimed and bound to a **new** transaction; a late release must not affect the new lease.
      if (locked.transaction_id !== ref.transactionId) {
        await client.query('COMMIT');
        return { kind: 'forbidden', lease: rowToLease(locked), reason: 'not_owner' };
      }

      if (locked.status === 'released') {
        await client.query('COMMIT');
        return { kind: 'released', lease: rowToLease(locked) };
      }

      if (transactionStatus === undefined) {
        // The transaction row was never created: build failed before create (possible since ADR-018).
        // At this point the lease can only be reserved — markBroadcast / advance both require the transaction row to exist,
        // so it is neither signed nor broadcast, and releasing it does not break "a broadcast nonce is never reused".
        // Not releasing it would leave an orphaned lease that can never be reclaimed.
        if (locked.status !== 'reserved') {
          await client.query('COMMIT');
          return {
            kind: 'forbidden',
            lease: rowToLease(locked),
            reason: 'signed_or_broadcast',
          };
        }
        const releasedRows = await client.query<NonceLeaseRow>(
          `UPDATE ${LEASES}
              SET status = 'released', updated_at = clock_timestamp()
            WHERE chain_id = $1 AND account_address = $2 AND nonce = $3::numeric
            RETURNING ${LEASE_COLUMNS}`,
          [ref.chain, ref.account.address, ref.nonce],
        );
        await client.query('COMMIT');
        return { kind: 'released', lease: rowToLease(releasedRows.rows[0]!) };
      }

      // TX-01: reverted is eligible only when no signed/broadcast hash ever
      // entered this record. On-chain execution failures remain ineligible.
      const transactionIsUnsigned =
        (transactionStatus === 'built' || transactionStatus === 'simulated' || transactionStatus === 'reverted' || transactionStatus === 'abandoned')
        && transaction.rows[0]?.expected_hash == null
        && transaction.rows[0]?.tx_hash == null;
      if (
        !transactionIsUnsigned ||
        locked.status !== 'reserved'
      ) {
        await client.query('COMMIT');
        return {
          kind: 'forbidden',
          lease: rowToLease(locked),
          reason: 'signed_or_broadcast',
        };
      }

      const { rows } = await client.query<NonceLeaseRow>(
        `UPDATE ${LEASES}
            SET status = 'released', updated_at = clock_timestamp()
          WHERE chain_id = $1 AND account_address = $2 AND nonce = $3::numeric
          RETURNING ${LEASE_COLUMNS}`,
        [ref.chain, ref.account.address, ref.nonce],
      );
      await client.query('COMMIT');
      return { kind: 'released', lease: rowToLease(rows[0]!) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseExpiredOrphaned(input: ReleaseExpiredOrphanedNonceLeasesInput): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new RangeError('limit must be 1..500');
    }
    // TTL recovery is limited to three unequivocally unsigned outcomes:
    // 1. reserve/build crashed before any transaction row was created;
    // 2. simulation failed, leaving terminal reverted with no signed or chain hash;
    // 3. an unsigned transaction won the CAS into terminal abandoned, but
    //    process shutdown prevented its post-CAS releaseIfSafe cleanup.
    // Every other status (including built, simulated, signed and on-chain reverted)
    // is deliberately excluded. Never release a broadcast or consumed lease.
    // SKIP LOCKED keeps concurrent workers bounded and non-blocking.
    const { rowCount } = await this.pool.query(
      `WITH reclaimable AS (
         SELECT l.ctid
           FROM ${LEASES} l
          WHERE l.status = 'reserved'
            AND l.expires_at <= clock_timestamp()
            AND (
              NOT EXISTS (SELECT 1 FROM ${TRANSACTIONS} t WHERE t.id = l.transaction_id)
              OR EXISTS (
                SELECT 1 FROM ${TRANSACTIONS} t
                 WHERE t.id = l.transaction_id
                   AND t.status IN ('reverted', 'abandoned')
                   AND t.expected_hash IS NULL
                   AND t.tx_hash IS NULL
              )
            )
          ORDER BY l.expires_at, l.transaction_id
          LIMIT $1
          FOR UPDATE OF l SKIP LOCKED
       )
       UPDATE ${LEASES} l
          SET status = 'released', updated_at = clock_timestamp()
         FROM reclaimable o
        WHERE l.ctid = o.ctid`,
      [input.limit],
    );
    return rowCount ?? 0;
  }

  private async advance(
    ref: NonceLeaseRef,
    target: 'broadcast' | 'consumed',
  ): Promise<AdvanceNonceLeaseResult> {
    // An ownerless delayed markBroadcast/markConsumed must not poison the
    // lease belonging to a different transaction after a nonce rebind.
    if (ref.transactionId === undefined || ref.transactionId === '') {
      return { kind: 'not_found' };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const transactionId = await this.findTransactionId(client, ref);
      if (transactionId === null) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      // Even when only advancing the lease, take the transaction lock first to keep the global lock order.
      const transaction = await client.query(
        `SELECT id FROM ${TRANSACTIONS} WHERE id = $1 FOR UPDATE`,
        [transactionId],
      );
      if (transaction.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      const locked = await this.lockLease(client, ref);
      if (locked === undefined) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      // ADR-030: gap nonces can be reclaimed and reused, so a caller may hold a **stale** lease reference.
      // When a transactionId is provided it must match the current binding, otherwise it counts as not_found (equivalent to "this reference is stale"),
      // so a late worker cannot mistakenly update the new lease (ABA).
      if (locked.transaction_id !== ref.transactionId) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      // consumed is the highest fact; a late broadcast cannot downgrade it.
      const nextStatus = locked.status === 'consumed' ? 'consumed' : target;
      const { rows } = await client.query<NonceLeaseRow>(
        `UPDATE ${LEASES}
            SET status = $4, updated_at = clock_timestamp()
          WHERE chain_id = $1 AND account_address = $2 AND nonce = $3::numeric
          RETURNING ${LEASE_COLUMNS}`,
        [ref.chain, ref.account.address, ref.nonce, nextStatus],
      );
      await client.query('COMMIT');
      return { kind: 'updated', lease: rowToLease(rows[0]!) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async findTransactionId(
    client: PoolClient,
    ref: NonceLeaseRef,
  ): Promise<TransactionId | null> {
    if (ref.account.chain !== ref.chain) return null;
    const { rows } = await client.query<{ transaction_id: string } & QueryResultRow>(
      `SELECT transaction_id
         FROM ${LEASES}
        WHERE chain_id = $1 AND account_address = $2 AND nonce = $3::numeric`,
      [ref.chain, ref.account.address, ref.nonce],
    );
    return rows[0] === undefined ? null : (rows[0].transaction_id as TransactionId);
  }

  private async lockLease(
    client: PoolClient,
    ref: NonceLeaseRef,
  ): Promise<NonceLeaseRow | undefined> {
    const { rows } = await client.query<NonceLeaseRow>(
      `SELECT ${LEASE_COLUMNS}
         FROM ${LEASES}
        WHERE chain_id = $1 AND account_address = $2 AND nonce = $3::numeric
        FOR UPDATE`,
      [ref.chain, ref.account.address, ref.nonce],
    );
    return rows[0];
  }
}
