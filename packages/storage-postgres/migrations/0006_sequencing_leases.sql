-- DFR M3-A01: sequencing leases (SequencingStore, ADR-032 option A)
--
-- Why a separate table instead of reusing nonce_leases: EVM nonces and Solana blockhashes have different semantics
-- (a per-account incrementing sequence vs a chain-wide time-limited reference, which many transactions can share and which expires by block height).
-- Stuffing a blockhash into the nonce numeric column would give one column incompatible meanings on two chains.
--
-- What it shares with nonce_leases: both use (chain_id, account_address) as the **serialization point**,
-- because they solve the same problem — builds for the same account must produce a stable unsigned payload.
--
-- Store the token's **value**, not arbitrary JSON: `token_kind` discriminates the shape, `token_value` stores
-- the blockhash/nonce, and `last_valid_block_height` is only meaningful for blockhash (nullable).
-- This keeps "the Store does not interpret tokens" (it only stores, never judges) while avoiding schema-less JSON blobs.

CREATE TABLE transaction_data.sequencing_leases (
  chain_id                text NOT NULL,
  account_address         text NOT NULL,
  -- Discriminated-union tag: currently only blockhash (nonces still use nonce_leases).
  token_kind              text NOT NULL CHECK (token_kind IN ('blockhash')),
  token_value             text NOT NULL,
  -- Solana-specific: expiry is judged by **block height**, not time (ADR-032). The nonce branch is NULL.
  last_valid_block_height numeric(78,0) CHECK (last_valid_block_height >= 0),
  transaction_id          text NOT NULL,
  status                  text NOT NULL
    CHECK (status IN ('reserved','consumed','released','expired')),
  expires_at              timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- At most one sequencing lease per transaction. **This column is the lease's identity** (ADR-032): one blockhash can be
  -- shared by many transactions, so uniqueness on (chain_id, account_address, token_value) would be wrong; only transaction_id
  -- is unique. It is also the idempotency anchor for build replays (concurrent reserve calls with the same transactionId).
  CONSTRAINT sequencing_leases_transaction_id_key UNIQUE (transaction_id)
);

-- Serialization-point query for reserve + recovery scan: find active leases by account.
CREATE INDEX sequencing_leases_account_idx
  ON transaction_data.sequencing_leases (chain_id, account_address, status);

-- Expiry reclamation scans bounded by TTL (only hits reserved).
CREATE INDEX sequencing_leases_expires_at_idx
  ON transaction_data.sequencing_leases (expires_at)
  WHERE status = 'reserved';
