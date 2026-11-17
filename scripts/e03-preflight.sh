#!/usr/bin/env bash
# DFR M1-E03 前置检查（真实 Sepolia 广播验收）
#
# 用途：在执行 E03（真实链广播验收）之前，一次性验证全部前置条件，并给出**可执行**的
# 缺失项提示。它是"人工在环"流程的第一步：只有本脚本报 READY，才应继续构造交易。
#
# 安全约定（与 runbook 一致）：
#   - 本脚本**只读**：只发 eth_chainId（只读）与一个数据库连通性查询；不构造、不签名、不广播；
#   - **绝不打印任何凭证值**，只报告"已设置/未设置"与长度无关的判定；
#   - 缺失即 fail-closed（退出码 1），不猜测、不降级。
#
# 用法：
#   set -a; . ./e03.env; set +a      # 在 shell 里导出前置变量（该文件不入库）
#   ./scripts/e03-preflight.sh
#   DFR_E03_SKIP_DB=1 ./scripts/e03-preflight.sh   # 只验证 RPC 与注册表
#
# 退出码：0 = 全部通过；1 = 有缺失项。
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

head_ 'E03 前置检查'

# ---------------------------------------------------------------------------
# 1. 必需环境变量（只报存在性，绝不打印值）
# ---------------------------------------------------------------------------
head_ '1) 环境变量'
require_env() {
  local name="$1" why="$2"
  if [ -n "${!name:-}" ]; then
    ok "${name} 已设置"
  else
    bad "${name} 未设置"
    hint "${why}"
  fi
}

require_env DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL 'Sepolia 主 RPC 端点（只读调用需要）'
require_env DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL 'Sepolia 备用 RPC 端点（Provider 故障切换需要）'
require_env DFR_M0_API_KEY_ID 'Gateway 鉴权 keyId（8 位）'
require_env DFR_M0_API_KEY_HASH 'API key secret 的 sha256(secret+pepper)'

if [ "${DFR_M1_ALLOW_WRITE:-}" = 'true' ]; then
  ok 'DFR_M1_ALLOW_WRITE=true'
else
  bad 'DFR_M1_ALLOW_WRITE 不是 true（写路径未开放）'
  hint '真实广播必须显式开启：export DFR_M1_ALLOW_WRITE=true'
fi

if [ "${DFR_E03_SKIP_DB:-0}" = '1' ]; then
  head_ '2) 数据库（已按 DFR_E03_SKIP_DB=1 跳过）'
else
  head_ '2) 数据库'
  if [ -z "${DFR_TRANSACTION_DATABASE_URL:-}" ]; then
    bad 'DFR_TRANSACTION_DATABASE_URL 未设置（M1 写路径必须有持久化 Store）'
    hint '本地可用 pnpm test:db 启动测试库并导出 DSN；生产必须指向真实库'
  else
    ok 'DFR_TRANSACTION_DATABASE_URL 已设置'
    # 探测分两步，**必须区分**两类失败：
    #   1) 驱动不可用：`pg` 只声明在 packages/storage-postgres，从仓库根 require 会
    #      MODULE_NOT_FOUND。曾因此把"脚本自己的问题"误报成"数据库不可达"，
    #      让操作者去排查网络与权限（2026-10-06 修复）。
    #   2) 连接失败：网络/凭证问题。
    # 错误原文一律不外显（可能含 DSN 片段）。
    if node -e '
      try { require.resolve("pg", { paths: [process.cwd() + "/packages/storage-postgres"] }); }
      catch { process.exit(3); }
    ' >/dev/null 2>&1; then
      ok '数据库驱动可用'
      if node -e '
        const { Pool } = require(require.resolve("pg", { paths: [process.cwd() + "/packages/storage-postgres"] }));
        const pool = new Pool({ connectionString: process.env.DFR_TRANSACTION_DATABASE_URL, connectionTimeoutMillis: 5000 });
        pool.query("SELECT 1").then(() => pool.end()).then(() => process.exit(0)).catch(() => process.exit(1));
      ' >/dev/null 2>&1; then
        ok '数据库连通'
      else
        bad '数据库不可达（错误原文不回显，避免泄漏 DSN）'
        hint '检查 DSN、网络与账号权限；runtime 身份只需 DML'
      fi
    else
      bad '数据库驱动不可用（仓库未安装依赖或 pg 不可解析）'
      hint '先运行 pnpm install --frozen-lockfile；驱动按 packages/storage-postgres 解析'
      hint '（这是工具/安装问题，不是数据库问题——不要据此排查网络）'
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. RPC 可达性 + 链身份（必须是 Sepolia）
# ---------------------------------------------------------------------------
head_ '3) RPC 端点与链身份'
check_rpc() {
  local label="$1" url="$2"
  if [ -z "${url}" ]; then
    bad "${label} 未配置，跳过探测"
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
    bad "${label} 不可达或未返回 chainId"
    hint '确认端点 URL 正确、网络可达；若端点需要凭证，检查 key 是否已注入'
    return
  fi
  chain_id=$(printf '%s' "${body}" | tr 'A-Z' 'a-z')
  if [ "${chain_id}" = "${EXPECTED_CHAIN_ID}" ]; then
    ok "${label} 可达且 chainId = ${chain_id}（Sepolia）"
  else
    bad "${label} 的 chainId = ${chain_id}，不是 Sepolia（${EXPECTED_CHAIN_ID}）"
    hint '把 eth_chainId 结果直接与 11155111 比对；指向别的链会在 build 阶段被 Adapter 拒绝'
  fi
}

check_rpc '主 RPC' "${DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL:-}"
check_rpc '备用 RPC' "${DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL:-}"

# ---------------------------------------------------------------------------
# 4. 注册表是否已为 ethereum-sepolia 声明广播能力（E03 前置的核心）
# ---------------------------------------------------------------------------
head_ '4) 注册表能力声明'
if node -e '
  const { parse } = require("yaml");
  const fs = require("node:fs");
  const reg = parse(fs.readFileSync("packages/registry/config/chains.yaml", "utf8"));
  const chain = reg.chains["ethereum-sepolia"];
  if (!chain) process.exit(2);
  const caps = chain.capabilities ?? [];
  process.exit(caps.includes("transaction.broadcast") ? 0 : 1);
' >/dev/null 2>&1; then
  ok 'ethereum-sepolia 已声明 transaction.broadcast'
else
  bad 'ethereum-sepolia 未声明 transaction.broadcast（Registry fail-closed，广播会被拒）'
  hint '见 docs/development/deliveries/DFR-M1-E03-prep.md：加回能力需同步 registry 契约测试'
fi

# ---------------------------------------------------------------------------
# 5. 资金账户（人工提供，脚本只提示）
# ---------------------------------------------------------------------------
head_ '5) 资金账户（人工提供，脚本无法校验）'
if [ -n "${DFR_E03_FUNDED_ADDRESS:-}" ]; then
  ok 'DFR_E03_FUNDED_ADDRESS 已设置（脚本不校验其余额，需人工确认有测试 ETH）'
else
  bad 'DFR_E03_FUNDED_ADDRESS 未设置'
  hint '该地址用于 build 的 from 字段；余额与私钥由人工钱包保管，DFR 不接触私钥'
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
head_ '汇总'
if [ "${FAILED}" -eq 0 ]; then
  printf '  \033[32mREADY\033[0m：前置齐备，可按 docs/runbooks/m1-sepolia-broadcast-checkpoint.md 继续。\n'
  printf '  下一步：build 最小金额 native 转账 → simulate → **人工钱包签名** → 单次 broadcast。\n'
  exit 0
fi

printf '  \033[31mNOT READY\033[0m：存在缺失项（见上）。E03 保持 No-Go，不得用离线测试替代。\n'
exit 1
