#!/usr/bin/env bash
# DFR 镜像供应链门禁（M1-E02 供应链补充）
#
# 用途：对 Gateway 运行镜像做 SBOM 生成与漏洞扫描，作为**显式**门禁。
#
# 为什么不进 `pnpm verify`：扫描需要 trivy 漏洞库（联网下载）与本地 Docker 守护进程，
# 而 `pnpm verify` 必须离线可复现。与 `pnpm test:db` 同一约定：按需显式运行。
#
# 用法：
#   ./scripts/image-supply-chain.sh              # 构建 → SBOM → 扫描（HIGH/CRITICAL 有则失败）
#   DFR_SKIP_BUILD=1 ./scripts/image-supply-chain.sh   # 复用已构建镜像
#
# 退出码：0 = 无 HIGH/CRITICAL；1 = 有发现或工具缺失。
#
# 产物写入 infrastructure/docker/sbom/（已被 .gitignore 排除，属生成物）。
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
cd "${REPO_ROOT}"

IMAGE="${DFR_IMAGE_TAG:-dfr-gateway:m1}"
DOCKERFILE="infrastructure/docker/gateway.Dockerfile"
OUT_DIR="infrastructure/docker/sbom"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "image-supply-chain: 缺少工具 $1" >&2
    exit 1
  fi
}

require docker
require trivy

echo "image-supply-chain: 构建镜像 ${IMAGE}"
if [ "${DFR_SKIP_BUILD:-0}" != "1" ]; then
  docker build -f "${DOCKERFILE}" -t "${IMAGE}" .
else
  echo "image-supply-chain: DFR_SKIP_BUILD=1，复用已有镜像"
fi

mkdir -p "${OUT_DIR}"

# CycloneDX SBOM：既是交付物，也是"镜像里到底有什么"的可审计清单。
# 之所以它能发现"pnpm 被留在运行镜像里"这类问题，正是因为 SBOM 枚举了全部组件，
# 而不只是我们在 package.json 里声明的依赖。
echo "image-supply-chain: 生成 SBOM（CycloneDX）"
trivy image --format cyclonedx --output "${OUT_DIR}/dfr-gateway.cdx.json" \
  --skip-version-check "${IMAGE}"

echo "image-supply-chain: 扫描 HIGH/CRITICAL 漏洞"
set +e
trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 \
  --skip-version-check --format table "${IMAGE}"
STATUS=$?
set -e

if [ ${STATUS} -ne 0 ]; then
  echo "" >&2
  echo "image-supply-chain: 发现 HIGH/CRITICAL 漏洞（退出码 ${STATUS}）" >&2
  echo "image-supply-chain: 处置原则——" >&2
  echo "  1. 优先**移除**引入漏洞的组件（例如未使用的构建工具），而不是加豁免；" >&2
  echo "  2. 确实无法移除时，必须在交付报告中记录 CVE / 组件 / 可达性判断 / 处置期限；" >&2
  echo "  3. 不得为了让门禁变绿而放宽 severity 或跳过扫描。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 许可证检查
#
# 策略（为什么只查 Node 依赖）：
#   - 本项目是私有的闭源产品（根 package.json 为 UNLICENSED）。JS 依赖里出现
#     GPL/AGPL/SSPL/BUSL 这类 copyleft 或源码可得许可，会构成**真实的**分发义务问题，
#     因此必须拦截。
#   - Alpine 基础镜像的 OS 包自带 GPL/LGPL（musl/busybox 等），这是所有 Linux 基础
#     镜像的常态，不是本项目的分发决策，因此只报告、不拦截（否则门禁恒假红）。
#   - 本项目自己的包标 UNLICENSED，属预期，不拦截。
# ---------------------------------------------------------------------------
echo "image-supply-chain: 检查 Node 依赖许可证"
trivy image --scanners license --skip-version-check --format json \
  --output "${OUT_DIR}/dfr-gateway.licenses.json" "${IMAGE}"

set +e
node -e '
const fs = require("node:fs");
const path = process.argv[1];
const report = JSON.parse(fs.readFileSync(path, "utf8"));

// 只对 Node 依赖（node-pkg / 我们的 JS 包）施加拦截；OS 包仅统计。
const DENY = /(^|[^A-Za-z])(A?GPL|SSPL|BUSL|BSL|Commons-Clause|Elastic|CC-BY-NC)/i;
const summaries = {};
const violations = [];

for (const result of report.Results ?? []) {
  const target = result.Target ?? "?";
  const isNodeDep = String(target).startsWith("Node.js") || /node_modules/.test(target);
  for (const license of result.Licenses ?? []) {
    const name = license.Name ?? "UNKNOWN";
    summaries[name] = (summaries[name] ?? 0) + 1;
    // 我们自己的私有包是 UNLICENSED，属预期。
    if (name === "UNLICENSED") continue;
    if (isNodeDep && DENY.test(name)) {
      violations.push(`${name} <- ${target}${license.FilePath ? " : " + license.FilePath : ""}`);
    }
  }
}

const ordered = Object.entries(summaries).sort((a, b) => b[1] - a[1]);
process.stdout.write(
  "image-supply-chain: 许可证汇总 " +
    ordered.map(([name, count]) => `${name}x${count}`).join(", ") +
    "\n",
);

if (violations.length > 0) {
  process.stderr.write(
    "image-supply-chain: Node 依赖出现禁止的 copyleft / 源码可得许可：\n" +
      violations.map((v) => "  " + v).join("\n") +
      "\n",
  );
  process.exit(1);
}
' "${OUT_DIR}/dfr-gateway.licenses.json"
LICENSE_STATUS=$?
set -e

if [ ${LICENSE_STATUS} -ne 0 ]; then
  echo "image-supply-chain: 许可证检查未通过" >&2
  exit 1
fi

echo "image-supply-chain: 通过（无 HIGH/CRITICAL 漏洞；Node 依赖无 copyleft）"
echo "image-supply-chain: SBOM 已写入 ${OUT_DIR}/dfr-gateway.cdx.json"
