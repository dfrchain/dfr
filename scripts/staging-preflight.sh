#!/usr/bin/env bash
# DFR staging 演练前置检查（M5-E01，launch-plan 链④"A 口径上线前的一次 staging"）。
#
# 用途：在一个**已部署**的 DFR 实例上，一次性验证"这次 staging 演练值得开始"：
# 进程活着、依赖就绪、鉴权真的生效、只读面能返回真实数据、指标可抓。
#
# 为什么单独写一个而不是复用 e03-preflight.sh：
#   e03 检查的是**源仓库内**的前置（RPC/DSN/注册表文件），回答"能不能开始构造交易"；
#   本脚本检查的是一个**远端已部署实例**，回答"这个部署能不能开始演练"。
#   两者对象不同，混在一起会让"本机没配 DSN"与"staging 挂了"无法区分。
#
# 安全约定：
#   - **只读**：只发 HTTP GET，且只打运维/只读端点；不构造、不签名、不广播；
#   - **绝不打印 API Key**：只报告"已设置/未设置"，失败时只回显 HTTP 状态；
#   - 缺失即 fail-closed（退出码 1），不猜测、不降级；
#   - 鉴权**反向**验证：不带 Key 打 /v1/chains 必须是 401 —— staging 若把鉴权配漏了，
#     本脚本必须发现它，否则整场演练的结论都不成立。
#
# 用法：
#   export DFR_STAGING_BASE_URL='https://dfr-staging.example'
#   export DFR_STAGING_API_KEY='dfr_<keyId>_<secret>'   # 只放环境变量，不进文件/命令
#   ./scripts/staging-preflight.sh
#
# 可选：
#   DFR_STAGING_EXPECT_CHAINS='base-sepolia,arbitrum-sepolia'  # 逗号分隔；缺链即失败
#   DFR_STAGING_SKIP_METRICS=1                                 # 本轮不校验 /metrics
#   DFR_STAGING_TIMEOUT_S=10                                   # 单请求超时
#
# 退出码：0 = READY；1 = 有缺失项；2 = 用法错误（缺必需变量）。
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

head_ 'DFR staging 前置检查'

# ---------------------------------------------------------------------------
# 0. 必需输入
# ---------------------------------------------------------------------------
head_ '0) 输入'
if [ -z "${BASE}" ]; then
  bad 'DFR_STAGING_BASE_URL 未设置'
  hint "指向 staging 实例根地址（不带尾斜杠），例如 https://dfr-staging.example"
  printf '\n  \033[31mNOT READY\033[0m：缺少必需输入。\n'
  exit 2
fi
if [ -z "${KEY}" ]; then
  bad 'DFR_STAGING_API_KEY 未设置'
  hint '只放环境变量（不进文件、不进命令历史）；形如 dfr_<8位keyId>_<secret>'
  printf '\n  \033[31mNOT READY\033[0m：缺少必需输入。\n'
  exit 2
fi
BASE="${BASE%/}"
ok "DFR_STAGING_BASE_URL 已设置（${BASE}）"
ok 'DFR_STAGING_API_KEY 已设置（值不回显）'

# 不把 Key 展开到 curl argv：同机上可见进程参数的主体不应能在请求窗口读取凭证。
# curl 的 @file 语法会读取完整 Header 行；文件名本身不含 Key，且退出时必删。
AUTH_HEADER_FILE="$(mktemp -t dfr-staging-header.XXXXXX)"
chmod 600 "${AUTH_HEADER_FILE}"
printf 'X-DFR-Key: %s\n' "${KEY}" > "${AUTH_HEADER_FILE}"

# 取 HTTP 状态码；curl 不可用或超时返回 000。
status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "${TIMEOUT}" "$@" 2>/dev/null || printf '000'
}
# 取响应体（供 JSON 解析）；失败返回空串。
body_of() {
  curl -s --max-time "${TIMEOUT}" "$@" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 1. 存活：/healthz 不鉴权、不查依赖
# ---------------------------------------------------------------------------
head_ '1) 存活（GET /healthz）'
code="$(status_of "${BASE}/healthz")"
if [ "${code}" = '200' ]; then
  ok '/healthz 200（进程存活）'
else
  bad "/healthz 返回 ${code}（期望 200）"
  hint '进程没起来或不接受连接；先看容器状态与启动日志，再谈演练'
fi

# ---------------------------------------------------------------------------
# 2. 就绪：/readyz 区分"活着"与"能接流量"
# ---------------------------------------------------------------------------
head_ '2) 就绪（GET /readyz）'
ready_body="$(body_of "${BASE}/readyz")"
code="$(status_of "${BASE}/readyz")"
if [ "${code}" = '200' ]; then
  ok '/readyz 200（依赖就绪）'
elif [ "${code}" = '503' ]; then
  bad '/readyz 503（进程存活但依赖未就绪）'
  hint '依赖故障时进程保持存活但不接流量——这是设计行为，不是崩溃'
else
  bad "/readyz 返回 ${code}（期望 200 或 503）"
fi

# 就地解析 JSON（node 已在仓库工具链里；不用 jq，避免引入额外依赖）。
if [ -n "${ready_body}" ]; then
  printf '%s' "${ready_body}" | node -e '
    let raw="";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let body; try { body = JSON.parse(raw); } catch { process.exit(2); }
      const chains = Array.isArray(body.chains) ? body.chains : [];
      // 语义区分（诚实口径）：
      //   providers > 0 且 available == 0 → 配了但全不可用（真故障，要拦）
      //   providers == 0                → 未配置该链的端点（信息项，不是故障）
      // 把"未配置"当故障会让脚本对正常部署误报 NOT READY，操作者会去查不存在的问题。
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
    bad "事务存储不可用（stores=${stores_line}）"
    hint 'M1 写路径要求持久化 Store；staging 必须在演练前修好存储连通'
  else
    ok '事务存储就绪（或本部署为只读、未配置 Store）'
  fi

  down="$(grep '^DOWN:' /tmp/dfr-staging-ready.txt | cut -d: -f2- | tr '\n' ',' | sed 's/,$//')"
  unconfigured="$(grep '^UNCONFIGURED:' /tmp/dfr-staging-ready.txt | cut -d: -f2- | tr '\n' ',' | sed 's/,$//')"
  listed="$(grep '^CHAINS:' /tmp/dfr-staging-ready.txt | head -1 | cut -d: -f2-)"
  if [ -n "${down}" ]; then
    bad "以下链配置了 Provider 但全部不可用：${down}"
    hint '演练前先确认这些链的端点可达；只有部分链不可用时，演练范围要相应收窄'
  elif [ -n "${listed}" ]; then
    ok "就绪链：${listed}"
  fi
  if [ -n "${unconfigured}" ]; then
    ok "未配置端点的链（信息项，非故障）：${unconfigured}"
  fi
  rm -f /tmp/dfr-staging-ready.txt
fi

# 期望链必须都在列（缺链会让演练覆盖不到约定的范围）。
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
    bad "期望链缺失：${missing%,}"
    hint '检查 DFR_DEPLOY_MILESTONE 与注册表；M4+ 的链需要显式里程碑才加载'
  else
    ok "期望链齐备：${EXPECT_CHAINS}"
  fi

  head_ '2b) 期望链详情（GET /v1/chains/{chain}，带 Key）'
  IFS=',' read -r -a detail_want <<< "${EXPECT_CHAINS}"
  for chain in "${detail_want[@]}"; do
    chain="$(printf '%s' "${chain}" | tr -d '[:space:]')"
    [ -z "${chain}" ] && continue
    detail_code="$(status_of -H "@${AUTH_HEADER_FILE}" "${BASE}/v1/chains/${chain}")"
    if [ "${detail_code}" = '200' ]; then
      ok "${chain} 详情 200"
    else
      bad "${chain} 详情返回 ${detail_code}（期望 200）"
      hint '链清单虽存在，但详情读取失败；在演练前修复该链的部署或路由'
    fi
  done
fi

# ---------------------------------------------------------------------------
# 3. 鉴权**反向**验证：不带 Key 必须 401
# ---------------------------------------------------------------------------
head_ '3) 鉴权（反向验证）'
code="$(status_of "${BASE}/v1/chains")"
if [ "${code}" = '401' ]; then
  ok '不带 Key 访问 /v1/chains → 401（鉴权确实生效）'
else
  bad "不带 Key 访问 /v1/chains 返回 ${code}（期望 401）"
  hint '这是**必须**拦下的问题：鉴权配漏会让整场演练的结论不成立'
fi

# ---------------------------------------------------------------------------
# 4. 只读业务面：带 Key 取链清单
# ---------------------------------------------------------------------------
head_ '4) 只读业务面（GET /v1/chains，带 Key）'
chains_body="$(body_of -H "@${AUTH_HEADER_FILE}" "${BASE}/v1/chains")"
code="$(status_of -H "@${AUTH_HEADER_FILE}" "${BASE}/v1/chains")"
if [ "${code}" = '200' ]; then
  count="$(printf '%s' "${chains_body}" | node -e '
    let raw=""; process.stdin.on("data",(c)=>(raw+=c));
    process.stdin.on("end",()=>{ try { const b=JSON.parse(raw); console.log(Array.isArray(b.items)?b.items.length:0);} catch { console.log("ERR"); } });
  ' 2>/dev/null || printf 'ERR')"
  if [ "${count}" = 'ERR' ]; then
    bad '链清单不是合法 JSON 对象（响应形状与契约不符）'
    hint '按 ADR-009 契约，应为 {items:[...], requestId}'
  elif [ "${count}" = '0' ]; then
    bad '链清单为空（没有可见链，演练无从下手）'
    hint '检查注册表加载与里程碑开关；空清单通常意味着配置没生效'
  else
    ok "链清单返回 ${count} 条"
  fi
else
  bad "/v1/chains 返回 ${code}（期望 200）"
  hint 'Key 可能无效/过期，或 scope 不允许读；错误码见响应 dfr_code'
fi

# ---------------------------------------------------------------------------
# 5. 指标：需鉴权且包含约定指标族
# ---------------------------------------------------------------------------
if [ "${DFR_STAGING_SKIP_METRICS:-0}" = '1' ]; then
  head_ '5) 指标（已按 DFR_STAGING_SKIP_METRICS=1 跳过）'
else
  head_ '5) 指标（GET /metrics，带 Key）'
  code_noauth="$(status_of "${BASE}/metrics")"
  if [ "${code_noauth}" = '401' ]; then
    ok '/metrics 不带 Key → 401（指标端点已纳入鉴权）'
  else
    bad "/metrics 不带 Key 返回 ${code_noauth}（期望 401）"
    hint '指标含用量与链路拓扑，未鉴权会泄漏运营信息'
  fi

  code="$(status_of -H "@${AUTH_HEADER_FILE}" "${BASE}/metrics")"
  if [ "${code}" = '200' ]; then
    # 落临时文件再 grep，**不要** `printf ... | grep -q`：
    # 指标体可达数十 KB，`grep -q` 命中即退出会让 printf 收到 SIGPIPE，
    # 在 `set -o pipefail` 下整条管道返回非零 —— 于是"指标明明存在"却被判缺失。
    # 这是 2026-10-08 对真实实例实测时发现的假失败（75KB 响应）。
    metrics_file="$(mktemp)"
    body_of -H "@${AUTH_HEADER_FILE}" "${BASE}/metrics" > "${metrics_file}"
    missing=''
    for family in dfr_gateway_requests_total dfr_gateway_inflight_requests; do
      grep -q "^${family}" "${metrics_file}" || missing="${missing}${family},"
    done
    if [ -n "${missing}" ]; then
      bad "指标缺族：${missing%,}"
      hint 'Prometheus 抓取不到关键指标，演练期间就看不清状态'
    else
      lines="$(grep -cE '^[a-z]' "${metrics_file}" || true)"
      ok "/metrics 200，含 ${lines} 行样本（关键指标族齐备）"
    fi
    rm -f "${metrics_file}"
  else
    bad "/metrics 返回 ${code}（期望 200）"
  fi
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
head_ '汇总'
if [ "${FAILED}" -eq 0 ]; then
  printf '  \033[32mREADY\033[0m：staging 前置齐备，可按 docs/runbooks/staging-drill.md 开始演练。\n'
  printf '  下一步：按 runbook §3 逐项执行，并把证据写进 docs/development/deliveries/DFR-M5-E01.md。\n'
  exit 0
fi

printf '  \033[31mNOT READY\033[0m：存在缺失项（见上）。演练不得开始，也不得用离线测试替代。\n'
exit 1
