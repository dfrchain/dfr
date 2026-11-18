#!/usr/bin/env bash
# DFR OpenAPI semantic gate (DFR-M1-A03)
#
# See docs/architecture/m1-api-contract.md, section 7:
#   - Checking that `$ref` resolves is not enough; semantic lint must run;
#   - The single source of truth for the spec is docs/api/openapi.yaml.
#
# Usage:
#   ./scripts/lint-openapi.sh [spec-path]
#     When spec-path is omitted, docs/api/openapi.yaml is used;
#     a passed path is used for negative controls (see
#     tests/contract/openapi-lint.test.ts).
#
# Exit codes:
#   0 = passed (warnings allowed; the warning list is recorded in the
#       delivery report)
#   1 = an error was found, or the spec/tool is unavailable
#
# This script follows the repository's existing convention: self-contained,
# no third-party action, calling only the @redocly/cli pinned to an exact
# version in package.json.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
cd "${REPO_ROOT}"

SPEC="${1:-docs/api/openapi.yaml}"

if [ ! -f "${SPEC}" ]; then
  echo "lint-openapi: spec file ${SPEC} not found" >&2
  exit 1
fi

REDOCLY="./node_modules/.bin/redocly"
if [ ! -x "${REDOCLY}" ]; then
  echo "lint-openapi: @redocly/cli is missing." >&2
  echo "lint-openapi: first run pnpm install --frozen-lockfile" >&2
  exit 1
fi

# The config is pinned at the repository root redocly.yaml; pass it
# explicitly so the run is not affected by cwd or user-level config.
exec "${REDOCLY}" lint --config redocly.yaml "${SPEC}"
