#!/usr/bin/env bash
# DFR secret scanner (self-contained; depends on no third-party action or external script)
#
# See docs/adr/ADR-007-signing-model.md and chapter 24 of the requirements.
# Purpose: keep private keys, mnemonics, API keys, and tokens out of the
# repository.
#
# Compatible with macOS's bundled bash 3.2:
#   - No mapfile / associative arrays
#   - A variable name next to Chinese punctuation must be written as ${VAR},
#     otherwise bash 3.2 in a multibyte locale merges the punctuation into
#     the variable name (this once caused an unbound variable error)
#
# Scan scope:
#   - Inside a git work tree: scan only files that would be committed
#     (tracked + untracked but not excluded by .gitignore)
#   - Outside a git work tree: scan all files rooted at the current
#     directory (for tarball deployment scenarios)
#     This is necessary; otherwise the security scan would silently pass —
#     a false negative is more dangerous than an error
#
# Exit codes: 0 = clean; 1 = a suspicious pattern matched, or the safe scan
# scope could not be determined.
set -euo pipefail

# ---------------------------------------------------------------------------
# Directory resolution: never blindly apply ".." to the script location, to
# avoid accidentally scanning directories outside the repository
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  cd "${REPO_ROOT}"
  USE_GIT=1
  SCAN_SCOPE="git tracked scope"
else
  # Not inside a git work tree. Require the current directory to look like
  # a repository root (contains package.json); otherwise refuse to run
  # instead of guessing and possibly scanning unrelated directories.
  if [ ! -f "./package.json" ]; then
    echo "check-secrets: not in a git work tree, and the current directory has no package.json." >&2
    echo "check-secrets: run from the repository root, or git clone/checkout first." >&2
    exit 1
  fi
  USE_GIT=0
  SCAN_SCOPE="full current directory (not a git work tree)"
fi

EXCLUDE_RE='\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|eot|pdf|zip|gz|tgz|apk|jar|lock)$'

if [ "${USE_GIT}" -eq 1 ]; then
  file_list=$(git ls-files --cached --others --exclude-standard | grep -Ev "${EXCLUDE_RE}" || true)
else
  file_list=$(find . -type f \
    -not -path './node_modules/*' \
    -not -path './.git/*' \
    -not -path './dist/*' \
    -not -path './coverage/*' \
    -not -path './.turbo/*' \
    | sed 's|^\./||' | grep -Ev "${EXCLUDE_RE}" || true)
fi

# The scanner itself necessarily contains pattern text and exception-marker
# syntax, so it cannot scan itself. This is the only unconditionally excluded
# file, and the exclusion is hardcoded and reviewable.
file_list=$(printf '%s\n' "${file_list}" | grep -v '^scripts/check-secrets.sh$' || true)

if [ -z "${file_list}" ]; then
  echo "check-secrets: no scannable files found (scope: ${SCAN_SCOPE})." >&2
  echo "check-secrets: to avoid a security false negative, this counts as failure." >&2
  exit 1
fi

count=$(printf '%s\n' "${file_list}" | wc -l | tr -d ' ')

# Explicit exception markers.
#
# An exception must be **per-line, explicit, and reasoned**:
# `secret-scan:allow <reason>`. Unconditional whole-line skipping would let
# the scan degenerate into "looks like a pass", so a marker must be followed
# by a reason of >= 3 characters; otherwise the line is still treated as a
# hit (see the ALLOW_WITHOUT_REASON check below).
#
# Use cases only: public on-chain hashes (block/transaction), and fake
# credentials constructed specifically for "redaction regression" tests.
ALLOW_RE='secret-scan:allow[[:space:]]+[A-Za-z0-9_-]{3,}'
MARKER_RE='secret-scan:allow'

# Search the file set for a pattern, printing "line number:content".
# Lines carrying a valid exception marker are excluded — so exceptions are
# greppable and reviewable.
scan() {
  printf '%s\n' "${file_list}" | while IFS= read -r f; do
    [ -f "${f}" ] || continue
    grep -InE "$1" "${f}" 2>/dev/null | grep -Ev "${ALLOW_RE}" | sed "s|^|${f}:|" || true
  done
}

MAX_HITS=20

# Exception markers must carry a reason: a bare secret-scan:allow with no
# reason → failure.
marker_without_reason=$(scan "${MARKER_RE}" | grep -Ev "${ALLOW_RE}" || true)
if [ -n "${marker_without_reason}" ]; then
  echo "✗ Found secret-scan:allow markers without a reason (must be written as 'secret-scan:allow <reason>'):" >&2
  printf '%s\n' "${marker_without_reason}" | head -"${MAX_HITS}" >&2
  exit 1
fi

patterns='0x[0-9a-fA-F]{64}\b|BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'

failed=0

hits=$(scan "${patterns}")
if [ -n "${hits}" ]; then
  echo "✗ Matched suspicious secret patterns:" >&2
  printf '%s\n' "${hits}" | head -"${MAX_HITS}" >&2
  total=$(printf '%s\n' "${hits}" | wc -l | tr -d ' ')
  if [ "${total}" -gt "${MAX_HITS}" ]; then
    echo "  ... (${total} total, showing first ${MAX_HITS})" >&2
  fi
  failed=1
fi

# Secret-type fields assigned a concrete value (excluding obvious placeholders)
assign_pattern='(private[_-]?key|mnemonic|seed[_-]?phrase|secret[_-]?key|api[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{12,}["'"'"']'
assign_hits=$(scan "${assign_pattern}" \
  | grep -viE 'placeholder|example|redacted|xxx|your[-_]|dummy|fake|CHANGEME|test test test' || true)
if [ -n "${assign_hits}" ]; then
  echo "✗ Matched secret-type fields with concrete values:" >&2
  printf '%s\n' "${assign_hits}" | head -"${MAX_HITS}" >&2
  failed=1
fi

if [ "${failed}" -ne 0 ]; then
  echo >&2
  echo "check-secrets: FAILED. Remove the content above, or use an env:/vault: reference instead (see packages/registry/config/README.md)." >&2
  exit 1
fi

echo "check-secrets: passed (${count} files, scope: ${SCAN_SCOPE})"
