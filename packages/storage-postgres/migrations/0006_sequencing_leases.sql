-- DFR M3-A01：排序租约（SequencingStore，ADR-032 方案 A）
--
-- 为什么单独一张表而不是复用 nonce_leases：EVM nonce 与 Solana blockhash 语义不同
-- （账户级递增序号 vs 全链共用的时效引用，后者多笔交易可共用且按区块高度过期）。
-- 把 blockhash 塞进 nonce numeric 字段会让同一列在两条链上有互不相容的含义。
--
-- 与 nonce_leases 的相同之处：都以 (chain_id, account_address) 作为**串行化点**，
-- 因为它解决的是同一个问题——同一账户的 build 必须产出稳定的未签名载荷。
--
-- 存 token 的**取值**而不是任意 JSON：`token_kind` 判别形状，`token_value` 存
-- blockhash/nonce，`last_valid_block_height` 只对 blockhash 有意义（可空）。
-- 这样既保持"Store 不解释 token"（它只存不判），又避免无 schema 的 JSON blob。

CREATE TABLE transaction_data.sequencing_leases (
  chain_id                text NOT NULL,
  account_address         text NOT NULL,
  -- 判别联合的标签：当前只有 blockhash（nonce 仍走 nonce_leases）。
  token_kind              text NOT NULL CHECK (token_kind IN ('blockhash')),
  token_value             text NOT NULL,
  -- Solana 特有：过期判据是**区块高度**，不是时间（ADR-032）。nonce 分支为 NULL。
  last_valid_block_height numeric(78,0) CHECK (last_valid_block_height >= 0),
  transaction_id          text NOT NULL,
  status                  text NOT NULL
    CHECK (status IN ('reserved','consumed','released','expired')),
  expires_at              timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- 同一交易最多一个排序租约。**这一列是租约的身份**（ADR-032）：一个 blockhash 可被
  -- 多笔交易共用，故 (chain_id, account_address, token_value) 唯一是错的；只有 transaction_id
  -- 唯一。它同时是 build 重放（同一 transactionId 并发 reserve）的幂等锚点。
  CONSTRAINT sequencing_leases_transaction_id_key UNIQUE (transaction_id)
);

-- reserve 的串行化点查询 + 恢复扫描：按账户找活跃租约。
CREATE INDEX sequencing_leases_account_idx
  ON transaction_data.sequencing_leases (chain_id, account_address, status);

-- 过期回收按 TTL 有界扫描（只命中 reserved）。
CREATE INDEX sequencing_leases_expires_at_idx
  ON transaction_data.sequencing_leases (expires_at)
  WHERE status = 'reserved';
