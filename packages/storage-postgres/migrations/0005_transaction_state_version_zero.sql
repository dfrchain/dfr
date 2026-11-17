-- DFR-M1-D07：修复 state_version 起始值与数据库约束的冲突。
--
-- state_version 是乐观并发令牌：TradeRecord 首次落库为 0（TransactionEngine.build），
-- 每次 CAS 转移 +1（m1-storage-model §3.1 “CAS 每次 +1”）。但 0001 的
-- CHECK (state_version >= 1) 让真实 PostgreSQL 上 engine.build 必然失败
-- （transactions_state_version_check）。放宽为 >= 0：仍拒绝负值，但允许初始值 0。
ALTER TABLE transaction_data.transactions
  DROP CONSTRAINT transactions_state_version_check;

ALTER TABLE transaction_data.transactions
  ADD CONSTRAINT transactions_state_version_check CHECK (state_version >= 0);
