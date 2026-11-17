/**
 * PostgresProviderQuotaStore（E5）。
 *
 * 语义：用**单条 UPSERT**原子地判断并消耗 Provider 日配额。
 * 并发连接不能看到彼此未提交的 used，但 PostgreSQL 会在冲突行的
 * UPDATE 上加锁；后到事务重新读取最新值后再判断 WHERE used < limit，
 * 因此达到 limit 后不会再有 allowed 结果。
 *
 * 所有日期由调用方按 UTC 计算；SQL 只存 date，不做本地时区推断。
 */
import type {
  ProviderQuotaConsumeInput,
  ProviderQuotaConsumeResult,
  ProviderQuotaStore,
  ProviderQuotaUsageInput,
} from '@dfr/types';
import type { Pool, QueryResultRow } from 'pg';

const TABLE = 'transaction_data.provider_quota_daily';

interface QuotaRow extends QueryResultRow {
  used: number;
}

export class PostgresProviderQuotaStore implements ProviderQuotaStore {
  constructor(private readonly pool: Pool) {}

  async consume(input: ProviderQuotaConsumeInput): Promise<ProviderQuotaConsumeResult> {
    const upsert = await this.pool.query<QuotaRow>(
      `INSERT INTO ${TABLE} (provider_id, chain_id, day, used)
       VALUES ($1, $2, $3::date, 1)
       ON CONFLICT (provider_id, chain_id, day)
       DO UPDATE SET used = ${TABLE}.used + 1,
                     updated_at = clock_timestamp()
         WHERE ${TABLE}.used < $4
       RETURNING used`,
      [input.providerId, input.chain, input.day, input.limit],
    );

    if (upsert.rows[0] !== undefined) {
      return { allowed: true, used: upsert.rows[0].used };
    }

    // WHERE 未命中表示已有行的 used 已达到 limit。此时必须返回真实用量；
    // 不在这里重试插入，避免把“已耗尽”误判成暂时冲突。
    return { allowed: false, used: await this.usage(input) };
  }

  async usage(input: ProviderQuotaUsageInput): Promise<number> {
    const result = await this.pool.query<QuotaRow>(
      `SELECT used FROM ${TABLE}
        WHERE provider_id = $1 AND chain_id = $2 AND day = $3::date`,
      [input.providerId, input.chain, input.day],
    );
    return result.rows[0]?.used ?? 0;
  }
}
