-- E5: cross-instance atomic counting of the Provider daily quota.
--
-- Why an in-process Map alone is not enough: restarts reset it to zero, and multiple instances counting separately would underestimate usage,
-- so the upstream quota would be blown; this kind of bug is invisible in single-instance tests.
--
-- The counting table lives in the transaction data plane: it serves runtime Provider calls, not the tenant control plane;
-- it needs no extra infrastructure and reuses the same PostgreSQL connection pool.

CREATE TABLE transaction_data.provider_quota_daily (
  provider_id  text NOT NULL,
  chain_id     text NOT NULL,
  day          date NOT NULL,
  used         integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (provider_id, chain_id, day)
);

-- Operations queries aggregate by chain/date; the primary key already covers exact single-Provider lookups.
CREATE INDEX provider_quota_daily_chain_day_idx
  ON transaction_data.provider_quota_daily (chain_id, day);
