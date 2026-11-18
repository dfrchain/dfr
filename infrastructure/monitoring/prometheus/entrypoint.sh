#!/bin/sh
# Prometheus startup entrypoint: generate the scrape config **at runtime**
# inside the container.
#
# Why prometheus.yml is not kept in the repository: `/metrics` needs an
# `x-dfr-key` header, and Prometheus's `http_headers` only supports inline
# values, not reading from a file — writing the key into a repository config
# would directly violate the "credentials are never committed" safety red
# line. So the config is generated at startup from environment variables
# (heredoc expansion, no sed escaping risk).
#
# Required environment variables:
#   DFR_METRICS_API_KEY  shaped like dfr_<8-char keyId>_<20..64-char secret> (same as Gateway auth)
# Optional:
#   DFR_METRICS_TARGET   scrape target, default host.docker.internal:18787
#                        (= the port docker-compose.m1.yml maps to the host by default)
set -eu

: "${DFR_METRICS_API_KEY:?DFR_METRICS_API_KEY is required (format dfr_<keyId>_<secret>)}"
TARGET="${DFR_METRICS_TARGET:-host.docker.internal:18787}"

cat > /etc/prometheus/prometheus.yml <<EOF
# Generated at runtime by entrypoint.sh; **do not commit** (contains credentials).
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
    # The Gateway's /metrics needs a valid API key (see observability-spec §9).
    # The key exists only in container memory and in this runtime-generated config.
    http_headers:
      x-dfr-key:
        values: ['${DFR_METRICS_API_KEY}']
EOF

exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --web.enable-lifecycle
