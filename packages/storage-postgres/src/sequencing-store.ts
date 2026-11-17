/**
 * PostgresSequencingStore（M3-A01，ADR-032 方案 A）。
 *
 * 与 `PostgresNonceStore` 的**刻意差异**：
 *   - token 是判别联合（当前只有 blockhash），Store 只存不判——
 *     过期语义属于链，属于 Adapter（`isSequencingExpired`）；
 *   - 没有"水位"：blockhash 是全链共用的引用，不是需要单调推进的序号；
 *   - 行身份是 **(chain, account, transaction_id)**，不是 token 取值。一个 blockhash
 *     可合法地服务多笔交易，所以"同一 token 只有一行"是错的；
 *   - 正因行一旦建立就永不改绑，"迟到调用者误更新他人租约"（ADR-030 的 ABA）在结构上
 *     不存在，无需 nonce 那套空洞回收。
 *
 * 与 `PostgresNonceStore` 的**相同之处**：
 *   - 以 `(chain_id, account_address)` 作为**串行化点**（同一账户的 build 必须稳定）；
 *   - 非 Capability，也不接触签名材料；`releaseExpiredOrphaned` 有界（LIMIT + SKIP LOCKED）。
 *
 * 不负责：blockhash 是否已过期（Adapter 按链高判定）、Provider 选择、状态机语义。
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

/** 单轮回收上限，与 NonceStore 保持一致（恢复任务不得无界扫描）。 */
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
 * 行 → 领域对象。
 *
 * 迁移的 CHECK 把 `token_kind` 限制为 `blockhash`，因此这里不出现 nonce 分支；
 * 但读取时不静默降级：形状不符（缺高度）即抛错，免得把半张租约当成有效引用。
 */
function rowToLease(row: SequencingLeaseRow): SequencingLease {
  const chain = row.chain_id as ChainId;
  const account: AccountRef = { chain, address: row.account_address };
  if (row.token_kind !== 'blockhash' || row.last_valid_block_height === null) {
    throw new Error('sequencing lease: 期望 blockhash token（含 last_valid_block_height）');
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
    // 保留原始异常。
  }
}

function assertMatchingAccount(input: ReserveSequencingInput): void {
  if (input.account.chain !== input.chain) {
    throw new Error('reserve: account.chain 与 chain 不一致');
  }
}

export class PostgresSequencingStore implements SequencingStore {
  constructor(private readonly pool: Pool) {}

  async reserve(input: ReserveSequencingInput): Promise<ReserveSequencingResult> {
    assertMatchingAccount(input);
    if (input.token.kind !== 'blockhash') {
      // 迁移的 CHECK 也只接受 blockhash；这里在进入事务前 fail-closed，错误更明确。
      throw new Error('SequencingStore 目前只接受 blockhash token（ADR-032）');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 串行化点：同一 (chain, account) 的 reserve 互斥。
      //
      // 为什么用 advisory lock 而不是 `nonce_accounts` 那种"先 upsert 水位行再 FOR UPDATE"：
      // sequencing 没有需要维护的水位——它的串行化只需要"同一账户同一时刻只有一个 reserve"。
      // hashtext 把 (chain, account) 折叠成 32 位 key 对，作用域限定在事务内（xact）。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        input.chain,
        input.account.address,
      ]);

      // 同一 transactionId 已有租约 → 并发/重放：返回原租约（不重复分配）。
      // transaction_id 上有唯一约束，是这里的幂等锚点（ADR-018 对 build 重放的同一要求）。
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
        // 行身份由 transactionId 决定；token 不符说明调用方的引用与租约不自洽，
        // fail-closed（不把消耗标记落到一条它没打算用的租约上）。
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }
      // consumed 是终态：重复调用保持幂等（一次签名/广播事实，不会因重放而变）。
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
        // 引用自相矛盾：不是这条租约的合法持有者。
        await client.query('COMMIT');
        return { kind: 'forbidden', lease: rowToLease(locked), reason: 'not_owner' };
      }
      if (locked.status === 'released') {
        await client.query('COMMIT');
        return { kind: 'released', lease: rowToLease(locked) };
      }
      // 已签名/已广播的引用不得释放：释放会掩盖"这个 blockhash 已被用过"的事实。
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
    // 只回收**租约 TTL 已过**的 `reserved` 行（reserve 之后崩溃、从未标 consumed）。
    // consumed 永不回收：它代表一笔已签名/已广播的交易引用过该 token。
    // 这不是 blockhash 过期回收——那由 Adapter 按链高判定（`isSequencingExpired`）。
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
   * 按 `transactionId`（行身份）取租约并加行锁。
   *
   * 刻意**不**按 `token_value` 查：一个 blockhash 服务多笔交易，按它查会命中多行，
   * 且语义上也不该把"别的交易也在用同一 blockhash"当成冲突。
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
