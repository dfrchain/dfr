/**
 * PostgresNonceStore（DFR-M1-A11）。
 *
 * 并发与安全语义（M1-C00 / ADR-018 起）：
 *   - **reserve 先于交易行创建**：引擎顺序是 reserve → chain.build → create，
 *     因此 `nonce_leases.transaction_id` 不再有外键（迁移 0003），
 *     本 Store 的 reserve 不读取也不加锁 transactions 表；
 *   - nonce_accounts 行（FOR UPDATE）加上 nonce_leases 的两条唯一约束
 *     `(chain_id, account_address, nonce)` 与 `(transaction_id)` 共同构成串行化点：
 *     插入落空后区分 conflict（别的交易占了 nonce）与 reused（同一交易并发重放）；
 *   - 分配值为 max(chain pending nonce, next_nonce)，全部以 numeric/text 处理；
 *   - releaseIfSafe 检查交易快照与租约状态；交易行尚未创建时只允许释放 `reserved`
 *     （该租约未签名、未广播），signed/broadcast 之后一律 fail-closed；
 *   - 已释放的未签名 nonce 可在严格所有权和链上 pending nonce 条件下回收；
 *     调用端必须携带 transactionId，以防旧 Worker 修改重新绑定的租约（ABA）。
 *   - create 侧的"租约 ↔ 记录"一致性校验由 PostgresTransactionStore 负责，
 *     替代原先写在本 Store 里的交易行 chain/from 校验。
 *
 * 本 Store 不接触签名载荷，也不调用 Adapter、Provider 或 Core。
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
  /** 原始水位（未与链上 pending 取 max），ADR-030 用它界定可回收空洞的上界。 */
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
    // 保留原始异常；连接释放时 pg 会清理已失败事务。
  }
}

function assertMatchingAccount(input: ReserveNonceInput): void {
  if (input.account.chain !== input.chain) {
    throw new Error('reserve: account.chain 与 chain 不一致');
  }
}

export class PostgresNonceStore implements NonceStore {
  constructor(private readonly pool: Pool) {}

  async reserve(input: ReserveNonceInput): Promise<ReserveNonceResult> {
    assertMatchingAccount(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // M1-C00（ADR-018）：reserve 发生在 TransactionStore.create **之前**，
      // 因此这里不得要求交易行存在（0003 已移除该外键）。
      // 同一 transactionId 的串行化点改为 nonce_leases.transaction_id 唯一索引
      // （0002），下面的 `FOR UPDATE` 复用查询即基于它；
      // chain/from 与记录的一致性由 create 侧 fail-closed 校验补上（见 ADR-018）。
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
        throw new Error('reserve: nonce account upsert 后读取失败');
      }

      // ADR-030 / TX-05: fill the lowest provably unsigned gap INLINE during
      // reserve, not only after a periodic recovery sweep. A previous worker
      // may have lost its idempotency lease and failed transaction creation;
      // its nonce lease eventually expires without any transaction row. If a
      // new worker builds before the sweep, skipping that gap would strand
      // later higher nonces in a queued mempool. The account row lock above
      // serializes all competing reservations for this account.
      // ADR-030：优先填补**可安全回收**的空洞，避免 build 失败后留下永久空洞。
      //
      // 可回收的三个条件（缺一不可）：
      //   1. `released` OR an expired *reserved* lease (DB-time TTL):
      //      creation of a transaction after lease expiry fails closed in
      //      TransactionStore.create; a signed/broadcast lease is never
      //      eligible because its status is not reserved. Never seize a
      //      still-live lease even if no transaction row exists.
      //   2. **没有交易行**：build 在 create 之前失败才会如此。有交易行的记录即便当前
      //      是 built/simulated，之后仍可能被 simulate→sign→broadcast，绝不能复用；
      //   3. `nonce >= 链上 pending nonce`：链上已用的 nonce 永远不复用（最终权威）。
      // 上界用原始 watermark，因此只回收水位之下的空洞；水位本身保持单调不回退。
      //
      // 这一段的并发安全来自上方 `nonce_accounts ... FOR UPDATE`：同一 (chain, account)
      // 的 reserve 在此串行化，不会有两个调用者抢同一个空洞。
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
            -- ADR-037 对 ADR-030 决策 #2 的**有意修订**：原来的条件是"没有交易行"
            -- （即 build 在 create 之前失败）。现在放宽为"没有交易行 **或** 交易已 abandoned"。
            -- 为什么安全：abandoned 是**终态**且只从 built/simulated 可达，
            -- 但仍必须确认 expected_hash / tx_hash 均为空（抵御异常历史数据或导入错误）；
            -- 只允许此种未签名记录的 nonce 重用。
            -- TX-01：终态 reverted 且从未保存 expected_hash/tx_hash 的模拟失败也可复用。
            -- 已签名、已广播或链上执行回滚的记录仍不可复用。
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
        // 复用该 nonce：把已释放 / 严格过期且无可签名交易的租约行
        // 在同一个事务和 lease 行锁内绑定给新交易（既无暂时释放窗口，
        // 也不依赖定时巡检先运行）。
        // 不改 next_nonce —— 水位是上界，空洞在这里被填平后仍是单调的。
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
         -- 不指定冲突目标：nonce_leases 上有两条唯一约束
         --   (chain_id, account_address, nonce) 与 (transaction_id)，
         -- 二者都必须在并发下被吸收，然后由下面的分支区分 reused / conflict。
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
        // 有两种唯一约束可能让插入落空，必须区分（否则会误报冲突）：
        //   1. (chain_id, account_address, nonce)：别的交易抢走了同一 nonce → conflict；
        //   2. transaction_id（0002）：同一交易已被并发调用抢先落租约 → reused。
        // 第 2 种在 M1-C00 之前不会出现，因为当时交易行锁已把并发重放串行化了；
        // ADR-018 之后该串行化点变成唯一索引，因此这里必须显式处理。
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
          throw new Error('reserve: nonce 唯一冲突后读取不到冲突租约');
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

      // ADR-030：同一 nonce 可能已被回收并绑定到**新**交易；迟到的释放不得影响新租约。
      if (locked.transaction_id !== ref.transactionId) {
        await client.query('COMMIT');
        return { kind: 'forbidden', lease: rowToLease(locked), reason: 'not_owner' };
      }

      if (locked.status === 'released') {
        await client.query('COMMIT');
        return { kind: 'released', lease: rowToLease(locked) };
      }

      if (transactionStatus === undefined) {
        // 交易行从未创建：build 在 create 之前失败（ADR-018 之后这是可发生的）。
        // 此时租约只可能是 reserved —— markBroadcast / advance 都要求交易行存在，
        // 因此它既未签名也未广播，释放不会破坏"已广播 nonce 不可复用"。
        // 不释放则会留下永远无法回收的孤儿租约。
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

      // 即使只推进 lease，也先取 transaction 锁，保持全局锁顺序。
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

      // ADR-030：空洞 nonce 可被回收复用，因此调用方可能持有**旧**租约引用。
      // 提供 transactionId 时必须与当前绑定一致，否则视为 not_found（相当于"这个引用已失效"），
      // 避免迟到 Worker 误更新新租约（ABA）。
      if (locked.transaction_id !== ref.transactionId) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }

      // consumed 是最高事实，迟到的 broadcast 不能把它降级。
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
