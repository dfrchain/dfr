-- DFR M1 交易数据面 schema（migrations/0001）
--
-- 权威来源：docs/architecture/m1-storage-model.md 第 3 节、ADR-015。
--
-- 约束：
--   - 只创建一个 schema `transaction_data`；
--   - 时间判断一律用数据库时钟（clock_timestamp()），避免多进程主机时钟漂移（ADR-015 §7）；
--   - 金额 / nonce 用 numeric(78,0)，禁止 float/double（AGENTS.md 安全红线：不用 JS number 或浮点）；
--   - 禁止出现 private key / mnemonic / API key / credential / signed_payload 列。
--
-- 迁移是**前向执行**的：修复通过新迁移完成，不提供自动 down migration（ADR-015 §3）。

CREATE SCHEMA IF NOT EXISTS transaction_data;

-- ---------------------------------------------------------------------------
-- 1. transactions：交易执行记录（状态快照）
-- ---------------------------------------------------------------------------
-- 注意：这不是链上观测到的 Transaction，而是 DFR 内部的执行记录，
-- 带 request_fingerprint 与 state_version（乐观并发）。
CREATE TABLE transaction_data.transactions (
  id                  text PRIMARY KEY,
  project_id          text NOT NULL DEFAULT 'default',
  chain_id            text NOT NULL,
  request_fingerprint text NOT NULL,
  status              text NOT NULL
    CHECK (status IN ('built','simulated','signed','broadcast','pending','included',
                      'confirmed','finalized','failed','reverted','dropped','replaced','unknown')),
  -- CAS 版本：每次状态迁移 +1，写入时必须匹配旧值（禁止 last-write-wins）。
  state_version       bigint NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  from_address        text NOT NULL,
  to_address          text,
  -- nonce 与金额一律 numeric，避免浮点；精度 78 位覆盖 uint256。
  nonce               numeric(78,0),
  -- 未签名载荷不是 Secret，但禁止写入日志（见 observability spec）。
  unsigned_payload    text,
  payload_encoding    text CHECK (payload_encoding IN ('hex','base64')),
  expected_hash       text,
  tx_hash             text,
  min_finality        text CHECK (min_finality IN ('submitted','included','confirmed','finalized')),
  -- block_ref 是判别联合，写入前由应用层做结构校验后再落 jsonb。
  block_ref           jsonb,
  -- 只存稳定的 DFR 错误码，不存原始错误文本。
  error_code          text,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- payload_encoding 只在有载荷时才有意义。
  CONSTRAINT transactions_payload_encoding_matches_payload
    CHECK (unsigned_payload IS NOT NULL OR payload_encoding IS NULL)
);

-- 链上标识在 chain 内唯一（仅在非空时生效）。
CREATE UNIQUE INDEX transactions_chain_tx_hash_key
  ON transaction_data.transactions (chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE UNIQUE INDEX transactions_chain_expected_hash_key
  ON transaction_data.transactions (chain_id, expected_hash)
  WHERE expected_hash IS NOT NULL;

-- 启动恢复扫描：按 status 过滤 + 按 id 键集分页（每批 ≤ 500，禁止无界扫描）。
CREATE INDEX transactions_status_id_idx
  ON transaction_data.transactions (status, id);

-- ---------------------------------------------------------------------------
-- 2. transaction_transitions：状态迁移审计（与快照同事务写入）
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.transaction_transitions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id text NOT NULL
    REFERENCES transaction_data.transactions (id) ON DELETE RESTRICT,
  -- 建单时没有来源状态，故 from_status 可空。
  from_status    text,
  to_status      text NOT NULL,
  -- 稳定原因码（例如 'simulate.succeeded'），不存敏感原文。
  reason         text NOT NULL,
  request_id     text,
  -- 白名单元数据；禁止写入 payload。
  metadata       jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX transaction_transitions_transaction_id_idx
  ON transaction_data.transaction_transitions (transaction_id, id);

-- ---------------------------------------------------------------------------
-- 3. idempotency_records：写端点幂等
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.idempotency_records (
  project_id       text NOT NULL,
  chain_id         text NOT NULL,
  key              text NOT NULL,
  -- 规范化请求体的 SHA-256。
  fingerprint      text NOT NULL,
  state            text NOT NULL CHECK (state IN ('in_flight','completed')),
  -- 当前执行者随机 token；接管必须换 token，防止旧执行者回写。
  owner_token      text NOT NULL,
  -- 由数据库时钟判断是否过期（ADR-015 §7）。
  lease_expires_at timestamptz NOT NULL,
  transaction_id   text REFERENCES transaction_data.transactions (id) ON DELETE RESTRICT,
  status_code      integer,
  response_body    jsonb,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- 同一 scope 只能有一行：同键不同指纹永久冲突，原记录不得被覆盖。
  CONSTRAINT idempotency_records_scope_key PRIMARY KEY (project_id, chain_id, key)
);

-- 分批清理过期记录（24h 后）。
CREATE INDEX idempotency_records_expires_at_idx
  ON transaction_data.idempotency_records (expires_at);

-- 过期 in-flight 记录需要被恢复扫描发现。
CREATE INDEX idempotency_records_in_flight_lease_idx
  ON transaction_data.idempotency_records (lease_expires_at)
  WHERE state = 'in_flight';

-- ---------------------------------------------------------------------------
-- 4. nonce_accounts：账户级 nonce 水位
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.nonce_accounts (
  chain_id        text NOT NULL,
  account_address text NOT NULL,
  -- 本地已知的下一可用 nonce。
  next_nonce      numeric(78,0) NOT NULL DEFAULT 0 CHECK (next_nonce >= 0),
  version         bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- 账户行是 nonce 分配的串行化点：先 INSERT ON CONFLICT DO NOTHING，再 FOR UPDATE。
  CONSTRAINT nonce_accounts_chain_account_key PRIMARY KEY (chain_id, account_address)
);

-- ---------------------------------------------------------------------------
-- 5. nonce_leases：nonce 租约
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.nonce_leases (
  chain_id        text NOT NULL,
  account_address text NOT NULL,
  nonce           numeric(78,0) NOT NULL CHECK (nonce >= 0),
  transaction_id  text NOT NULL
    REFERENCES transaction_data.transactions (id) ON DELETE RESTRICT,
  status          text NOT NULL
    CHECK (status IN ('reserved','broadcast','consumed','released','expired')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT nonce_leases_chain_account_nonce_key
    UNIQUE (chain_id, account_address, nonce)
);

-- 过期 reserved 租约的回收扫描。
CREATE INDEX nonce_leases_expires_at_idx
  ON transaction_data.nonce_leases (expires_at)
  WHERE status = 'reserved';

CREATE INDEX nonce_leases_transaction_id_idx
  ON transaction_data.nonce_leases (transaction_id);

-- ---------------------------------------------------------------------------
-- 6. tracker_leases：确认跟踪 single-flight 租约
-- ---------------------------------------------------------------------------
CREATE TABLE transaction_data.tracker_leases (
  chain_id         text NOT NULL,
  tx_hash          text NOT NULL,
  -- 续租与状态写入都必须验证 owner token；丢失所有权即停止。
  owner_token      text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT tracker_leases_chain_tx_hash_key PRIMARY KEY (chain_id, tx_hash)
);

-- 过期租约接管扫描。
CREATE INDEX tracker_leases_lease_expires_at_idx
  ON transaction_data.tracker_leases (lease_expires_at);

-- ---------------------------------------------------------------------------
-- 7. 运行时身份权限（migration 身份与 runtime 身份分离）
-- ---------------------------------------------------------------------------
-- 迁移身份拥有 schema 与 DDL；运行时身份只拿 DML，不能改 schema。
-- 角色由基础设施初始化创建；若角色不存在（例如单元测试用的临时库），
-- 则跳过授权而不是让迁移失败。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dfr_runtime') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA transaction_data TO dfr_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA transaction_data TO dfr_runtime';
    -- 身份列（GENERATED ALWAYS AS IDENTITY）需要序列权限才能 INSERT。
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA transaction_data TO dfr_runtime';
    -- 之后由本 schema 迁移新建的表也自动授予同样权限。
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA transaction_data '
         || 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dfr_runtime';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA transaction_data '
         || 'GRANT USAGE, SELECT ON SEQUENCES TO dfr_runtime';
  END IF;
END
$$;
