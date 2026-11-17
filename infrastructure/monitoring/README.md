# Monitoring 交付范围

M1-D 接入交易阶段、耗时、finality、reorg、lease 与恢复指标。

指标标签禁止使用 txHash、account、requestId、idempotency key 等高基数字段；这些只进入脱敏日志或 Trace。

## 使用

```bash
export DFR_METRICS_API_KEY="dfr_<8位 keyId>_<secret>"
docker compose -f infrastructure/monitoring/docker-compose.monitoring.yml up -d
# Prometheus: http://127.0.0.1:9090   Grafana: http://127.0.0.1:3000
```

完整说明与两个已知本地坑见 [runbook 第 8c 节](../../docs/runbooks/m1-local.md)。

## 文件

| 路径 | 作用 |
|---|---|
| `docker-compose.monitoring.yml` | Prometheus + Grafana 单机样例（非生产） |
| `prometheus/entrypoint.sh` | 运行时由环境变量生成含鉴权头的 scrape 配置（凭证不入库） |
| `prometheus/alerts.yml` | 18 条告警规则（observability-spec §8 的 8 条 + 依赖拒绝 + E5 Provider 配额接近上限；第 9 条 Indexer 落后属 M6） |
| `grafana/dashboards/dfr-m1.json` | 19 面板看板（含依赖拒绝与 E5 Provider 日配额） |
| `grafana/provisioning/` | 数据源与看板自动加载（只挂载 datasources/dashboards 两个子目录） |

## 护栏

`tests/contract/monitoring-config.test.ts` 断言：告警/看板引用的每个指标都在生产源码里存在、
告警规则结构完整且名字唯一、看板数据源 uid 与 provisioning 一致、配置不含 API Key 形态字符串、
且 provisioning 不被整体遮蔽。指标改名会让这里红灯，而不是让看板静默变成 "No data"。
