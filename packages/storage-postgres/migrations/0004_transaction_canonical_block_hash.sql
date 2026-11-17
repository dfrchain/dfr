-- DFR-M1-D04 / ADR-021: retain the observed block hash beside block_ref height.
ALTER TABLE transaction_data.transactions
  ADD COLUMN canonical_block_hash text;
