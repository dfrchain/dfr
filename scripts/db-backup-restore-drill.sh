#!/usr/bin/env bash
# DFR 数据库备份 / 恢复演练（隔离环境）。
#
# 目的：证明“备份能恢复”不是口头假设。流程：
#   1. 使用现有测试 PostgreSQL，创建独立源库与目标库；
#   2. 在源库应用全部迁移并写入代表性事实（交易/状态迁移/幂等/配额）；
#   3. pg_dump 自定义格式备份；
#   4. pg_restore 到目标库；
#   5. 校验迁移版本、schema 对象与关键行完全一致。
#
# 隔离：数据库名以 _backup_test 结尾，结束后 DROP；不触碰 dfr_m1_test。
# 安全：口令只从 infrastructure/docker/.env 读入环境变量，不打印 DSN。
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
ENV_FILE="${REPO_ROOT}/infrastructure/docker/.env"
CONTAINER='dfr-m1-postgres-test'
SOURCE_DB='dfr_backup_source_test'
TARGET_DB='dfr_backup_target_test'

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

[ -f "${ENV_FILE}" ] || fail "缺少 ${ENV_FILE}"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

# 幂等启动测试容器：CI 顺序执行时，前一阶段（pnpm test:db 且 KEEP=0）
# 可能已经停掉容器；备份演练必须自己保证依赖在场，而不是要求调用方预热。
docker compose -f "${REPO_ROOT}/infrastructure/docker/docker-compose.test.yml" up -d --wait >/dev/null
docker inspect "${CONTAINER}" >/dev/null 2>&1 || fail "测试容器 ${CONTAINER} 未运行"

# 容器内执行 psql；口令经 PGPASSWORD 传入，不出现在 argv。
psql_admin() {
  local db="$1"; shift
  docker exec -e PGPASSWORD="${DFR_POSTGRES_BOOTSTRAP_PASSWORD}" "${CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -U dfr_bootstrap -d "${db}" "$@"
}

drop_databases() {
  psql_admin postgres -c "DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE)" >/dev/null 2>&1 || true
  psql_admin postgres -c "DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)" >/dev/null 2>&1 || true
}

cleanup() {
  drop_databases
}
trap cleanup EXIT INT TERM

step '0. 创建独立源库 / 目标库'
drop_databases
psql_admin postgres -c "CREATE DATABASE ${SOURCE_DB} OWNER dfr_migrator" >/dev/null
psql_admin postgres -c "CREATE DATABASE ${TARGET_DB} OWNER dfr_migrator" >/dev/null
printf '  ok 已创建隔离数据库\n'

step '1. 源库应用全部迁移'
SOURCE_DSN="postgres://dfr_migrator:${DFR_POSTGRES_MIGRATOR_PASSWORD}@127.0.0.1:55432/${SOURCE_DB}"
DFR_TRANSACTION_MIGRATION_DATABASE_URL="${SOURCE_DSN}" \
  pnpm --filter @dfr/storage-postgres migrate >/dev/null
printf '  ok 迁移完成\n'

step '2. 写入代表性事实'
docker exec -i -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
  psql -v ON_ERROR_STOP=1 -U dfr_migrator -d "${SOURCE_DB}" -q <<'SQL'
INSERT INTO transaction_data.transactions
  (id, project_id, chain_id, request_fingerprint, status, state_version, from_address, nonce)
VALUES
  ('txn_backup_001', 'default', 'base-sepolia', repeat('a',64), 'finalized', 3,
   '0x1111111111111111111111111111111111111111', 7);

INSERT INTO transaction_data.transaction_transitions
  (transaction_id, from_status, to_status, reason)
VALUES ('txn_backup_001', 'pending', 'finalized', 'backup.restore.test');

INSERT INTO transaction_data.idempotency_records
  (project_id, chain_id, key, fingerprint, state, owner_token, lease_expires_at, expires_at,
   transaction_id, status_code)
VALUES
  ('default', 'base-sepolia', 'backup-key-001', repeat('b',64), 'completed', 'owner-1',
   clock_timestamp() + interval '1 hour', clock_timestamp() + interval '24 hours',
   'txn_backup_001', 200);

INSERT INTO transaction_data.provider_quota_daily
  (provider_id, chain_id, day, used)
VALUES ('backup-provider', 'base-sepolia', DATE '2026-10-08', 42);
SQL

# 防假阳性：如果 stdin 被吞或 SQL 未执行，后续“空表等于空表”的比对会
# 看起来完全一致。这里先在源库断言四类事实都真实存在。
SOURCE_COUNTS=$(docker exec -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
  psql -v ON_ERROR_STOP=1 -At -U dfr_migrator -d "${SOURCE_DB}" -c \
  "SELECT (SELECT count(*) FROM transaction_data.transactions) || ':' ||
          (SELECT count(*) FROM transaction_data.transaction_transitions) || ':' ||
          (SELECT count(*) FROM transaction_data.idempotency_records) || ':' ||
          (SELECT count(*) FROM transaction_data.provider_quota_daily)")
[ "${SOURCE_COUNTS}" = '1:1:1:1' ] || fail "源库代表性数据未写入（${SOURCE_COUNTS}）"
printf '  ok 事务 / 状态迁移 / 幂等 / 配额均已写入\n'

step '3. pg_dump 备份'
BACKUP_FILE=$(mktemp -t dfr-backup.XXXXXX.dump)
docker exec -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
  pg_dump -U dfr_migrator -d "${SOURCE_DB}" --format=custom >"${BACKUP_FILE}"
SIZE=$(wc -c <"${BACKUP_FILE}" | tr -d ' ')
[ "${SIZE}" -gt 0 ] || fail '备份文件为空'
printf '  ok 备份生成（%s bytes）\n' "${SIZE}"

step '4. pg_restore 恢复'
docker exec -i -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
  pg_restore -U dfr_migrator -d "${TARGET_DB}" --no-owner --exit-on-error <"${BACKUP_FILE}"
printf '  ok 恢复完成\n'

step '5. 一致性校验'
check_equal() {
  local label="$1" sql="$2"
  local source target
  source=$(docker exec -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -At -U dfr_migrator -d "${SOURCE_DB}" -c "${sql}")
  target=$(docker exec -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -At -U dfr_migrator -d "${TARGET_DB}" -c "${sql}")
  [ "${source}" = "${target}" ] || fail "${label} 不一致：source=${source} target=${target}"
  printf '  ok %s = %s\n' "${label}" "${target}"
}

check_equal '迁移版本数' \
  "SELECT count(*) FROM dfr_migrations.schema_migrations"
check_equal '业务表数' \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='transaction_data' AND table_type='BASE TABLE'"
check_equal '交易快照指纹' \
  "SELECT md5(string_agg(id || ':' || status || ':' || state_version, ',' ORDER BY id)) FROM transaction_data.transactions"
check_equal '状态迁移数' \
  "SELECT count(*) FROM transaction_data.transaction_transitions"
check_equal '幂等记录指纹' \
  "SELECT md5(string_agg(key || ':' || fingerprint || ':' || state || ':' || status_code, ',' ORDER BY key)) FROM transaction_data.idempotency_records"
check_equal 'Provider 配额用量' \
  "SELECT used FROM transaction_data.provider_quota_daily WHERE provider_id='backup-provider' AND chain_id='base-sepolia' AND day=DATE '2026-10-08'"

rm -f "${BACKUP_FILE}"
step 'PASS'
printf '备份 / 恢复演练通过；临时数据库与备份文件已清理。\n'
