-- DFR ADR-037：交易新增终态 `abandoned`（被显式作废的未广播交易）
--
-- 背景：`build` 会立即占用一个链上 nonce；调用方决定不提交时必须能显式作废，
-- 否则 nonce 永久占位、链上形成永久空洞（ADR-037）。
--
-- 为什么需要这条迁移：`0001` 把 `transactions.status` 的可取集合**硬编码**在
-- `transactions_status_check` CHECK 约束里。应用层新增状态而不更新该约束时，
-- 写入会以 `violates check constraint "transactions_status_check"` 失败——
-- 2026-10-07 的真实联调正是这样抓到了它（Abandoned 迁移漏改）。
--
-- 前向迁移：只重建这一条 CHECK，不动数据、不动其它列与索引。
-- 与 `packages/types` 的 `TransactionStatus` 保持一致的唯一事实来源是
-- `docs/architecture/transaction-lifecycle.md` 第 3 章。

ALTER TABLE transaction_data.transactions
  DROP CONSTRAINT IF EXISTS transactions_status_check;

ALTER TABLE transaction_data.transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('built','simulated','signed','broadcast','pending','included',
                    'confirmed','finalized','failed','reverted','dropped','replaced','unknown',
                    -- ADR-037：只从 built/simulated 可达；signed 及以上永不进入。
                    'abandoned'));
