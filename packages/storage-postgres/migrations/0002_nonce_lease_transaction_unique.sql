-- DFR-M1-A11：一条交易最多绑定一个 nonce 租约。
--
-- Store 通过 transaction 行锁保证并发重放只创建一条租约；数据库唯一索引作为
-- 最后一道完整性防线，并落实 m1-storage-model 关系图中的 0..1 基数。
CREATE UNIQUE INDEX nonce_leases_transaction_id_key
  ON transaction_data.nonce_leases (transaction_id);
