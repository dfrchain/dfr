/**
 * PostgresTransactionStore（DFR-M1-A09）。
 *
 * 权威来源：docs/architecture/m1-storage-model.md 第 4/5 节、ADR-015 §5。
 *
 * 并发语义（全部落在 SQL 上，不靠应用层假设）：
 *   - `SELECT ... FOR UPDATE` 锁定交易行，使同一条交易的迁移串行；
 *   - `state_version` 作为乐观并发条件，写入时校验旧值（禁止 last-write-wins）；
 *   - 快照 UPDATE 与 transition INSERT 在**同一事务**提交，
 *     因此不会出现"状态已变但审计缺失"或反之；
 *   - 失败路径返回判别联合（not_found / version_conflict / status_conflict），
 *     不让调用方从 `undefined` 猜原因。
 *
 * 锁顺序遵循 m1-storage-model 第 4 节：建单时先锁 idempotency claim（若有），
 * 再锁 nonce account、nonce/排序租约，最后写入 transaction 行；状态迁移仅锁交易行。
 * TX-05 在同一事务内验证幂等执行者的 token/TTL 并绑定其创建的交易 ID。
 *
 * 边界：本文件只做行映射与一条业务事务；**不**校验状态机允许边
 * （那是 `@dfr/transaction` 的 state-machine 职责），也不发布事件。
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
 * M1-C00（ADR-018）：nonce 租约先于交易行创建，0003 因此移除了
 * `nonce_leases.transaction_id` 的外键。这里补上等价的完整性校验：
 *
 * 若该 `transactionId` 已有租约，其 chain/account 必须与记录一致；
 * 否则 fail-closed —— 不允许出现"交易记录指向 A、nonce 租约却属于 B"的静默不一致，
 * 那会让同一 nonce 被两个账户的语义同时引用。
 *
 * 这是**替代**被移除的 reserve 校验，不是放宽：校验点从 reserve 迁移到 create。
 */
/**
 * ADR-033：EVM 记录同时写 `nonce` 与 `sequencing_ref` 两个字段，二者必须自洽。
 * 只对 `kind='nonce'` 的引用校验——Solana 的 blockhash 引用没有对应的 `nonce` 列。
 */
function assertSequencingRefMatchesNonce(record: TransactionRecord): void {
  const ref = record.sequencingRef;
  // NEW-04: never permit a recorded EVM nonce without its matching
  // sequencing token. Otherwise the Store could bypass nonce lease checks.
  if (record.nonce !== undefined && ref?.kind !== 'nonce') {
    throw new Error('create: 交易包含 nonce 时必须提供 sequencing_ref(kind=nonce)');
  }
  if (ref === undefined || ref.kind !== 'nonce') return;
  if (record.nonce === undefined) {
    throw new Error(
      `create: 交易 ${record.transactionId} 的 sequencing_ref 是 nonce，但记录没有 nonce`,
    );
  }
  if (ref.value !== record.nonce) {
    throw new Error(
      `create: 交易 ${record.transactionId} 的 sequencing_ref.value 与 nonce 不一致`,
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
      throw new Error('create: 缺少 nonce 账户租约水位，拒绝写入交易');
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
    throw new Error('create: nonce 租约不存在或已被重新分配，拒绝过期执行者');
  }
  if (lease !== undefined) {
    // A blockhash-only or unsigned record must never quietly adopt a nonce
    // lease that happens to share its transaction ID.
    if (!nonceBuild ||
      lease.chain_id !== record.chain ||
      lease.account_address !== record.from.address ||
      lease.nonce !== record.nonce
    ) {
      throw new Error(`create: 交易 ${record.transactionId} 的 nonce 租约与记录不一致`);
    }
    if (lease.status !== 'reserved' || !lease.unexpired) {
      throw new Error('create: nonce 租约已释放、广播或过期，拒绝创建交易');
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
      throw new Error('create: sequencing/blockhash 租约缺失、已过期或不属于此交易');
    }
    // The blockhash's chain-height expiry is Adapter-owned; this only checks
    // Store-level lease TTL and ownership, never assumes TTL means chain-valid.
  }
}

/**
 * 启动恢复需要扫描的非终态集合（m1-storage-model 第 6 节）。
 *
 * `unknown` 在其中：广播结果不确定的交易必须被重新观察，
 * 而不是被当成终态丢下。
 */
export const RECOVERABLE_STATUSES: readonly TransactionStatus[] = [
  'broadcast',
  'pending',
  'included',
  'confirmed',
  'unknown',
];

/** 白名单：只有这些字段可以随状态迁移一起更新，防止顺手写入任意列。 */
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
  // bigint 由 pg 以字符串返回（避免 JS number 精度丢失），与 DecimalUint 契约一致。
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
 * 行 → 领域记录。
 *
 * 用展开语法而不是给可选字段赋 `undefined`：`exactOptionalPropertyTypes` 下
 * `{ to: undefined }` 与"没有 to 字段"是两种类型，后者才是契约。
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
        throw new Error(`create: 交易 ${record.transactionId} 冲突后读取不到既有记录`);
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
        // 回滚失败不覆盖原始错误。
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
          -- ADR-037 方案 C：自动作废窗口的上界（"早于"）。同样做进查询，保证游标可推进。
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
