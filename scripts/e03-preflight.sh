#!/usr/bin/env bash
# DFR M1-E03 preflight check (real Sepolia broadcast acceptance)
#
# Purpose: before running E03 (real-chain broadcast acceptance), verify all
# preconditions in one pass and give **actionable** hints for anything missing.
# It is the first step of the "human in the loop" flow: only when this script
# reports READY should you go on to build a transaction.
#
# Safety rules (same as the runbook):
#   - This script is **read-only**: it only sends eth_chainId (read-only) and
#     one database connectivity query; it does not build, sign, or broadcast;
#   - **Never print any credential value**, only report "is set / is not set"
#     and length-independent verdicts;
#   - Missing means fail-closed (exit code 1); no guessing, no downgrading.
#
# Usage:
#   set -a; . ./e03.env; set +a      # Export the preconditions in a shell (this file is not committed)
#   ./scripts/e03-preflight.sh
#   DFR_E03_SKIP_DB=1 ./scripts/e03-preflight.sh   # Only verify RPC and registry
#
# Exit codes: 0 = all passed; 1 = something is missing.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
cd "${REPO_ROOT}"

EXPECTED_CHAIN_ID='0xaa36a7'   # 11155111 = Sepolia
FAILED=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
hint() { printf '      → %s\n' "$1"; }
head_() { printf '\n%s\n' "$1"; }

head_ 'E03 preflight check'

# ---------------------------------------------------------------------------
# 1. Required environment variables (report existence only; never print values)
# ---------------------------------------------------------------------------
head_ '1) Environment variables'
require_env() {
  local name="$1" why="$2"
  if [ -n "${!name:-}" ]; then
    ok "${name} is set"
  else
    bad "${name} is not set"
    hint "${why}"
  fi
}

require_env DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL 'Sepolia primary RPC endpoint (needed for read-only calls)'
require_env DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL 'Sepolia secondary RPC endpoint (needed for provider failover)'
require_env DFR_M0_API_KEY_ID 'Gateway auth keyId (8 chars)'
require_env DFR_M0_API_KEY_HASH 'sha256(secret+pepper) of the API key secret'

if [ "${DFR_M1_ALLOW_WRITE:-}" = 'true' ]; then
  ok 'DFR_M1_ALLOW_WRITE=true'
else
  bad 'DFR_M1_ALLOW_WRITE is not true (the write path is not open)'
  hint 'Real broadcasts must be explicitly enabled: export DFR_M1_ALLOW_WRITE=true'
fi

if [ "${DFR_E03_SKIP_DB:-0}" = '1' ]; then
  head_ '2) Database (skipped per DFR_E03_SKIP_DB=1)'
else
  head_ '2) Database'
  if [ -z "${DFR_TRANSACTION_DATABASE_URL:-}" ]; then
    bad 'DFR_TRANSACTION_DATABASE_URL is not set (the M1 write path needs a persistent Store)'
    hint 'Locally, start a test database with pnpm test:db and export the DSN; production must point at a real database'
  else
    ok 'DFR_TRANSACTION_DATABASE_URL is set'
    # The probe runs in two steps, and the two failure kinds **must be distinguished**:
    #   1) Driver unavailable: `pg` is only declared in packages/storage-postgres, so requiring it
    #      from the repo root gives MODULE_NOT_FOUND. That once misreported "the script's own problem"
    #      as "database unreachable", sending the operator off to debug the network and permissions
    #      (fixed 2026-10-06).
    #   2) Connection failure: a network/credential problem.
    # The original error text is never shown (it may contain DSN fragments).
    if node -e '
      try { require.resolve("pg", { paths: [process.cwd() + "/packages/storage-postgres"] }); }
      catch { process.exit(3); }
    ' >/dev/null 2>&1; then
      ok 'Database driver is available'
      if node -e '
        const { Pool } = require(require.resolve("pg", { paths: [process.cwd() + "/packages/storage-postgres"] }));
        const pool = new Pool({ connectionString: process.env.DFR_TRANSACTION_DATABASE_URL, connectionTimeoutMillis: 5000 });
        pool.query("SELECT 1").then(() => pool.end()).then(() => process.exit(0)).catch(() => process.exit(1));
      ' >/dev/null 2>&1; then
        ok 'Database is reachable'
      else
        bad 'Database is unreachable (original error is not echoed, to avoid leaking the DSN)'
        hint 'Check the DSN, network, and account permissions; the runtime identity only needs DML'
      fi
    else
      bad 'Database driver is unavailable (repo dependencies are not installed, or pg cannot be resolved)'
      hint 'Run pnpm install --frozen-lockfile first; the driver is resolved via packages/storage-postgres'
      hint '(This is a tooling/installation problem, not a database problem — do not debug the network on its basis)'
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. RPC reachability + chain identity (must be Sepolia)
# ---------------------------------------------------------------------------
head_ '3) RPC endpoints and chain identity'
check_rpc() {
  local label="$1" url="$2"
  if [ -z "${url}" ]; then
    bad "${label} is not configured; skipping the probe"
    return
  fi
  local body chain_id
  body=$(node -e '
    const url = process.argv[1];
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(8000),
    })
      .then((r) => r.json())
      .then((j) => { if (j.result) process.stdout.write(String(j.result)); else process.exit(1); })
      .catch(() => process.exit(1));
  ' "${url}" 2>/dev/null) || body=''

  if [ -z "${body}" ]; then
    bad "${label} is unreachable or returned no chainId"
    hint 'Confirm the endpoint URL is correct and the network is reachable; if the endpoint needs credentials, check that the key has been injected'
    return
  fi
  chain_id=$(printf '%s' "${body}" | tr 'A-Z' 'a-z')
  if [ "${chain_id}" = "${EXPECTED_CHAIN_ID}" ]; then
    ok "${label} is reachable and chainId = ${chain_id} (Sepolia)"
  else
    bad "${label} chainId = ${chain_id}, is not Sepolia (${EXPECTED_CHAIN_ID})"
    hint 'Compare the eth_chainId result directly against 11155111; pointing at another chain will be rejected by the Adapter at the build stage'
  fi
}

check_rpc 'Primary RPC' "${DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL:-}"
check_rpc 'Secondary RPC' "${DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL:-}"

# ---------------------------------------------------------------------------
# 4. Whether the registry has declared broadcast capability for ethereum-sepolia (the core of the E03 preflight)
# ---------------------------------------------------------------------------
head_ '4) Registry capability declaration'
if node -e '
  const { parse } = require("yaml");
  const fs = require("node:fs");
  const reg = parse(fs.readFileSync("packages/registry/config/chains.yaml", "utf8"));
  const chain = reg.chains["ethereum-sepolia"];
  if (!chain) process.exit(2);
  const caps = chain.capabilities ?? [];
  process.exit(caps.includes("transaction.broadcast") ? 0 : 1);
' >/dev/null 2>&1; then
  ok 'ethereum-sepolia has declared transaction.broadcast'
else
  bad 'ethereum-sepolia has not declared transaction.broadcast (Registry fail-closed; the broadcast would be rejected)'
  hint 'See docs/development/deliveries/DFR-M1-E03-prep.md: restoring the capability must be synced with the registry contract tests'
fi

# ---------------------------------------------------------------------------
# 5. Funded account (provided by a human; the script only prompts)
# ---------------------------------------------------------------------------
head_ '5) Funded account (provided by a human; the script cannot verify it)'
if [ -n "${DFR_E03_FUNDED_ADDRESS:-}" ]; then
  ok 'DFR_E03_FUNDED_ADDRESS is set (the script does not verify its balance; a human must confirm it holds test ETH)'
else
  bad 'DFR_E03_FUNDED_ADDRESS is not set'
  hint 'This address is used for the build from field; balance and private key are held in a human wallet, and DFR never touches the private key'
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
head_ 'Summary'
if [ "${FAILED}" -eq 0 ]; then
  printf '  \033[32mREADY\033[0m: preflight is complete; continue per docs/runbooks/m1-sepolia-broadcast-checkpoint.md.\n'
  printf '  Next: build a minimum-amount native transfer -> simulate -> **human wallet signature** -> a single broadcast.\n'
  exit 0
fi

printf '  \033[31mNOT READY\033[0m: there are missing items (see above). E03 stays No-Go; do not substitute offline tests.\n'
exit 1
