#!/bin/sh
# Prometheus 启动入口：在容器内**运行时**生成 scrape 配置。
#
# 为什么不在仓库里放 prometheus.yml：`/metrics` 需要 `x-dfr-key` 头，而 Prometheus 的
# `http_headers` 只支持内联值、不支持从文件读取 —— 把 key 写进仓库配置会直接违反
# "凭证不入库"的安全红线。
# 因此配置在启动时从环境变量生成（heredoc 展开，无 sed 转义风险）。
#
# 必需环境变量：
#   DFR_METRICS_API_KEY  形如 dfr_<8位 keyId>_<20..64 位 secret>（与 Gateway 鉴权一致）
# 可选：
#   DFR_METRICS_TARGET   scrape 目标，默认 host.docker.internal:18787
#                        （= docker-compose.m1.yml 默认映射到宿主机的端口）
set -eu

: "${DFR_METRICS_API_KEY:?DFR_METRICS_API_KEY is required (形式 dfr_<keyId>_<secret>)}"
TARGET="${DFR_METRICS_TARGET:-host.docker.internal:18787}"

cat > /etc/prometheus/prometheus.yml <<EOF
# 由 entrypoint.sh 在运行时生成，**不要提交**（含凭证）。
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alerts.yml

scrape_configs:
  - job_name: dfr-gateway
    metrics_path: /metrics
    scheme: http
    static_configs:
      - targets: ['${TARGET}']
    # Gateway 的 /metrics 需要有效 API Key（见 observability-spec §9）。
    # key 只存在于容器内存与这个运行时生成的配置里。
    http_headers:
      x-dfr-key:
        values: ['${DFR_METRICS_API_KEY}']
EOF

exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --web.enable-lifecycle
