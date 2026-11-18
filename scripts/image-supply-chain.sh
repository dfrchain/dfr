#!/usr/bin/env bash
# DFR image supply-chain gate (M1-E02 supply-chain supplement)
#
# Purpose: generate an SBOM and run a vulnerability scan for the Gateway
# runtime image, as an **explicit** gate.
#
# Why it is not part of `pnpm verify`: scanning needs the trivy
# vulnerability database (downloaded over the network) and a local Docker
# daemon, while `pnpm verify` must be reproducible offline. Same convention
# as `pnpm test:db`: run explicitly when needed.
#
# Usage:
#   ./scripts/image-supply-chain.sh              # build → SBOM → scan (fails if any HIGH/CRITICAL)
#   DFR_SKIP_BUILD=1 ./scripts/image-supply-chain.sh   # reuse the already built image
#
# Exit codes: 0 = no HIGH/CRITICAL; 1 = findings or missing tools.
#
# Artifacts are written to infrastructure/docker/sbom/ (excluded by
# .gitignore; generated output).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
cd "${REPO_ROOT}"

IMAGE="${DFR_IMAGE_TAG:-dfr-gateway:m1}"
DOCKERFILE="infrastructure/docker/gateway.Dockerfile"
OUT_DIR="infrastructure/docker/sbom"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "image-supply-chain: missing tool $1" >&2
    exit 1
  fi
}

require docker
require trivy

echo "image-supply-chain: building image ${IMAGE}"
if [ "${DFR_SKIP_BUILD:-0}" != "1" ]; then
  docker build -f "${DOCKERFILE}" -t "${IMAGE}" .
else
  echo "image-supply-chain: DFR_SKIP_BUILD=1, reusing the existing image"
fi

mkdir -p "${OUT_DIR}"

# CycloneDX SBOM: both a deliverable and an auditable inventory of "what is
# actually in the image". The reason it catches problems like "pnpm was left
# in the runtime image" is precisely that the SBOM enumerates every
# component, not just the dependencies we declare in package.json.
echo "image-supply-chain: generating SBOM (CycloneDX)"
trivy image --format cyclonedx --output "${OUT_DIR}/dfr-gateway.cdx.json" \
  --skip-version-check "${IMAGE}"

echo "image-supply-chain: scanning for HIGH/CRITICAL vulnerabilities"
set +e
trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 \
  --skip-version-check --format table "${IMAGE}"
STATUS=$?
set -e

if [ ${STATUS} -ne 0 ]; then
  echo "" >&2
  echo "image-supply-chain: found HIGH/CRITICAL vulnerabilities (exit code ${STATUS})" >&2
  echo "image-supply-chain: remediation principles —" >&2
  echo "  1. Prefer **removing** the component that introduces the vulnerability (e.g. an unused build tool) over adding an exemption;" >&2
  echo "  2. When it genuinely cannot be removed, record the CVE / component / reachability assessment / remediation deadline in the delivery report;" >&2
  echo "  3. Never relax severity or skip the scan just to make the gate green." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# License check
#
# Policy (why only Node dependencies are checked):
#   - This project is a private, closed-source product (the root package.json
#     is UNLICENSED). A copyleft or source-available license such as
#     GPL/AGPL/SSPL/BUSL appearing among the JS dependencies would create a
#     **real** distribution-obligation problem, so it must be blocked.
#   - The Alpine base image's OS packages carry GPL/LGPL themselves
#     (musl/busybox, etc.); that is normal for every Linux base image, not a
#     distribution decision of this project, so they are only reported, not
#     blocked (otherwise the gate would be permanently red).
#   - This project's own packages are marked UNLICENSED, as expected; not blocked.
# ---------------------------------------------------------------------------
echo "image-supply-chain: checking Node dependency licenses"
trivy image --scanners license --skip-version-check --format json \
  --output "${OUT_DIR}/dfr-gateway.licenses.json" "${IMAGE}"

set +e
node -e '
const fs = require("node:fs");
const path = process.argv[1];
const report = JSON.parse(fs.readFileSync(path, "utf8"));

// Blocking applies only to Node dependencies (node-pkg / our JS packages); OS packages are only counted.
const DENY = /(^|[^A-Za-z])(A?GPL|SSPL|BUSL|BSL|Commons-Clause|Elastic|CC-BY-NC)/i;
const summaries = {};
const violations = [];

for (const result of report.Results ?? []) {
  const target = result.Target ?? "?";
  const isNodeDep = String(target).startsWith("Node.js") || /node_modules/.test(target);
  for (const license of result.Licenses ?? []) {
    const name = license.Name ?? "UNKNOWN";
    summaries[name] = (summaries[name] ?? 0) + 1;
    // Our own private packages are UNLICENSED, as expected.
    if (name === "UNLICENSED") continue;
    if (isNodeDep && DENY.test(name)) {
      violations.push(`${name} <- ${target}${license.FilePath ? " : " + license.FilePath : ""}`);
    }
  }
}

const ordered = Object.entries(summaries).sort((a, b) => b[1] - a[1]);
process.stdout.write(
  "image-supply-chain: license summary " +
    ordered.map(([name, count]) => `${name}x${count}`).join(", ") +
    "\n",
);

if (violations.length > 0) {
  process.stderr.write(
    "image-supply-chain: Node dependencies contain a prohibited copyleft / source-available license:\n" +
      violations.map((v) => "  " + v).join("\n") +
      "\n",
  );
  process.exit(1);
}
' "${OUT_DIR}/dfr-gateway.licenses.json"
LICENSE_STATUS=$?
set -e

if [ ${LICENSE_STATUS} -ne 0 ]; then
  echo "image-supply-chain: license check failed" >&2
  exit 1
fi

echo "image-supply-chain: passed (no HIGH/CRITICAL vulnerabilities; no copyleft in Node dependencies)"
echo "image-supply-chain: SBOM written to ${OUT_DIR}/dfr-gateway.cdx.json"
