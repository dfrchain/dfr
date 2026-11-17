#!/usr/bin/env bash
# DFR OpenAPI 语义门禁（DFR-M1-A03）
#
# 见 docs/architecture/m1-api-contract.md 第 7 节：
#   - 不可只检查 `$ref` 可解析，必须执行语义 lint；
#   - 规格唯一来源是 docs/api/openapi.yaml。
#
# 用法：
#   ./scripts/lint-openapi.sh [spec-path]
#     spec-path 省略时使用 docs/api/openapi.yaml；
#     传入路径用于负对照（见 tests/contract/openapi-lint.test.ts）。
#
# 退出码：
#   0 = 通过（允许 warning，warning 清单在交付报告中登记）
#   1 = 发现 error，或规格/工具不可用
#
# 本脚本按仓库既有约定实现：自包含、不依赖第三方 action，
# 只调用 package.json 中固定精确版本的 @redocly/cli。
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
cd "${REPO_ROOT}"

SPEC="${1:-docs/api/openapi.yaml}"

if [ ! -f "${SPEC}" ]; then
  echo "lint-openapi: 找不到规格文件 ${SPEC}" >&2
  exit 1
fi

REDOCLY="./node_modules/.bin/redocly"
if [ ! -x "${REDOCLY}" ]; then
  echo "lint-openapi: 缺少 @redocly/cli。" >&2
  echo "lint-openapi: 请先执行 pnpm install --frozen-lockfile" >&2
  exit 1
fi

# 配置固定在仓库根 redocly.yaml；显式传入，避免受 cwd 或用户级配置影响。
exec "${REDOCLY}" lint --config redocly.yaml "${SPEC}"
