-- DFR-M1-C00: nonce lease allocation happens before the transaction record is created (ADR-018).
--
-- Background: TransactionEngine.build runs in the order
--   read pending nonce → NonceStore.reserve → chain.build → TransactionStore.create
-- while 0001 added a foreign key from nonce_leases.transaction_id to transactions(id),
-- which made the transaction row "have to exist already" at reserve time — yet at that point it necessarily does not exist yet.
-- Measured (real PostgreSQL): every build failed at reserve with SQLSTATE 23503
-- / application-level `reserve: transaction … does not exist`.
--
-- Decision (ADR-018 option B): the fact stands that a lease is a "nonce reservation made before the transaction is created",
-- so the transaction row cannot be required to exist first. Remove the foreign key and use three joint constraints instead:
--   1. nonce_leases_transaction_id_key (0002 unique index): at most one lease per transaction;
--   2. PostgresTransactionStore.create: before persisting, verify the existing lease's chain/account match the record;
--      a mismatch fails closed (replacing the two checks previously written in reserve);
--   3. The next_nonce watermark only increases; nonces are never reclaimed for reuse, so orphaned leases cannot produce duplicate nonces.
--
-- ON DELETE RESTRICT lapses along with it: M1 has no path that deletes transaction rows;
-- if deletion is ever added, the constraint or an equivalent cleanup rule must be reintroduced in the same change.
ALTER TABLE transaction_data.nonce_leases
  DROP CONSTRAINT nonce_leases_transaction_id_fkey;
