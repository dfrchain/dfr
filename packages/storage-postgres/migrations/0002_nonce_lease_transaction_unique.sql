-- DFR-M1-A11: one transaction binds at most one nonce lease.
--
-- The Store guarantees concurrent replays create only one lease via the transaction row lock; the database unique index serves as
-- the last line of integrity defense and enforces the 0..1 cardinality in the m1-storage-model relationship diagram.
CREATE UNIQUE INDEX nonce_leases_transaction_id_key
  ON transaction_data.nonce_leases (transaction_id);
