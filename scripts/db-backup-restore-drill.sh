#!/usr/bin/env bash
# DFR database backup / restore drill (isolated environment).
#
# Purpose: prove that "backups can be restored" is not just an assumption.
# Flow:
#   1. Use the existing test PostgreSQL to create separate source and
#      target databases;
#   2. Apply all migrations to the source database and write representative
#      facts (transactions / state transitions / idempotency / quotas);
#   3. pg_dump in custom format;
#   4. pg_restore into the target database;
#   5. Verify migration versions, schema objects, and key rows match exactly.
#
# Isolation: database names end in _backup_test and are DROPPED afterwards;
# dfr_m1_test is untouched.
# Safety: passwords are read from infrastructure/docker/.env into
# environment variables only; DSNs are never printed.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
ENV_FILE="${REPO_ROOT}/infrastructure/docker/.env"
CONTAINER='dfr-m1-postgres-test'
SOURCE_DB='dfr_backup_source_test'
TARGET_DB='dfr_backup_target_test'

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

[ -f "${ENV_FILE}" ] || fail "missing ${ENV_FILE}"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

# Start the test containers idempotently: when CI runs stages in order, an
# earlier stage (pnpm test:db with KEEP=0) may already have stopped the
# containers; the backup drill must ensure its own dependencies are present
# rather than requiring the caller to warm them up.
docker compose -f "${REPO_ROOT}/infrastructure/docker/docker-compose.test.yml" up -d --wait >/dev/null
docker inspect "${CONTAINER}" >/dev/null 2>&1 || fail "test container ${CONTAINER} is not running"

# Run psql inside the container; the password is passed via PGPASSWORD and
# never appears in argv.
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

step '0. Create isolated source / target databases'
drop_databases
psql_admin postgres -c "CREATE DATABASE ${SOURCE_DB} OWNER dfr_migrator" >/dev/null
psql_admin postgres -c "CREATE DATABASE ${TARGET_DB} OWNER dfr_migrator" >/dev/null
printf '  ok isolated databases created\n'

step '1. Apply all migrations to the source database'
SOURCE_DSN="postgres://dfr_migrator:${DFR_POSTGRES_MIGRATOR_PASSWORD}@127.0.0.1:55432/${SOURCE_DB}"
DFR_TRANSACTION_MIGRATION_DATABASE_URL="${SOURCE_DSN}" \
  pnpm --filter @dfr/storage-postgres migrate >/dev/null
printf '  ok migrations applied\n'

step '2. Write representative facts'
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

# Guard against false positives: if stdin were swallowed or the SQL never
# ran, a later comparison of "empty table equals empty table" would look
# perfectly consistent. So first assert on the source database that all four
# kinds of facts really exist.
SOURCE_COUNTS=$(docker exec -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
  psql -v ON_ERROR_STOP=1 -At -U dfr_migrator -d "${SOURCE_DB}" -c \
  "SELECT (SELECT count(*) FROM transaction_data.transactions) || ':' ||
          (SELECT count(*) FROM transaction_data.transaction_transitions) || ':' ||
          (SELECT count(*) FROM transaction_data.idempotency_records) || ':' ||
          (SELECT count(*) FROM transaction_data.provider_quota_daily)")
[ "${SOURCE_COUNTS}" = '1:1:1:1' ] || fail "representative data was not written to the source database (${SOURCE_COUNTS})"
printf '  ok transaction / state transition / idempotency / quota all written\n'

step '3. pg_dump backup'
BACKUP_FILE=$(mktemp -t dfr-backup.XXXXXX.dump)
docker exec -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
  pg_dump -U dfr_migrator -d "${SOURCE_DB}" --format=custom >"${BACKUP_FILE}"
SIZE=$(wc -c <"${BACKUP_FILE}" | tr -d ' ')
[ "${SIZE}" -gt 0 ] || fail 'backup file is empty'
printf '  ok backup created (%s bytes)\n' "${SIZE}"

step '4. pg_restore recovery'
docker exec -i -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
  pg_restore -U dfr_migrator -d "${TARGET_DB}" --no-owner --exit-on-error <"${BACKUP_FILE}"
printf '  ok restore complete\n'

step '5. Consistency checks'
check_equal() {
  local label="$1" sql="$2"
  local source target
  source=$(docker exec -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -At -U dfr_migrator -d "${SOURCE_DB}" -c "${sql}")
  target=$(docker exec -e PGPASSWORD="${DFR_POSTGRES_MIGRATOR_PASSWORD}" "${CONTAINER}" \
    psql -v ON_ERROR_STOP=1 -At -U dfr_migrator -d "${TARGET_DB}" -c "${sql}")
  [ "${source}" = "${target}" ] || fail "${label} mismatch: source=${source} target=${target}"
  printf '  ok %s = %s\n' "${label}" "${target}"
}

check_equal 'migration version count' \
  "SELECT count(*) FROM dfr_migrations.schema_migrations"
check_equal 'business table count' \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='transaction_data' AND table_type='BASE TABLE'"
check_equal 'transaction snapshot fingerprint' \
  "SELECT md5(string_agg(id || ':' || status || ':' || state_version, ',' ORDER BY id)) FROM transaction_data.transactions"
check_equal 'state transition count' \
  "SELECT count(*) FROM transaction_data.transaction_transitions"
check_equal 'idempotency record fingerprint' \
  "SELECT md5(string_agg(key || ':' || fingerprint || ':' || state || ':' || status_code, ',' ORDER BY key)) FROM transaction_data.idempotency_records"
check_equal 'Provider quota usage' \
  "SELECT used FROM transaction_data.provider_quota_daily WHERE provider_id='backup-provider' AND chain_id='base-sepolia' AND day=DATE '2026-10-08'"

rm -f "${BACKUP_FILE}"
step 'PASS'
printf 'Backup / restore drill passed; temporary databases and backup file cleaned up.\n'
