/**
 * PostgresProviderQuotaStore (E5).
 *
 * Semantics: judge and consume the Provider daily quota atomically with a **single UPSERT**.
 * Concurrent connections cannot see each other's uncommitted used values, but PostgreSQL locks the conflicting row on
 * UPDATE; the later transaction re-reads the latest value before evaluating WHERE used < limit,
 * so once the limit is reached no further allowed result appears.
 *
 * All dates are computed by the caller in UTC; SQL only stores the date and infers no local timezone.
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

    // A WHERE miss means the existing row's used has reached the limit. The real usage must be returned here;
    // do not retry the insert here, or "exhausted" would be misjudged as a transient conflict.
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
