#!/usr/bin/env bash
# Create the two M1 business roles (migration / runtime separation).
#
# Executed once by the official PostgreSQL image when it **first initializes
# the data volume**; passwords live only in container environment variables
# and are not written into this file, compose, or the image.
#
# Note: psql's :'var' / :"var" only recognize **psql variables**, not shell
# environment variables. So every value that needs interpolation must be
# passed explicitly with --set, otherwise it fails with
# `syntax error at or near ":"` (hit here before).
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --set=dbname="${POSTGRES_DB}" \
  --set=migrator_password="${DFR_MIGRATOR_PASSWORD}" \
  --set=runtime_password="${DFR_RUNTIME_PASSWORD}" <<'SQL'
-- Migration identity: can create schemas and do DDL; not used for runtime queries.
CREATE ROLE dfr_migrator LOGIN PASSWORD :'migrator_password';

-- Runtime identity: DML only; cannot change schemas or create tables.
CREATE ROLE dfr_runtime LOGIN PASSWORD :'runtime_password';

GRANT CONNECT ON DATABASE :"dbname" TO dfr_migrator, dfr_runtime;

-- No role may create tables in the public schema at will; the migration
-- identity instead gets CREATE at the database level, used to create the
-- transaction_data schema (see migrations/0001).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CREATE ON DATABASE :"dbname" TO dfr_migrator;

-- The migration runner needs a separate database for its end-to-end
-- verification of "apply the real migrations from zero": if it shared one
-- database with the schema contract tests, the two would interfere by
-- dropping each other's schemas.
CREATE DATABASE dfr_m1_runner_test OWNER dfr_migrator;

-- Let the migration identity create its own one-off test databases: later
-- Store implementation tests (A09–A12) each use a separate database, so they
-- do not compete across files by TRUNCATE / DROP on the same database.
ALTER ROLE dfr_migrator CREATEDB;
SQL
