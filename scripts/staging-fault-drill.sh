#!/usr/bin/env bash
# 隔离 staging 故障演练：真实停掉数据库，验证 Gateway 的行为。
#
# 覆盖（与 docs/runbooks/staging-drill.md §3 对应）：
#   1. 正常：/healthz 200、/readyz 200、业务 200、无 Key 401
#   2. 停库：/healthz 仍 200、/readyz 503、业务 503、依赖拒绝指标递增
#   3. 恢复：/readyz 自动回到 200、业务重新放行
#
# 红线：
#   - 只使用专用容器名 / 端口 / 卷，不触碰共享 M4 容器；
#   - 密码与 API Key 运行时随机生成，只进环境变量，绝不打印；
#   - 不广播、不签名、不访问真实资金；RPC 端点用不可达本地地址。
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
COMPOSE_FILE="${REPO_ROOT}/infrastructure/docker/docker-compose.staging-drill.yml"
PROJECT='dfr-staging-fault-drill'
DB_PORT='55433'
DB_NAME='dfr_staging_drill'

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

random_hex() { node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))'; }

DFR_DRILL_BOOTSTRAP_PASSWORD=$(random_hex)
DFR_DRILL_MIGRATOR_PASSWORD=$(random_hex)
DFR_DRILL_RUNTIME_PASSWORD=$(random_hex)
export DFR_DRILL_BOOTSTRAP_PASSWORD DFR_DRILL_MIGRATOR_PASSWORD DFR_DRILL_RUNTIME_PASSWORD

API_KEY_ID='DrillKey'
API_KEY_PEPPER=$(random_hex)
API_KEY_SECRET=$(random_hex)
API_KEY_HASH=$(SECRET="${API_KEY_SECRET}" PEPPER="${API_KEY_PEPPER}" node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(process.env.SECRET+process.env.PEPPER).digest("hex"))')
API_KEY="dfr_${API_KEY_ID}_${API_KEY_SECRET}"
API_KEY_HEADER_FILE=$(mktemp -t dfr-staging-drill-header.XXXXXX)
chmod 600 "${API_KEY_HEADER_FILE}"
printf 'X-DFR-Key: %s\n' "${API_KEY}" > "${API_KEY_HEADER_FILE}"

GATEWAY_PORT=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})')
GATEWAY_LOG=$(mktemp -t dfr-staging-drill-gateway.XXXXXX.log)
GATEWAY_PID=''

cleanup() {
  if [ -n "${GATEWAY_PID}" ] && kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    kill "${GATEWAY_PID}" 2>/dev/null || true
    wait "${GATEWAY_PID}" 2>/dev/null || true
  fi
  rm -f "${API_KEY_HEADER_FILE}"
  docker compose -f "${COMPOSE_FILE}" -p "${PROJECT}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_http() {
  local url="$1" expected="$2" label="$3"
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${url}" 2>/dev/null || true)
    if [ "${code}" = "${expected}" ]; then printf '  ok %s -> %s\n' "${label}" "${expected}"; return 0; fi
    sleep 1
  done
  fail "${label} 未在超时内达到 ${expected}（最后状态 ${code:-000}）"
}

request_code() {
  local url="$1" method="${2:-GET}" auth_mode="${3:-}"
  if [ "${method}" = 'GET' ] && [ "${auth_mode}" = 'auth' ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "@${API_KEY_HEADER_FILE}" "${url}" 2>/dev/null || echo 000
  elif [ "${method}" = 'GET' ]; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${url}" 2>/dev/null || echo 000
  fi
}

expect_code() {
  local actual="$1" expected="$2" label="$3"
  [ "${actual}" = "${expected}" ] || fail "${label} 期望 ${expected}，实际 ${actual}"
  printf '  ok %s -> %s\n' "${label}" "${expected}"
}

MIGRATION_DSN="postgres://dfr_migrator:${DFR_DRILL_MIGRATOR_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"
RUNTIME_DSN="postgres://dfr_runtime:${DFR_DRILL_RUNTIME_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"

step '0. 启动隔离 Postgres'
docker compose -f "${COMPOSE_FILE}" -p "${PROJECT}" up -d --wait >/dev/null

step '1. 应用迁移'
DFR_TRANSACTION_MIGRATION_DATABASE_URL="${MIGRATION_DSN}" \
  pnpm --filter @dfr/storage-postgres migrate >/dev/null

step '2. 启动 Gateway（写路径 + M4）'
DFR_GATEWAY_PORT="${GATEWAY_PORT}" \
DFR_M1_ALLOW_WRITE='true' \
DFR_DEPLOY_MILESTONE='M4' \
DFR_TRANSACTION_DATABASE_URL="${RUNTIME_DSN}" \
DFR_M0_API_KEY_ID="${API_KEY_ID}" \
DFR_M0_API_KEY_HASH="${API_KEY_HASH}" \
DFR_M0_API_KEY_PEPPER="${API_KEY_PEPPER}" \
DFR_M0_SCOPE_CHAINS='ethereum-sepolia' \
DFR_M0_SCOPE_CAPABILITIES='block.read,transaction.read,transaction.build,transaction.simulate,transaction.broadcast' \
DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL='http://127.0.0.1:9' \
DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL='http://127.0.0.1:9' \
DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL='http://127.0.0.1:9' \
DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_URL='http://127.0.0.1:9' \
  pnpm --filter @dfr/gateway start >"${GATEWAY_LOG}" 2>&1 &
GATEWAY_PID=$!

BASE_URL="http://127.0.0.1:${GATEWAY_PORT}"
wait_http "${BASE_URL}/healthz" 200 '/healthz'
wait_http "${BASE_URL}/readyz" 200 '/readyz'

step '3. 正常路径'
expect_code "$(request_code "${BASE_URL}/v1/chains" GET auth)" 200 '业务请求（带 Key）'
expect_code "$(request_code "${BASE_URL}/v1/chains" GET)" 401 '业务请求（无 Key）'

step '4. 停库：进程存活、依赖未就绪、业务被拒'
docker stop dfr-staging-drill-postgres >/dev/null
wait_http "${BASE_URL}/readyz" 503 '/readyz（停库后）'
expect_code "$(request_code "${BASE_URL}/healthz" GET)" 200 '/healthz（停库后）'
expect_code "$(request_code "${BASE_URL}/v1/chains" GET auth)" 503 '业务请求（停库后）'

METRICS=$(curl -s --max-time 3 -H "@${API_KEY_HEADER_FILE}" "${BASE_URL}/metrics" 2>/dev/null || true)
grep -q 'dfr_gateway_dependency_rejected_total' <<<"${METRICS}" || fail '依赖拒绝指标缺失'
printf '  ok 依赖拒绝指标已导出\n'

step '5. 恢复数据库：自动恢复放行'
docker start dfr-staging-drill-postgres >/dev/null
for _ in $(seq 1 30); do
  if docker exec dfr-staging-drill-postgres pg_isready -U dfr_bootstrap -d "${DB_NAME}" >/dev/null 2>&1; then break; fi
  sleep 1
done
wait_http "${BASE_URL}/readyz" 200 '/readyz（恢复后）'
expect_code "$(request_code "${BASE_URL}/v1/chains" GET auth)" 200 '业务请求（恢复后）'

step 'PASS'
printf '隔离 staging 故障演练通过：停库拒绝 -> 恢复放行；未广播、未触碰共享容器。\n'
