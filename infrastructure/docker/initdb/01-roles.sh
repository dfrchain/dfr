#!/usr/bin/env bash
# 创建 M1 的两个业务角色（migration / runtime 分离）。
#
# 由 PostgreSQL 官方镜像在**首次初始化数据卷**时执行一次；
# 口令只在容器环境变量中，不写入本文件、compose 或镜像。
#
# 注意：psql 的 :'var' / :"var" 只识别**psql 变量**，不读取 shell 环境变量。
# 因此所有需要插值的值都必须用 --set 显式传入，否则会报
# `syntax error at or near ":"`（曾在此处踩到）。
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --set=dbname="${POSTGRES_DB}" \
  --set=migrator_password="${DFR_MIGRATOR_PASSWORD}" \
  --set=runtime_password="${DFR_RUNTIME_PASSWORD}" <<'SQL'
-- 迁移身份：可建 schema、可 DDL，不用于运行时查询。
CREATE ROLE dfr_migrator LOGIN PASSWORD :'migrator_password';

-- 运行时身份：只有 DML，不能改 schema、不能建表。
CREATE ROLE dfr_runtime LOGIN PASSWORD :'runtime_password';

GRANT CONNECT ON DATABASE :"dbname" TO dfr_migrator, dfr_runtime;

-- public schema 不允许任意角色建表；迁移身份改为在库级拥有 CREATE 权限，
-- 用于创建 transaction_data schema（见 migrations/0001）。
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CREATE ON DATABASE :"dbname" TO dfr_migrator;

-- 迁移运行器需要独立数据库来做"从零应用真实迁移"的端到端验证：
-- 若与 schema 契约测试共用同一个库，两者会互相 DROP SCHEMA 而互相干扰。
CREATE DATABASE dfr_m1_runner_test OWNER dfr_migrator;

-- 让迁移身份可以自建一次性测试库：后续 Store 实现测试（A09–A12）各自
-- 使用独立数据库，避免同一库上互相 TRUNCATE / DROP 造成跨文件竞争。
ALTER ROLE dfr_migrator CREATEDB;
SQL
