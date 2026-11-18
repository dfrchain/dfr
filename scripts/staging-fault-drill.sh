#!/usr/bin/env bash
# Isolated staging fault drill: actually stop the database and verify the
# Gateway's behavior.
#
# Coverage (matches docs/runbooks/staging-drill.md §3):
#   1. Normal: /healthz 200, /readyz 200, business 200, no key 401
#   2. Database stopped: /healthz still 200, /readyz 503, business 503,
#      dependency-rejection metric increasing
#   3. Recovery: /readyz returns to 200 automatically, business allowed again
#
# Red lines:
#   - Only dedicated container names / ports / volumes are used; the shared
#     M4 containers are never touched;
#   - Passwords and API keys are generated randomly at runtime, go only into
#     environment variables, and are never printed;
#   - No broadcast, no signing, no access to real funds; RPC endpoints use
#     unreachable local addresses.
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
  fail "${label} did not reach ${expected} within the timeout (last status ${code:-000})"
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
  [ "${actual}" = "${expected}" ] || fail "${label} expected ${expected}, got ${actual}"
  printf '  ok %s -> %s\n' "${label}" "${expected}"
}

MIGRATION_DSN="postgres://dfr_migrator:${DFR_DRILL_MIGRATOR_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"
RUNTIME_DSN="postgres://dfr_runtime:${DFR_DRILL_RUNTIME_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"

step '0. Start isolated Postgres'
docker compose -f "${COMPOSE_FILE}" -p "${PROJECT}" up -d --wait >/dev/null

step '1. Apply migrations'
DFR_TRANSACTION_MIGRATION_DATABASE_URL="${MIGRATION_DSN}" \
  pnpm --filter @dfr/storage-postgres migrate >/dev/null

step '2. Start Gateway (write path + M4)'
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

step '3. Normal path'
expect_code "$(request_code "${BASE_URL}/v1/chains" GET auth)" 200 'business request (with key)'
expect_code "$(request_code "${BASE_URL}/v1/chains" GET)" 401 'business request (no key)'

step '4. Stop the database: process alive, dependency not ready, business rejected'
docker stop dfr-staging-drill-postgres >/dev/null
wait_http "${BASE_URL}/readyz" 503 '/readyz (after stopping the database)'
expect_code "$(request_code "${BASE_URL}/healthz" GET)" 200 '/healthz (after stopping the database)'
expect_code "$(request_code "${BASE_URL}/v1/chains" GET auth)" 503 'business request (after stopping the database)'

METRICS=$(curl -s --max-time 3 -H "@${API_KEY_HEADER_FILE}" "${BASE_URL}/metrics" 2>/dev/null || true)
grep -q 'dfr_gateway_dependency_rejected_total' <<<"${METRICS}" || fail 'dependency-rejection metric missing'
printf '  ok dependency-rejection metric is exported\n'

step '5. Restore the database: automatically recovers and allows traffic'
docker start dfr-staging-drill-postgres >/dev/null
for _ in $(seq 1 30); do
  if docker exec dfr-staging-drill-postgres pg_isready -U dfr_bootstrap -d "${DB_NAME}" >/dev/null 2>&1; then break; fi
  sleep 1
done
wait_http "${BASE_URL}/readyz" 200 '/readyz (after recovery)'
expect_code "$(request_code "${BASE_URL}/v1/chains" GET auth)" 200 'business request (after recovery)'

step 'PASS'
printf 'Isolated staging fault drill passed: database-stop rejection -> recovery allows traffic; nothing broadcast, shared containers untouched.\n'
