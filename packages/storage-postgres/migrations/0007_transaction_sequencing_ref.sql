-- DFR M3-B03: transaction records carry a chain-agnostic ordering prerequisite (ADR-033, option A)
--
-- Background: `transactions.nonce` can only express EVM sequence semantics; Solana's ordering prerequisite is a recent
-- blockhash (ADR-032). Stuffing a blockhash into the numeric(78,0) nonce column violates the ADR-032 red line,
-- so a new chain-agnostic discriminated-union reference column is added.
--
-- Why jsonb instead of adding columns: the ordering prerequisite's shape varies by chain (a nonce is a scalar; a blockhash carries
-- lastValidBlockHeight). The discriminated union's legal shapes are pinned by a CHECK constraint, avoiding schema-less blobs.
--
-- Forward migration: only ADD COLUMN, nullable, no change to historical rows; the `nonce` column stays (existing EVM code and indexes are untouched).
-- For EVM records, the application layer requires sequencing_ref->>'value' = nonce (write-path validation, see
-- assertSequencingRefMatchesNonce in transaction-store.ts).

ALTER TABLE transaction_data.transactions
  ADD COLUMN IF NOT EXISTS sequencing_ref jsonb;

-- Shape constraints (historical NULL rows are unaffected):
--   nonce     → { kind:"nonce", value:"<decimal>" }, and must not carry lastValidBlockHeight
--   blockhash → { kind:"blockhash", value:"<base58>", lastValidBlockHeight:"<decimal>" }
ALTER TABLE transaction_data.transactions
  ADD CONSTRAINT transactions_sequencing_ref_shape
  CHECK (
    sequencing_ref IS NULL
    OR COALESCE(
      jsonb_typeof(sequencing_ref) = 'object'
      -- value must be a string (a missing key / non-string fails; it cannot pass via NULL).
      AND COALESCE(jsonb_typeof(sequencing_ref->'value') = 'string', false)
      AND COALESCE(
        -- Use jsonb_exists() instead of `?`: the latter's precedence with NOT is error-prone.
        (sequencing_ref->>'kind' = 'nonce'
          AND NOT jsonb_exists(sequencing_ref, 'lastValidBlockHeight'))
        OR (
          sequencing_ref->>'kind' = 'blockhash'
          AND COALESCE(jsonb_typeof(sequencing_ref->'lastValidBlockHeight') = 'string', false)
        ),
        false
      ),
      false
    )
  );
