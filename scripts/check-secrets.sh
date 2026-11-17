#!/usr/bin/env bash
# DFR 密钥扫描（自包含，不依赖任何第三方 action 或外部脚本）
#
# 见 docs/adr/ADR-007-signing-model.md 与需求第 24 章。
# 目的：阻止私钥、助记词、API Key、Token 进入版本库。
#
# 兼容 macOS 自带的 bash 3.2：
#   - 不使用 mapfile / 关联数组
#   - 变量名紧邻中文标点时必须写成 ${VAR}，否则 bash 3.2 在多字节环境下
#     会把标点误并入变量名（曾导致 unbound variable 错误）
#
# 扫描范围：
#   - 在 git 工作树中：只扫描会被提交的文件（已跟踪 + 未跟踪但未被 .gitignore 排除）
#   - 不在 git 工作树中：以当前目录为根扫描全部文件（用于 tar 包部署场景）
#     这是必要的，否则安全扫描会静默通过 —— 假阴性比报错更危险
#
# 退出码：0 = 干净；1 = 命中可疑模式，或无法确定安全的扫描范围。
set -euo pipefail

# ---------------------------------------------------------------------------
# 目录解析：绝不盲目对脚本位置做 ".."，避免误扫到仓库之外的目录
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

if REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  cd "${REPO_ROOT}"
  USE_GIT=1
  SCAN_SCOPE="git 跟踪范围"
else
  # 不在 git 工作树中。要求当前目录看起来像仓库根（含 package.json），
  # 否则拒绝运行，而不是猜测并可能扫描无关目录。
  if [ ! -f "./package.json" ]; then
    echo "check-secrets: 不在 git 工作树中，且当前目录没有 package.json。" >&2
    echo "check-secrets: 请在仓库根目录运行，或先 git clone/checkout。" >&2
    exit 1
  fi
  USE_GIT=0
  SCAN_SCOPE="当前目录全量（非 git 工作树）"
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

# 扫描器自身必然包含模式文本与例外标记语法，不能自我扫描。
# 这是唯一被无条件排除的文件，且排除是硬编码的、可 review 的。
file_list=$(printf '%s\n' "${file_list}" | grep -v '^scripts/check-secrets.sh$' || true)

if [ -z "${file_list}" ]; then
  echo "check-secrets: 未找到可扫描的文件（范围：${SCAN_SCOPE}）。" >&2
  echo "check-secrets: 为避免安全假阴性，此处判定为失败。" >&2
  exit 1
fi

count=$(printf '%s\n' "${file_list}" | wc -l | tr -d ' ')

# 显式例外标记。
#
# 例外必须是**逐行、显式、带理由**的：`secret-scan:allow <reason>`。
# 无条件整行跳过会让扫描退化成"看着像通过"，因此标记后必须跟 >=3 字符的理由，
# 否则该行仍然按命中处理（见下方 ALLOW_WITHOUT_REASON 检查）。
#
# 使用场景仅限：公开链上哈希（区块/交易）、以及专门为"脱敏回归"构造的假凭证。
ALLOW_RE='secret-scan:allow[[:space:]]+[A-Za-z0-9_-]{3,}'
MARKER_RE='secret-scan:allow'

# 在待扫描文件集合中搜索模式，输出 "行号:内容"。
# 带合法例外标记的行被排除 —— 例外因此是可 grep、可 review 的。
scan() {
  printf '%s\n' "${file_list}" | while IFS= read -r f; do
    [ -f "${f}" ] || continue
    grep -InE "$1" "${f}" 2>/dev/null | grep -Ev "${ALLOW_RE}" | sed "s|^|${f}:|" || true
  done
}

MAX_HITS=20

# 例外标记必须带理由：只写 secret-scan:allow 而没有理由 → 判定为失败。
marker_without_reason=$(scan "${MARKER_RE}" | grep -Ev "${ALLOW_RE}" || true)
if [ -n "${marker_without_reason}" ]; then
  echo "✗ 发现缺少理由的 secret-scan:allow 标记（必须写成 'secret-scan:allow <reason>'）：" >&2
  printf '%s\n' "${marker_without_reason}" | head -"${MAX_HITS}" >&2
  exit 1
fi

patterns='0x[0-9a-fA-F]{64}\b|BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.'

failed=0

hits=$(scan "${patterns}")
if [ -n "${hits}" ]; then
  echo "✗ 命中可疑密钥模式：" >&2
  printf '%s\n' "${hits}" | head -"${MAX_HITS}" >&2
  total=$(printf '%s\n' "${hits}" | wc -l | tr -d ' ')
  if [ "${total}" -gt "${MAX_HITS}" ]; then
    echo "  ...（共 ${total} 处，仅显示前 ${MAX_HITS} 处）" >&2
  fi
  failed=1
fi

# 密钥类字段被赋了具体值（排除明显的占位符）
assign_pattern='(private[_-]?key|mnemonic|seed[_-]?phrase|secret[_-]?key|api[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{12,}["'"'"']'
assign_hits=$(scan "${assign_pattern}" \
  | grep -viE 'placeholder|example|redacted|xxx|your[-_]|dummy|fake|CHANGEME|test test test' || true)
if [ -n "${assign_hits}" ]; then
  echo "✗ 命中带具体值的密钥类字段：" >&2
  printf '%s\n' "${assign_hits}" | head -"${MAX_HITS}" >&2
  failed=1
fi

if [ "${failed}" -ne 0 ]; then
  echo >&2
  echo "check-secrets: 失败。请移除上述内容，或改用 env:/vault: 引用（见 packages/registry/config/README.md）。" >&2
  exit 1
fi

echo "check-secrets: 通过（${count} 个文件，范围：${SCAN_SCOPE}）"
