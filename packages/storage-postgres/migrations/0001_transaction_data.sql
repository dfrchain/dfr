-- DFR M1 transaction data-plane schema (migrations/0001)
--
-- Authoritative sources: docs/architecture/m1-storage-model.md section 3, ADR-015.
--
-- Constraints:
--   - Create only one schema, `transaction_data`;
--   - All time checks use the database clock (clock_timestamp()), to avoid clock drift across multi-process hosts (ADR-015 §7);
--   - Amounts / nonces use numeric(78,0); float/double are forbidden (AGENTS.md safety red line: no JS number or floating point);
--   - No private key / mnemonic / API key / credential / signed_payload columns.
--
-- Migrations run **forward only**: fixes are made via new migrations; no automatic down migration is provided (ADR-015 §3).

CREATE SCHEMA IF NOT EXISTS transaction_data;

-- ---------------------------------------------------------------------------
-- 1. transactions: transaction execution records (state snapshots)
-- ---------------------------------------------------------------------------
-- Note: this is not a Transaction observed on-chain, but DFR's internal execution record,
-- carrying request_fingerprint and state_version (optimistic concurrency).
CREATE TABLE transaction_data.transactions (
  id                  text PRIMARY KEY,
  project_id          text NOT NULL DEFAULT 'default',
  chain_id            text NOT NULL,
  request_fingerprint text NOT NULL,
  status              text NOT NULL
    CHECK (status IN ('built','simulated','signed','broadcast','pending','included',
                      'confirmed','finalized','failed','reverted','dropped','replaced','unknown')),
-- CAS version: +1 on every state transition; writes must match the old value (no last-write-wins).
  state_version       bigint NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  from_address        text NOT NULL,
  to_address          text,
-- Nonces and amounts are always numeric, avoiding floats; 78 digits of precision cover uint256.
  nonce               numeric(78,0),
-- Unsigned payloads are not Secrets, but must never be written to logs (see the observability spec).
  unsigned_payload    text,
  payload_encoding    text CHECK (payload_encoding IN ('hex','base64')),
  expected_hash       text,
  tx_hash             text,
  min_finality        text CHECK (min_finality IN ('submitted','included','confirmed','finalized')),
-- block_ref is a discriminated union; the application layer structurally validates it before writing it as jsonb.
  block_ref           jsonb,
-- Store only stable DFR error codes, never raw error text.
  error_code          text,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),

-- payload_encoding is only meaningful when a payload is present.
  CONSTRAINT transactions_payload_encoding_matches_payload
    CHECK (unsigned_payload IS NOT NULL OR payload_encoding IS NULL)
);

-- On-chain identifiers are unique within a chain (only applies when non-null).
CREATE UNIQUE INDEX transactions_chain_tx_hash_key
  ON transaction_data.transactions (chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE UNIQUE INDEX transactions_chain_expected_hash_key
  ON transaction_data.transactions (chain_id, expected_hash)
  WHERE expected_hash IS NOT NULL;

-- Startup recovery scan: filter by status + keyset pagination by id (≤ 500 per batch; unbounded scans are forbidden).
CREATE INDEX transactions_status_id_idx
  ON transaction_data.transactions (status, id);

-- ---------------------------------------------------------------------------
-- 2. transaction_transitions: state-transition audit (written in the same transaction as the snapshot)
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.transaction_transitions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id text NOT NULL
    REFERENCES transaction_data.transactions (id) ON DELETE RESTRICT,
-- There is no source state when a record is created, so from_status is nullable.
  from_status    text,
  to_status      text NOT NULL,
-- Stable reason codes (e.g. 'simulate.succeeded'); no sensitive raw text is stored.
  reason         text NOT NULL,
  request_id     text,
-- Allowlisted metadata; payloads must not be written.
  metadata       jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX transaction_transitions_transaction_id_idx
  ON transaction_data.transaction_transitions (transaction_id, id);

-- ---------------------------------------------------------------------------
-- 3. idempotency_records: write-endpoint idempotency
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.idempotency_records (
  project_id       text NOT NULL,
  chain_id         text NOT NULL,
  key              text NOT NULL,
-- SHA-256 of the normalized request body.
  fingerprint      text NOT NULL,
  state            text NOT NULL CHECK (state IN ('in_flight','completed')),
-- Random token of the current executor; a takeover must change the token so a previous executor cannot write back.
  owner_token      text NOT NULL,
-- Expiry is judged by the database clock (ADR-015 §7).
  lease_expires_at timestamptz NOT NULL,
  transaction_id   text REFERENCES transaction_data.transactions (id) ON DELETE RESTRICT,
  status_code      integer,
  response_body    jsonb,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

-- At most one row per scope: same key with a different fingerprint is a permanent conflict; the original record must never be overwritten.
  CONSTRAINT idempotency_records_scope_key PRIMARY KEY (project_id, chain_id, key)
);

-- Expired records are cleaned up in batches (after 24h).
CREATE INDEX idempotency_records_expires_at_idx
  ON transaction_data.idempotency_records (expires_at);

-- Expired in-flight records must be found by the recovery scan.
CREATE INDEX idempotency_records_in_flight_lease_idx
  ON transaction_data.idempotency_records (lease_expires_at)
  WHERE state = 'in_flight';

-- ---------------------------------------------------------------------------
-- 4. nonce_accounts: per-account nonce watermark
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.nonce_accounts (
  chain_id        text NOT NULL,
  account_address text NOT NULL,
-- The next usable nonce known locally.
  next_nonce      numeric(78,0) NOT NULL DEFAULT 0 CHECK (next_nonce >= 0),
  version         bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

-- The account row is the serialization point for nonce allocation: INSERT ON CONFLICT DO NOTHING first, then FOR UPDATE.
  CONSTRAINT nonce_accounts_chain_account_key PRIMARY KEY (chain_id, account_address)
);

-- ---------------------------------------------------------------------------
-- 5. nonce_leases: nonce leases
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.nonce_leases (
  chain_id        text NOT NULL,
  account_address text NOT NULL,
  nonce           numeric(78,0) NOT NULL CHECK (nonce >= 0),
  transaction_id  text NOT NULL
    REFERENCES transaction_data.transactions (id) ON DELETE RESTRICT,
  status          text NOT NULL
    CHECK (status IN ('reserved','broadcast','consumed','released','expired')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT nonce_leases_chain_account_nonce_key
    UNIQUE (chain_id, account_address, nonce)
);

-- Reclamation scan for expired reserved leases.
CREATE INDEX nonce_leases_expires_at_idx
  ON transaction_data.nonce_leases (expires_at)
  WHERE status = 'reserved';

CREATE INDEX nonce_leases_transaction_id_idx
  ON transaction_data.nonce_leases (transaction_id);

-- ---------------------------------------------------------------------------
-- 6. tracker_leases: confirmation-tracking single-flight leases
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.tracker_leases (
  chain_id         text NOT NULL,
  tx_hash          text NOT NULL,
-- Renewals and status writes must both verify the owner token; losing ownership stops the holder.
  owner_token      text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT tracker_leases_chain_tx_hash_key PRIMARY KEY (chain_id, tx_hash)
);

-- Takeover scan for expired leases.
CREATE INDEX tracker_leases_lease_expires_at_idx
  ON transaction_data.tracker_leases (lease_expires_at);

-- ---------------------------------------------------------------------------
-- 7. Runtime identity permissions (migration identity and runtime identity are separate)
-- ---------------------------------------------------------------------------
-- The migration identity owns the schema and DDL; the runtime identity only gets DML and cannot change the schema.
-- Roles are created by infrastructure setup; if a role does not exist (e.g. a scratch database for unit tests),
-- grants are skipped instead of failing the migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dfr_runtime') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA transaction_data TO dfr_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA transaction_data TO dfr_runtime';
    -- Identity columns (GENERATED ALWAYS AS IDENTITY) need sequence permission for INSERT.
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA transaction_data TO dfr_runtime';
    -- Tables created later by this schema's migrations are automatically granted the same permissions.
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA transaction_data '
         || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dfr_runtime';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA transaction_data '
         || 'GRANT USAGE, SELECT ON SEQUENCES TO dfr_runtime';
  END IF;
END
$$;
