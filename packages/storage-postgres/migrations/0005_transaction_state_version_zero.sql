-- DFR-M1-D07: fix the conflict between the state_version starting value and the database constraint.
--
-- state_version is the optimistic-concurrency token: a TradeRecord is first persisted as 0 (TransactionEngine.build),
-- and +1 on every CAS transition (m1-storage-model §3.1 "CAS +1 each time"). But 0001's
-- CHECK (state_version >= 1) made engine.build always fail on real PostgreSQL
-- (transactions_state_version_check). Relax it to >= 0: negative values are still rejected, but the initial value 0 is allowed.
ALTER TABLE transaction_data.transactions
  DROP CONSTRAINT transactions_state_version_check;

ALTER TABLE transaction_data.transactions
  ADD CONSTRAINT transactions_state_version_check CHECK (state_version >= 0);
