# Monitoring delivery scope

M1-D wires in transaction stage, latency, finality, reorg, lease, and
recovery metrics.

Metric labels must not use high-cardinality fields such as txHash, account,
requestId, or idempotency key; those only go into redacted logs or traces.

## Usage

```bash
export DFR_METRICS_API_KEY="dfr_<8-char keyId>_<secret>"
docker compose -f infrastructure/monitoring/docker-compose.monitoring.yml up -d
# Prometheus: http://127.0.0.1:9090   Grafana: http://127.0.0.1:3000
```

See runbook section 8c for the full guide and two known local gotchas
([runbook section 8c](../../docs/runbooks/m1-local.md)).

## Files

| Path | Purpose |
|---|---|
| `docker-compose.monitoring.yml` | Prometheus + Grafana single-host sample (not production) |
| `prometheus/entrypoint.sh` | Generates a scrape config with an auth header from environment variables at runtime (credentials are not committed) |
| `prometheus/alerts.yml` | 18 alert rules (the 8 from observability-spec §8 + dependency rejection + E5 Provider quota near limit; rule 9, Indexer lag, belongs to M6) |
| `grafana/dashboards/dfr-m1.json` | 19-panel dashboard (including dependency rejection and E5 Provider daily quota) |
| `grafana/provisioning/` | Automatic loading of datasources and dashboards (mounts only the datasources/dashboards subdirectories) |

## Guardrails

`tests/contract/monitoring-config.test.ts` asserts: every metric referenced
by alerts/dashboards exists in the production source, alert rule structure
is complete and names are unique, dashboard datasource uids match
provisioning, the config contains no API-key-shaped strings, and
provisioning is not shadowed as a whole. Renaming a metric turns this red
instead of silently turning a dashboard into "No data".
