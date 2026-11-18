/**
 * PostgresTransactionStore (DFR-M1-A09).
 *
 * Authoritative sources: docs/architecture/m1-storage-model.md sections 4/5, ADR-015 §5.
 *
 * Concurrency semantics (all pinned in SQL, not resting on application-layer assumptions):
 *   - `SELECT ... FOR UPDATE` locks the transaction row, serializing transitions of the same transaction;
 *   - `state_version` is the optimistic-concurrency condition; writes verify the old value (no last-write-wins);
 *   - The snapshot UPDATE and the transition INSERT commit in the **same transaction**,
 *     so "state changed but audit missing" (or the reverse) can never happen;
 *   - Failure paths return a discriminated union (not_found / version_conflict / status_conflict),
 *     so callers never have to guess the reason from `undefined`.
 *
 * Lock order follows m1-storage-model section 4: when creating a record, lock the idempotency claim first (if any),
 * then the nonce account and the nonce/sequencing leases, and finally write the transaction row; state transitions lock only the transaction row.
 * TX-05 verifies the idempotent executor's token/TTL in the same transaction and binds the transaction ID it created.
 *
 * Boundary: this file only does row mapping and one business transaction; it does **not** validate allowed state-machine edges
 * (that is `@dfr/transaction`'s state-machine job), and it publishes no events.
 */

import type {
  CreateTransactionInput,
  CreateTransactionResult,
  ListRecoverableInput,
  TransactionRecord,
  TransactionStore,
  TransitionPatch,
  TransitionTransactionInput,
  TransitionTransactionResult,
} from '@dfr/transaction';
import type {
  AccountRef,
  BlockRef,
  ChainId,
  DecimalUint,
  DfrErrorCode,
  FinalityLevel,
  Iso8601,
  TransactionId,
  TransactionStatus,
  SequencingToken,
} from '@dfr/types';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const SCHEMA = 'transaction_data';
const TABLE = `${SCHEMA}.transactions`;
const NONCE_LEASES = `${SCHEMA}.nonce_leases`;
const SEQUENCING_LEASES = `${SCHEMA}.sequencing_leases`;
const IDEMPOTENCY_RECORDS = `${SCHEMA}.idempotency_records`;

/**
 * M1-C00 (ADR-018): nonce leases are created before the transaction row, so 0003 removed
 * the `nonce_leases.transaction_id` foreign key. The equivalent integrity check is added here:
 *
 * if that `transactionId` already has a lease, its chain/account must match the record;
 * otherwise fail closed — a silent inconsistency like "the transaction record points at A while the nonce lease belongs to B" is not allowed,
 * since it would let one nonce be referenced under two accounts' semantics at once.
 *
 * This **replaces** the removed reserve check; it is not a relaxation: the check point moved from reserve to create.
 */
/**
 * ADR-033: EVM records write both the `nonce` and `sequencing_ref` fields, and the two must be consistent with each other.
 * Only references with `kind='nonce'` are checked — Solana blockhash references have no corresponding `nonce` column.
 */
function assertSequencingRefMatchesNonce(record: TransactionRecord): void {
  const ref = record.sequencingRef;
  // NEW-04: never permit a recorded EVM nonce without its matching
  // sequencing token. Otherwise the Store could bypass nonce lease checks.
  if (record.nonce !== undefined && ref?.kind !== 'nonce') {
    throw new Error('create: a transaction containing a nonce must provide sequencing_ref(kind=nonce)');
  }
  if (ref === undefined || ref.kind !== 'nonce') return;
  if (record.nonce === undefined) {
    throw new Error(
      `create: transaction ${record.transactionId} has a sequencing_ref of kind nonce but the record has no nonce`,
    );
  }
  if (ref.value !== record.nonce) {
    throw new Error(
      `create: transaction ${record.transactionId} has a sequencing_ref.value inconsistent with its nonce`,
    );
  }
}

async function assertLeaseMatchesRecord(
  client: PoolClient,
  record: TransactionRecord,
): Promise<void> {
  // DB-01: lock the nonce account BEFORE the lease, matching the lock order
  // in NonceStore.reserve (account -> lease). All checks below and the
  // transaction INSERT run on this same client/transaction.
  //
  // Legacy records containing neither a nonce nor a sequencing token may
  // remain valid for schema/recovery fixtures. A populated nonce or blockhash
  // must prove its own non-expired lease in the same transaction as INSERT.
  const nonceBuild = record.nonce !== undefined;
  const blockhashBuild = record.sequencingRef?.kind === 'blockhash';
  if (nonceBuild) {
    const account = await client.query(
      `SELECT next_nonce FROM ${SCHEMA}.nonce_accounts
        WHERE chain_id = $1 AND account_address = $2 FOR UPDATE`,
      [record.chain, record.from.address],
    );
    if (account.rowCount !== 1) {
      throw new Error('create: missing nonce account lease watermark; refusing to write the transaction');
    }
  }

  const { rows } = await client.query<{
    chain_id: string;
    account_address: string;
    nonce: string;
    status: string;
    unexpired: boolean;
  }>(
    `SELECT chain_id, account_address, nonce::text AS nonce, status,
            expires_at > clock_timestamp() AS unexpired
       FROM ${NONCE_LEASES}
      WHERE transaction_id = $1 FOR UPDATE`,
    [record.transactionId],
  );
  const lease = rows[0];
  if (lease === undefined && nonceBuild) {
    throw new Error('create: nonce lease does not exist or was reassigned; refusing the expired executor');
  }
  if (lease !== undefined) {
    // A blockhash-only or unsigned record must never quietly adopt a nonce
    // lease that happens to share its transaction ID.
    if (!nonceBuild ||
      lease.chain_id !== record.chain ||
      lease.account_address !== record.from.address ||
      lease.nonce !== record.nonce
    ) {
      throw new Error(`create: transaction ${record.transactionId} has a nonce lease inconsistent with the record`);
    }
    if (lease.status !== 'reserved' || !lease.unexpired) {
      throw new Error('create: nonce lease was released, broadcast, or expired; refusing to create the transaction');
    }
  }

  if (blockhashBuild) {
    // ADR-032: transaction_id is the identity, not the shared blockhash.
    // Row lock serializes create against release/consume on the same token.
    const sequencing = await client.query<{
      chain_id: string;
      account_address: string;
      token_kind: string;
      token_value: string;
      last_valid_block_height: string | null;
      status: string;
      unexpired: boolean;
    }>(
      `SELECT chain_id, account_address, token_kind, token_value,
              last_valid_block_height::text AS last_valid_block_height,
              status, expires_at > clock_timestamp() AS unexpired
         FROM ${SEQUENCING_LEASES}
        WHERE transaction_id = $1 FOR UPDATE`,
      [record.transactionId],
    );
    const held = sequencing.rows[0];
    const ref = record.sequencingRef!;
    if (held === undefined ||
        held.chain_id !== record.chain ||
        held.account_address !== record.from.address ||
        held.token_kind !== 'blockhash' ||
        held.token_value !== ref.value ||
        held.last_valid_block_height !== ref.lastValidBlockHeight ||
        held.status !== 'reserved' ||
        !held.unexpired
    ) {
      throw new Error('create: sequencing/blockhash lease is missing, expired, or does not belong to this transaction');
    }
    // The blockhash's chain-height expiry is Adapter-owned; this only checks
    // Store-level lease TTL and ownership, never assumes TTL means chain-valid.
  }
}

/**
 * The non-terminal set the startup recovery scan needs (m1-storage-model section 6).
 *
 * `unknown` is included: transactions with an uncertain broadcast outcome must be re-observed,
 * not dropped as if terminal.
 */
export const RECOVERABLE_STATUSES: readonly TransactionStatus[] = [
  'broadcast',
  'pending',
  'included',
  'confirmed',
  'unknown',
];

/** Allowlist: only these fields may be updated along with a state transition, preventing accidental writes to arbitrary columns. */
const PATCH_COLUMNS: ReadonlyArray<readonly [keyof TransitionPatch, string]> = [
  ['txHash', 'tx_hash'],
  ['expectedHash', 'expected_hash'],
  ['canonicalBlockHash', 'canonical_block_hash'],
  ['nonce', 'nonce'],
  ['blockRef', 'block_ref'],
  ['minFinality', 'min_finality'],
  ['errorCode', 'error_code'],
];

const SELECT_COLUMNS = `
  id, project_id, chain_id, request_fingerprint, status, state_version,
  from_address, to_address, nonce, sequencing_ref, unsigned_payload, payload_encoding,
  expected_hash, tx_hash, min_finality, block_ref, canonical_block_hash, error_code,
  created_at, updated_at
`;

interface TransactionRow extends QueryResultRow {
  id: string;
  project_id: string;
  chain_id: string;
  request_fingerprint: string;
  status: string;
  // pg returns bigints as strings (avoiding JS number precision loss), consistent with the DecimalUint contract.
  state_version: string;
  from_address: string;
  to_address: string | null;
  nonce: string | null;
  sequencing_ref: unknown;
  unsigned_payload: string | null;
  payload_encoding: string | null;
  expected_hash: string | null;
  tx_hash: string | null;
  min_finality: string | null;
  block_ref: unknown;
  canonical_block_hash: string | null;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): Iso8601 {
  return (value instanceof Date ? value.toISOString() : value) as Iso8601;
}

/**
 * Row → domain record.
 *
 * Spread syntax is used instead of assigning `undefined` to optional fields: under `exactOptionalPropertyTypes`,
 * `{ to: undefined }` and "no to field" are two different types, and the latter is the contract.
 */
function rowToRecord(row: TransactionRow): TransactionRecord {
  const chainId = row.chain_id as ChainId;
  const fromRef: AccountRef = { chain: chainId, address: row.from_address };

  return {
    transactionId: row.id as TransactionId,
    projectId: row.project_id,
    chain: chainId,
    requestFingerprint: row.request_fingerprint,
    status: row.status as TransactionStatus,
    stateVersion: row.state_version as DecimalUint,
    from: fromRef,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    ...(row.to_address !== null ? { to: { chain: chainId, address: row.to_address } } : {}),
    ...(row.nonce !== null ? { nonce: row.nonce as DecimalUint } : {}),
    ...(row.sequencing_ref !== null && row.sequencing_ref !== undefined
      ? { sequencingRef: row.sequencing_ref as SequencingToken }
      : {}),
    ...(row.unsigned_payload !== null ? { unsignedPayload: row.unsigned_payload } : {}),
    ...(row.payload_encoding !== null
      ? { payloadEncoding: row.payload_encoding as 'hex' | 'base64' }
      : {}),
    ...(row.expected_hash !== null ? { expectedHash: row.expected_hash } : {}),
    ...(row.tx_hash !== null ? { txHash: row.tx_hash } : {}),
    ...(row.min_finality !== null
      ? { minFinality: row.min_finality as FinalityLevel }
      : {}),
    ...(row.block_ref !== null && row.block_ref !== undefined
      ? { blockRef: row.block_ref as BlockRef }
      : {}),
    ...(row.canonical_block_hash !== null
      ? { canonicalBlockHash: row.canonical_block_hash }
      : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code as DfrErrorCode } : {}),
  };
}

export class PostgresTransactionStore implements TransactionStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateTransactionInput): Promise<CreateTransactionResult> {
    const { record } = input;
    assertSequencingRefMatchesNonce(record);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // TX-05 lock order: idempotency scope FIRST, nonce account SECOND,
      // lease THIRD, transaction insertion LAST. An expired owner cannot
      // create a second transaction after a new owner claims the same key.
      const claim = input.idempotencyClaim;
      if (claim !== undefined) {
        if (claim.scope.projectId !== record.projectId || claim.scope.chain !== record.chain) {
          throw new Error('create: idempotency scope does not match transaction');
        }
        const idempotency = await client.query<{
          owner_token: string;
          fingerprint: string;
          state: string;
          transaction_id: string | null;
          unexpired: boolean;
        }>(
          `SELECT owner_token, fingerprint, state, transaction_id,
                  lease_expires_at > clock_timestamp() AS unexpired
             FROM ${IDEMPOTENCY_RECORDS}
            WHERE project_id = $1 AND chain_id = $2 AND key = $3
            FOR UPDATE`,
          [claim.scope.projectId, claim.scope.chain, claim.scope.key],
        );
        const held = idempotency.rows[0];
        if (held === undefined ||
            held.owner_token !== claim.ownerToken ||
            held.fingerprint !== record.requestFingerprint ||
            held.state !== 'in_flight' ||
            held.transaction_id !== null ||
            !held.unexpired
        ) {
          throw new Error('create: idempotency lease lost, expired or already bound');
        }
      }
      // Atomic with INSERT: a lease cannot be released/rebound between the
      // ownership check and creation of the built transaction record.
      await assertLeaseMatchesRecord(client, record);
      const { rows } = await client.query<TransactionRow>(
      `INSERT INTO ${TABLE}
         (id, project_id, chain_id, request_fingerprint, status, state_version,
          from_address, to_address, nonce, sequencing_ref, unsigned_payload, payload_encoding,
          expected_hash, tx_hash, min_finality, block_ref, canonical_block_hash, error_code,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        record.transactionId,
        record.projectId,
        record.chain,
        record.requestFingerprint,
        record.status,
        record.stateVersion,
        record.from.address,
        record.to?.address ?? null,
        record.nonce ?? null,
        record.sequencingRef === undefined ? null : JSON.stringify(record.sequencingRef),
        record.unsignedPayload ?? null,
        record.payloadEncoding ?? null,
        record.expectedHash ?? null,
        record.txHash ?? null,
        record.minFinality ?? null,
        record.blockRef ?? null,
        record.canonicalBlockHash ?? null,
        record.errorCode ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );

      if (rows[0] !== undefined) {
        if (input.idempotencyClaim !== undefined) {
          // Save the immutable transaction identity atomically with INSERT.
          // A restarted caller can replay this committed build even if the
          // original owner crashes before calling IdempotencyStore.complete.
          const { scope, ownerToken } = input.idempotencyClaim;
          const linked = await client.query(
            `UPDATE ${IDEMPOTENCY_RECORDS}
                SET transaction_id = $5, updated_at = clock_timestamp()
              WHERE project_id = $1 AND chain_id = $2 AND key = $3
                AND owner_token = $4 AND state = 'in_flight'
                AND transaction_id IS NULL`,
            [scope.projectId, scope.chain, scope.key, ownerToken, record.transactionId],
          );
          if (linked.rowCount !== 1) {
            throw new Error('create: could not atomically bind idempotency transaction');
          }
        }
        await client.query('COMMIT');
        return { kind: 'created', record: rowToRecord(rows[0]) };
      }

      // The conflict read uses the SAME client; never escape the lock window.
      const existing = await client.query<TransactionRow>(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE id = $1`,
        [record.transactionId],
      );
      if (existing.rows[0] === undefined) {
        throw new Error(`create: existing record for transaction ${record.transactionId} not found after conflict`);
      }
      await client.query('COMMIT');
      return { kind: 'already_exists', record: rowToRecord(existing.rows[0]) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async get(transactionId: TransactionId): Promise<TransactionRecord | null> {
    const { rows } = await this.pool.query<TransactionRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE id = $1`,
      [transactionId],
    );
    return rows[0] === undefined ? null : rowToRecord(rows[0]);
  }

  async getByHash(chain: ChainId, txHash: string): Promise<TransactionRecord | null> {
    const { rows } = await this.pool.query<TransactionRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
        WHERE chain_id = $1 AND (tx_hash = $2 OR expected_hash = $2)
        LIMIT 2`,
      [chain, txHash],
    );
    if (rows.length > 1) throw new Error('getByHash: ambiguous transaction hash');
    return rows[0] === undefined ? null : rowToRecord(rows[0]);
  }

  async transition(input: TransitionTransactionInput): Promise<TransitionTransactionResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<TransactionRow>(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} WHERE id = $1 FOR UPDATE`,
        [input.transactionId],
      );

      if (rows[0] === undefined) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      const current = rowToRecord(rows[0]);

      if (current.stateVersion !== input.expectedVersion) {
        await client.query('ROLLBACK');
        return { kind: 'version_conflict', current };
      }

      if (current.status !== input.expectedStatus) {
        await client.query('ROLLBACK');
        return { kind: 'status_conflict', current };
      }

      const params: unknown[] = [input.transactionId, input.toStatus];
      const assignments = ['status = $2', 'state_version = state_version + 1'];
      assignments.push('updated_at = clock_timestamp()');

      for (const [key, column] of PATCH_COLUMNS) {
        const value = input.patch?.[key];
        if (value === undefined) continue;
        params.push(value);
        assignments.push(`${column} = $${params.length}`);
      }

      const { rows: updated } = await client.query<TransactionRow>(
        `UPDATE ${TABLE} SET ${assignments.join(', ')}
          WHERE id = $1
          RETURNING ${SELECT_COLUMNS}`,
        params,
      );

      await client.query(
        `INSERT INTO ${SCHEMA}.transaction_transitions
           (transaction_id, from_status, to_status, reason, request_id, metadata)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [
          input.transactionId,
          current.status,
          input.toStatus,
          input.reason,
          input.requestId ?? null,
        ],
      );

      await client.query('COMMIT');
      return { kind: 'applied', record: rowToRecord(updated[0]!) };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listRecoverable(input: ListRecoverableInput): Promise<readonly TransactionRecord[]> {
    const statuses = input.statuses ?? RECOVERABLE_STATUSES;
    const { rows } = await this.pool.query<TransactionRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
        WHERE status = ANY($1::text[])
          AND ($2::text IS NULL OR id > $2)
          AND ($4::timestamptz IS NULL OR updated_at >= $4)
          -- ADR-037 option C: the upper bound of the auto-void window ("earlier than"). Also folded into the query so the cursor can advance.
          AND ($5::timestamptz IS NULL OR updated_at <= $5)
        ORDER BY id
        LIMIT $3`,
      [
        statuses,
        input.afterTransactionId ?? null,
        input.limit,
        input.updatedAfter ?? null,
        input.updatedBefore ?? null,
      ],
    );
    return rows.map(rowToRecord);
  }
}
