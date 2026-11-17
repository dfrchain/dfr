-- DFR-M1-C00：nonce 租约分配先于交易记录创建（ADR-018）。
--
-- 背景：TransactionEngine.build 的顺序是
--   read pending nonce → NonceStore.reserve → chain.build → TransactionStore.create
-- 而 0001 给 nonce_leases.transaction_id 加了指向 transactions(id) 的外键，
-- 使 reserve 时交易行"必须已存在"——但此时它必然还不存在。
-- 实测（真实 PostgreSQL）：每次 build 都在 reserve 处失败，SQLSTATE 23503
-- / 应用层 `reserve: 交易 … 不存在`。
--
-- 决策（ADR-018 方案 B）：租约是"交易创建之前的 nonce 预留"这一事实成立，
-- 因此不能要求交易行先存在。移除该外键，改用三条共同约束：
--   1. nonce_leases_transaction_id_key（0002 唯一索引）：一条交易最多一个租约；
--   2. PostgresTransactionStore.create：落库前校验既有租约的 chain/account 与记录一致，
--      不一致 fail-closed（替代原先写在 reserve 里的那两处校验）；
--   3. next_nonce 水位只增不减，nonce 不回收复用，孤儿租约不会产生重复 nonce。
--
-- ON DELETE RESTRICT 一并失效：M1 没有任何删除交易行的路径；
-- 若未来新增删除能力，必须在同一变更里重新引入该约束或等价的清理规则。
ALTER TABLE transaction_data.nonce_leases
  DROP CONSTRAINT nonce_leases_transaction_id_fkey;
