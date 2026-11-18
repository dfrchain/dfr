#!/usr/bin/env bash
# DFR M1 database gate (local / CI)
#
# Purpose: run the tests that require a real PostgreSQL to verify
# (migrations, schema, concurrency, leases). These tests are **not** part of
# the default `pnpm verify`: the default gate must be reproducible offline.
#
# Behavior:
#   1. Read infrastructure/docker/.env (if missing, prompt to copy
#      .env.example and exit);
#   2. Start the test containers if not running and wait for health;
#   3. Export DSNs for the migration and runtime identities separately
#      (passwords are never echoed);
#   4. Run the specified tests (default packages/storage-postgres/test);
#   5. At the end, decide from DFR_DB_TEST_KEEP whether to stop the
#      containers (default: keep them, for easier debugging).
#
# Usage:
#   ./scripts/db-test.sh
#   ./scripts/db-test.sh packages/storage-postgres/test/schema.test.ts
#   DFR_DB_TEST_KEEP=0 ./scripts/db-test.sh      # stop containers afterwards (keep data volumes)
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
  echo "db-test: illegal test compose file name or test port" >&2
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "db-test: missing ${ENV_FILE}" >&2
  echo "db-test: first run  cd ${COMPOSE_DIR} && cp .env.example .env  and fill in random passwords" >&2
  exit 1
fi

# Passwords go only into environment variables, never into command-line
# arguments or output.
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

for required in DFR_POSTGRES_MIGRATOR_PASSWORD DFR_POSTGRES_RUNTIME_PASSWORD; do
  if [ -z "${!required:-}" ]; then
    echo "db-test: ${ENV_FILE} is missing ${required}" >&2
    exit 1
  fi
done

echo "db-test: starting test database (idempotent)..."
docker compose -f "${COMPOSE_DIR}/${COMPOSE_FILE}" up -d --wait >/dev/null

export DFR_TRANSACTION_MIGRATION_DATABASE_URL="postgres://dfr_migrator:${DFR_POSTGRES_MIGRATOR_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"
export DFR_TRANSACTION_DATABASE_URL="postgres://dfr_runtime:${DFR_POSTGRES_RUNTIME_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}"
# The migration-runner end-to-end verification uses a separate database: to
# avoid DROP SCHEMA conflicts with the schema contract tests.
export DFR_TRANSACTION_RUNNER_DATABASE_URL="postgres://dfr_migrator:${DFR_POSTGRES_MIGRATOR_PASSWORD}@127.0.0.1:${DB_PORT}/${RUNNER_DB_NAME}"

TARGETS=("$@")
set +e
if [ ${#TARGETS[@]} -eq 0 ]; then
  # Each Store contract creates/drops its own test database; when files run
  # in parallel, an unhandled 57P01 error can still occur between
  # DROP DATABASE WITH (FORCE) and another file closing its connections.
  # So the whole database gate is serialized; this only affects the explicit
  # DB gate, not the speed of the default offline tests.
  echo "db-test: running packages/storage-postgres/test"
  pnpm vitest run --no-file-parallelism packages/storage-postgres/test
  STATUS=$?
  if [ ${STATUS} -eq 0 ]; then
    # Store schema contract tests DROP SCHEMA; M1 always uses another
    # dedicated test database. Only localhost + fixed test databases +
    # separate migrator/runtime credentials are allowed; preparation only
    # does CREATE DATABASE IF ABSENT + forward migrations, and never deletes
    # any existing database.
    echo "db-test: preparing a dedicated isolated database and migrations for M1 integration..."
    pnpm --filter @dfr/storage-postgres prepare:test-integration-db
    STATUS=$?
    if [ ${STATUS} -eq 0 ]; then
      export DFR_TRANSACTION_DATABASE_URL="postgres://dfr_runtime:${DFR_POSTGRES_RUNTIME_PASSWORD}@127.0.0.1:${DB_PORT}/dfr_m1_integration_test"
      echo "db-test: running M1 dedicated-database integration (storage + write path + fault injection)"
      pnpm vitest run --no-file-parallelism \
        tests/integration/m1-storage.integration.test.ts \
        tests/integration/m1-write-path.integration.test.ts \
        tests/integration/m1-fault-injection.integration.test.ts \
        tests/integration/m1-signed-recovery.integration.test.ts
      STATUS=$?
    fi
  fi
else
  echo "db-test: running ${TARGETS[*]}"
  pnpm vitest run "${TARGETS[@]}"
  STATUS=$?
fi
set -e

if [ "${DFR_DB_TEST_KEEP:-1}" = "0" ]; then
  echo "db-test: stopping containers (keeping data volumes; for a full cleanup: docker compose -f ${COMPOSE_DIR}/${COMPOSE_FILE} down -v)"
  docker compose -f "${COMPOSE_DIR}/${COMPOSE_FILE}" down >/dev/null
fi

exit ${STATUS}
