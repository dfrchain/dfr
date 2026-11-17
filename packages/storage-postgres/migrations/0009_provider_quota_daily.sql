-- E5：Provider 日配额的跨实例原子计数。
--
-- 为什么不能只保留进程内 Map：重启会归零，多实例各自计数会低估，
-- 结果是上游额度被打爆；这类错误在单实例测试里看不出来。
--
-- 计数表放在交易数据面：它服务的是运行时 Provider 调用，不是租户控制面；
-- 不依赖额外基础设施，复用同一 PostgreSQL 连接池。

CREATE TABLE transaction_data.provider_quota_daily (
  provider_id  text NOT NULL,
  chain_id     text NOT NULL,
  day          date NOT NULL,
  used         integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

  PRIMARY KEY (provider_id, chain_id, day)
);

-- 运维查询按链/日期聚合；主键已覆盖单 Provider 精确查询。
CREATE INDEX provider_quota_daily_chain_day_idx
  ON transaction_data.provider_quota_daily (chain_id, day);
