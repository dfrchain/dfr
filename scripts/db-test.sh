#!/usr/bin/env bash
# DFR M1 数据库门禁（本地 / CI）
#
# 用途：把"必须连真实 PostgreSQL 才能验证"的测试跑起来（迁移、schema、并发、租约）。
# 这些测试**不在**默认 `pnpm verify` 内：默认门禁必须离线可复现。
#
# 行为：
#   1. 读取 infrastructure/docker/.env（不存在则提示复制 .env.example 并退出）；
#   2. 若测试容器未运行则启动并等待健康；
#   3. 用 migration / runtime 两个身份分别导出 DSN（口令不回显）；
#   4. 运行指定测试（默认 packages/storage-postgres/test）；
#   5. 结束时按 DFR_DB_TEST_KEEP 决定是否停容器（默认保留，便于排查）。
#
# 用法：
#   ./scripts/db-test.sh
#   ./scripts/db-test.sh packages/storage-postgres/test/schema.test.ts
#   DFR_DB_TEST_KEEP=0 ./scripts/db-test.sh      # 跑完停容器（保留数据卷）
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
cd "${REPO_ROOT}"

COMPOSE_DIR="infrastructure/docker"
# Override only for an explicitly isolated test compose, never production.
COMPOSE_FILE="${DFR_DB_TEST_COMPOSE_FILE:-docker-compose.test.yml}"
ENV_FILE="${COMPOSE_DIR}/.env"
DB_NAME="dfr_m1_test"
RUNNER_DB_NAME="dfr_m1_runner_test"
DB_PORT="${DFR_DB_TEST_PORT:-55432}"
if [[ ! "${COMPOSE_FILE}" =~ ^docker-compose[.a-zA-Z0-9_-]*\.yml$ ]] || [[ ! "${DB_PORT}" =~ ^[0-9]{4,5}$ ]]; then
  echo "db-test: 非法测试 compose 文件名或测试端口" >&2
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "db-test: 缺少 ${ENV_FILE}" >&2
  echo "db-test: 请先执行  cd ${COMPOSE_DIR} && cp .env.example .env  并填入随机口令" >&2
  exit 1
fi

# 口令只进环境变量，不出现在命令行参数或输出里。
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

for required in DFR_POSTGRES_MIGRATOR_PASSWORD DFR_POSTGRES_RUNTIME_PASSWORD; do
  if [ -z "${!required:-}" ]; then
    echo "db-test: ${ENV_FILE} 缺少 ${required}" >&2
    exit 1
  fi
done

echo "db-test: 启动测试数据库（幂等）..."
docker compose -f "${COMPOSE_DIR}/${COMPOSE_FILE}" up -d --wait >/dev/null

export DFR_TRANSACTION_MIGRATION_DATABASE_URL="postgres://dfr_migrator:${DFR_POSTGRES_MIGRATOR_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"
export DFR_TRANSACTION_DATABASE_URL="postgres://dfr_runtime:${DFR_POSTGRES_RUNTIME_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"
# 迁移运行器端到端验证用独立库：避免与 schema 契约测试互相 DROP SCHEMA。
export DFR_TRANSACTION_RUNNER_DATABASE_URL="postgres://dfr_migrator:${DFR_POSTGRES_MIGRATOR_PASSWORD}@127.0.0.1:${DB_PORT}/${RUNNER_DB_NAME}"

TARGETS=("$@")
set +e
if [ ${#TARGETS[@]} -eq 0 ]; then
  # 每个 Store 契约都会 CREATE/DROP 独立测试库；跨文件并行时仍可能在
  # DROP DATABASE WITH (FORCE) 与另一个文件关闭连接之间产生 57P01 未处理异常。
  # 因此整个数据库门禁串行化；这只影响显式 DB gate，不影响默认离线测试速度。
  echo "db-test: 运行 packages/storage-postgres/test"
  pnpm vitest run --no-file-parallelism packages/storage-postgres/test
  STATUS=$?
  if [ ${STATUS} -eq 0 ]; then
    # Store schema 契约测试会 DROP SCHEMA；M1 一律使用另一个专用测试数据库。
    # 只允许 localhost + 固定测试库 + migrator/runtime 独立凭据，
    # preparation 仅 CREATE DATABASE IF ABSENT + 前向迁移，不删除任何旧库。
    echo "db-test: 为 M1 集成准备专用隔离库和迁移..."
    pnpm --filter @dfr/storage-postgres prepare:test-integration-db
    STATUS=$?
    if [ ${STATUS} -eq 0 ]; then
      export DFR_TRANSACTION_DATABASE_URL="postgres://dfr_runtime:${DFR_POSTGRES_RUNTIME_PASSWORD}@127.0.0.1:${DB_PORT}/dfr_m1_integration_test"
      echo "db-test: 运行 M1 专用库集成（storage + 写路径 + 故障注入）"
      pnpm vitest run --no-file-parallelism \
        tests/integration/m1-storage.integration.test.ts \
        tests/integration/m1-write-path.integration.test.ts \
        tests/integration/m1-fault-injection.integration.test.ts \
        tests/integration/m1-signed-recovery.integration.test.ts
      STATUS=$?
    fi
  fi
else
  echo "db-test: 运行 ${TARGETS[*]}"
  pnpm vitest run "${TARGETS[@]}"
  STATUS=$?
fi
set -e

if [ "${DFR_DB_TEST_KEEP:-1}" = "0" ]; then
  echo "db-test: 停止容器（保留数据卷；如需彻底清理：docker compose -f ${COMPOSE_DIR}/${COMPOSE_FILE} down -v）"
  docker compose -f "${COMPOSE_DIR}/${COMPOSE_FILE}" down >/dev/null
fi

exit ${STATUS}
