#!/usr/bin/env bash
# DFR staging drill preflight check (M5-E01, launch-plan chain 4, "one staging run before the A-scope launch").
#
# Purpose: on a **deployed** DFR instance, verify in one pass that "this staging drill is worth starting":
# the process is alive, dependencies are ready, auth really works, the read-only surface returns real data, and metrics can be scraped.
#
# Why a separate script instead of reusing e03-preflight.sh:
#   e03 checks the preconditions **inside the source repo** (RPC/DSN/registry files) and answers "can we start building a transaction";
#   this script checks a **remote deployed instance** and answers "can this deployment start a drill".
#   They cover different things; mixing them makes "this machine has no DSN configured" indistinguishable from "staging is down".
#
# Safety rules:
#   - **Read-only**: only HTTP GET, and only to ops/read-only endpoints; no building, signing, or broadcasting;
#   - **Never print an API Key**: only report "is set / is not set", and on failure only echo the HTTP status;
#   - Missing means fail-closed (exit code 1); no guessing, no downgrading;
#   - Auth is verified in **reverse**: hitting /v1/chains without a Key must return 401 — if staging missed the auth config,
#     this script must catch it, or the conclusions of the whole drill would not hold.
#
# Usage:
#   export DFR_STAGING_BASE_URL='https://dfr-staging.example'
#   export DFR_STAGING_API_KEY='dfr_<keyId>_<secret>'   # Environment variables only; never in a file or command line
#   ./scripts/staging-preflight.sh
#
# Optional:
#   DFR_STAGING_EXPECT_CHAINS='base-sepolia,arbitrum-sepolia'  # Comma-separated; a missing chain fails the check
#   DFR_STAGING_SKIP_METRICS=1                                 # Skip the /metrics check this round
#   DFR_STAGING_TIMEOUT_S=10                                   # Per-request timeout
#
# Exit codes: 0 = READY; 1 = something is missing; 2 = usage error (a required variable is missing).
set -uo pipefail

FAILED=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
hint() { printf '      → %s\n' "$1"; }
head_() { printf '\n%s\n' "$1"; }

BASE="${DFR_STAGING_BASE_URL:-}"
KEY="${DFR_STAGING_API_KEY:-}"
TIMEOUT="${DFR_STAGING_TIMEOUT_S:-10}"
EXPECT_CHAINS="${DFR_STAGING_EXPECT_CHAINS:-}"
AUTH_HEADER_FILE=''

cleanup() {
  if [ -n "${AUTH_HEADER_FILE}" ]; then
    rm -f "${AUTH_HEADER_FILE}"
  fi
}
trap cleanup EXIT INT TERM

head_ 'DFR staging preflight check'

# ---------------------------------------------------------------------------
# 0. Required inputs
# ---------------------------------------------------------------------------
head_ '0) Inputs'
if [ -z "${BASE}" ]; then
  bad 'DFR_STAGING_BASE_URL is not set'
  hint "Point at the staging instance root URL (no trailing slash), e.g. https://dfr-staging.example"
  printf '\n  \033[31mNOT READY\033[0m: required input is missing.\n'
  exit 2
fi
if [ -z "${KEY}" ]; then
  bad 'DFR_STAGING_API_KEY is not set'
  hint 'Environment variables only (never in files or command history); of the form dfr_<8-char keyId>_<secret>'
  printf '\n  \033[31mNOT READY\033[0m: required input is missing.\n'
  exit 2
fi
BASE="${BASE%/}"
ok "DFR_STAGING_BASE_URL is set (${BASE})"
ok 'DFR_STAGING_API_KEY is set (value is not echoed)'

# Do not expand the Key into curl argv: a party on the same machine that can see process arguments must not be able to read the credential during the request window.
# curl @file syntax reads the full header line; the filename itself contains no Key, and the file is always deleted on exit.
AUTH_HEADER_FILE="$(mktemp -t dfr-staging-header.XXXXXX)"
chmod 600 "${AUTH_HEADER_FILE}"
printf 'X-DFR-Key: %s\n' "${KEY}" > "${AUTH_HEADER_FILE}"

# Get the HTTP status code; curl unavailable or timed out returns 000.
status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" "$@" 2>/dev/null || printf '000'
}
# Get the response body (for JSON parsing); on failure return an empty string.
body_of() {
  curl -s --max-time "${TIMEOUT}" "$@" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 1. Liveness: /healthz needs no auth and checks no dependencies
# ---------------------------------------------------------------------------
head_ '1) Liveness (GET /healthz)'
code="$(status_of "${BASE}/healthz")"
if [ "${code}" = '200' ]; then
  ok '/healthz 200 (process is alive)'
else
  bad "/healthz returned ${code} (expected 200)"
  hint 'The process is not up or is not accepting connections; check container status and startup logs before talking about a drill'
fi

# ---------------------------------------------------------------------------
# 2. Readiness: /readyz distinguishes "alive" from "able to take traffic"
# ---------------------------------------------------------------------------
head_ '2) Readiness (GET /readyz)'
ready_body="$(body_of "${BASE}/readyz")"
code="$(status_of "${BASE}/readyz")"
if [ "${code}" = '200' ]; then
  ok '/readyz 200 (dependencies are ready)'
elif [ "${code}" = '503' ]; then
  bad '/readyz 503 (process is alive but dependencies are not ready)'
  hint 'When a dependency fails the process stays alive but takes no traffic — this is designed behavior, not a crash'
else
  bad "/readyz returned ${code} (expected 200 or 503)"
fi

# Parse the JSON in place (node is already in the repo toolchain; no jq, to avoid an extra dependency).
if [ -n "${ready_body}" ]; then
  printf '%s' "${ready_body}" | node -e '
    let raw="";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let body; try { body = JSON.parse(raw); } catch { process.exit(2); }
      const chains = Array.isArray(body.chains) ? body.chains : [];
      // Semantic distinction (honest wording):
      //   providers > 0 and available == 0 -> configured but all unavailable (a real failure; block it)
      //   providers == 0                -> no endpoint configured for this chain (informational, not a failure)
      // Treating "unconfigured" as a failure makes the script report NOT READY for a healthy deployment, and the operator goes chasing a problem that does not exist.
      const down = chains.filter((c) => (c.providers ?? 0) > 0 && (c.available ?? 0) === 0);
      const unconfigured = chains.filter((c) => (c.providers ?? 0) === 0);
      const stores = body.stores;
      if (stores && stores !== "ok" && stores !== "not_configured") {
        console.log(`STORES:${stores}`);
      }
      for (const c of down) console.log(`DOWN:${c.chain}`);
      for (const c of unconfigured) console.log(`UNCONFIGURED:${c.chain}`);
      console.log(`CHAINS:${chains.map((c) => c.chain).join(",")}`);
    });
  ' > /tmp/dfr-staging-ready.txt 2>/dev/null || true
fi

if [ -f /tmp/dfr-staging-ready.txt ]; then
  stores_line="$(grep '^STORES:' /tmp/dfr-staging-ready.txt | head -1 | cut -d: -f2-)"
  if [ -n "${stores_line}" ]; then
    bad "Transaction store is unavailable (stores=${stores_line})"
    hint 'The M1 write path requires a persistent Store; staging must fix store connectivity before the drill'
  else
    ok 'Transaction store is ready (or this deployment is read-only with no Store configured)'
  fi

  down="$(grep '^DOWN:' /tmp/dfr-staging-ready.txt | cut -d: -f2- | tr '\n' ',' | sed 's/,$//')"
  unconfigured="$(grep '^UNCONFIGURED:' /tmp/dfr-staging-ready.txt | cut -d: -f2- | tr '\n' ',' | sed 's/,$//')"
  listed="$(grep '^CHAINS:' /tmp/dfr-staging-ready.txt | head -1 | cut -d: -f2-)"
  if [ -n "${down}" ]; then
    bad "The following chains have Providers configured but all are unavailable: ${down}"
    hint 'Before the drill, confirm the endpoints of these chains are reachable; if only some chains are unavailable, narrow the drill scope accordingly'
  elif [ -n "${listed}" ]; then
    ok "Ready chains: ${listed}"
  fi
  if [ -n "${unconfigured}" ]; then
    ok "Chains with no configured endpoints (informational, not a failure): ${unconfigured}"
  fi
  rm -f /tmp/dfr-staging-ready.txt
fi

# Every expected chain must be listed (a missing chain leaves the agreed drill scope uncovered).
if [ -n "${EXPECT_CHAINS}" ]; then
  missing=''
  IFS=',' read -r -a want <<< "${EXPECT_CHAINS}"
  for chain in "${want[@]}"; do
    chain="$(printf '%s' "${chain}" | tr -d '[:space:]')"
    [ -z "${chain}" ] && continue
    if ! printf '%s' "${ready_body}" | grep -q "\"${chain}\""; then
      missing="${missing}${chain},"
    fi
  done
  if [ -n "${missing}" ]; then
    bad "Expected chains missing: ${missing%,}"
    hint 'Check DFR_DEPLOY_MILESTONE and the registry; M4+ chains only load with an explicit milestone'
  else
    ok "Expected chains are all present: ${EXPECT_CHAINS}"
  fi

  head_ '2b) Expected chain details (GET /v1/chains/{chain}, with Key)'
  IFS=',' read -r -a detail_want <<< "${EXPECT_CHAINS}"
  for chain in "${detail_want[@]}"; do
    chain="$(printf '%s' "${chain}" | tr -d '[:space:]')"
    [ -z "${chain}" ] && continue
    detail_code="$(status_of -H "@${AUTH_HEADER_FILE}" "${BASE}/v1/chains/${chain}")"
    if [ "${detail_code}" = '200' ]; then
      ok "${chain} details 200"
    else
      bad "${chain} details returned ${detail_code} (expected 200)"
      hint 'The chain list exists, but reading the details failed; fix the deployment or routing for this chain before the drill'
    fi
  done
fi

# ---------------------------------------------------------------------------
# 3. Auth **reverse** check: no Key must give 401
# ---------------------------------------------------------------------------
head_ '3) Auth (reverse check)'
code="$(status_of "${BASE}/v1/chains")"
if [ "${code}" = '401' ]; then
  ok 'Accessing /v1/chains without a Key -> 401 (auth is actually enforced)'
else
  bad "Accessing /v1/chains without a Key returned ${code} (expected 401)"
  hint 'This is a **must-block** problem: missing auth config invalidates the conclusions of the whole drill'
fi

# ---------------------------------------------------------------------------
# 4. Read-only surface: fetch the chain list with a Key
# ---------------------------------------------------------------------------
head_ '4) Read-only surface (GET /v1/chains, with Key)'
chains_body="$(body_of -H "@${AUTH_HEADER_FILE}" "${BASE}/v1/chains")"
code="$(status_of -H "@${AUTH_HEADER_FILE}" "${BASE}/v1/chains")"
if [ "${code}" = '200' ]; then
  count="$(printf '%s' "${chains_body}" | node -e '
    let raw=""; process.stdin.on("data",(c)=>(raw+=c));
    process.stdin.on("end",()=>{ try { const b=JSON.parse(raw); console.log(Array.isArray(b.items)?b.items.length:0);} catch { console.log("ERR"); } });
  ' 2>/dev/null || printf 'ERR')"
  if [ "${count}" = 'ERR' ]; then
    bad 'Chain list is not a valid JSON object (response shape does not match the contract)'
    hint 'Per the ADR-009 contract, it should be {items:[...], requestId}'
  elif [ "${count}" = '0' ]; then
    bad 'Chain list is empty (no visible chains; there is nothing to drill against)'
    hint 'Check registry loading and the milestone switches; an empty list usually means the configuration did not take effect'
  else
    ok "Chain list returned ${count} entries"
  fi
else
  bad "/v1/chains returned ${code} (expected 200)"
  hint 'The Key may be invalid/expired, or its scope may not allow reads; see dfr_code in the response for the error code'
fi

# ---------------------------------------------------------------------------
# 5. Metrics: require auth and include the agreed metric families
# ---------------------------------------------------------------------------
if [ "${DFR_STAGING_SKIP_METRICS:-0}" = '1' ]; then
  head_ '5) Metrics (skipped per DFR_STAGING_SKIP_METRICS=1)'
else
  head_ '5) Metrics (GET /metrics, with Key)'
  code_noauth="$(status_of "${BASE}/metrics")"
  if [ "${code_noauth}" = '401' ]; then
    ok '/metrics without a Key -> 401 (the metrics endpoint is covered by auth)'
  else
    bad "/metrics without a Key returned ${code_noauth} (expected 401)"
    hint 'Metrics include usage and link topology; without auth they would leak operational information'
  fi

  code="$(status_of -H "@${AUTH_HEADER_FILE}" "${BASE}/metrics")"
  if [ "${code}" = '200' ]; then
    # Write to a temp file and grep it; **do not** `printf ... | grep -q`:
    # The metrics body can be tens of KB; `grep -q` exits as soon as it matches,
    # which gives printf a SIGPIPE, and under `set -o pipefail` the whole pipeline
    # returns non-zero — so "the metric clearly exists" is judged missing.
    # This was a false failure found on 2026-10-08 while testing against a real instance (75KB response).
    metrics_file="$(mktemp)"
    body_of -H "@${AUTH_HEADER_FILE}" "${BASE}/metrics" > "${metrics_file}"
    missing=''
    for family in dfr_gateway_requests_total dfr_gateway_inflight_requests; do
      grep -q "^${family}" "${metrics_file}" || missing="${missing}${family},"
    done
    if [ -n "${missing}" ]; then
      bad "Metric families missing: ${missing%,}"
      hint 'Prometheus cannot scrape the key metrics, so the drill would run blind'
    else
      lines="$(grep -cE '^[a-z]' "${metrics_file}" || true)"
      ok "/metrics 200, ${lines} sample lines (key metric families are all present)"
    fi
    rm -f "${metrics_file}"
  else
    bad "/metrics returned ${code} (expected 200)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
head_ 'Summary'
if [ "${FAILED}" -eq 0 ]; then
  printf '  \033[32mREADY\033[0m: staging preflight is complete; start the drill per docs/runbooks/staging-drill.md.\n'
  printf '  Next: work through runbook §3 item by item, and write the evidence into docs/development/deliveries/DFR-M5-E01.md.\n'
  exit 0
fi

printf '  \033[31mNOT READY\033[0m: there are missing items (see above). The drill must not start, and offline tests must not be substituted.\n'
exit 1
