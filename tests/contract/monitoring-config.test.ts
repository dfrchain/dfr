// 监控配置与代码的一致性契约测试。
//
// 为什么必须存在：Prometheus/Grafana **不会**因为引用了不存在的指标而报错 ——
// 查询只是返回空，看板变成一片 "No data"，告警永远不触发。指标改名后静默失效
// 是监控最常见的死法，而且往往在真正需要告警的那天才发现。
//
// 本测试把"配置里引用的指标必须在代码中真实存在"变成**编译期的等价物**：
// 一旦指标改名或删除，这里立刻红灯。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string): string => readFileSync(resolve(repoRoot, p), 'utf8');

/** 指标定义所在的生产源码（新增指标模块时需同步此列表）。 */
const METRIC_SOURCE_FILES = [
  'apps/gateway/src/gateway-metrics.ts',
  'apps/gateway/src/layer-metrics.ts',
  'packages/transaction/src/metrics.ts',
] as const;

const ALERTS = 'infrastructure/monitoring/prometheus/alerts.yml';
const DASHBOARD = 'infrastructure/monitoring/grafana/dashboards/dfr-m1.json';
const DATASOURCE = 'infrastructure/monitoring/grafana/provisioning/datasources/dfr.yml';
const ENTRYPOINT = 'infrastructure/monitoring/prometheus/entrypoint.sh';

/** 从生产源码里提取**已声明**的指标名（`const NAME = 'dfr_...';`）。 */
function declaredMetrics(): Set<string> {
  const names = new Set<string>();
  for (const file of METRIC_SOURCE_FILES) {
    for (const match of read(file).matchAll(/const\s+[A-Z0-9_]+\s*=\s*'(dfr_[a-z0-9_]+)'\s*;/gu)) {
      names.add(match[1]!);
    }
  }
  return names;
}

/** 从任意文本里提取**被引用**的指标名，并把直方图后缀归一到基名。 */
function referencedMetrics(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/\bdfr_[a-z0-9_]+/gu)) {
    names.add(match[0]!.replace(/_(bucket|sum|count)$/u, ''));
  }
  return names;
}

describe('监控配置与代码一致（防指标漂移）', () => {
  it('生产源码里能提取到指标定义（护栏自身有效）', () => {
    const declared = declaredMetrics();
    // 基线：M1 的 27 个指标。若这个数字骤降，说明提取正则或文件列表失效 ——
    // 那样下面的"引用 ⊆ 声明"会变成恒真，护栏形同虚设。
    expect(declared.size).toBeGreaterThanOrEqual(25);
    expect(declared.has('dfr_gateway_requests_total')).toBe(true);
    expect(declared.has('dfr_provider_circuit_state')).toBe(true);
    expect(declared.has('dfr_transaction_stage_total')).toBe(true);
  });

  it('告警规则引用的每个指标都在代码中存在', () => {
    const declared = declaredMetrics();
    const referenced = referencedMetrics(read(ALERTS));
    expect(referenced.size).toBeGreaterThan(10);
    const missing = [...referenced].filter((name) => !declared.has(name));
    expect(missing, `告警引用了不存在的指标：${missing.join(', ')}`).toEqual([]);
  });

  it('Grafana 看板引用的每个指标都在代码中存在', () => {
    const declared = declaredMetrics();
    const referenced = referencedMetrics(read(DASHBOARD));
    expect(referenced.size).toBeGreaterThan(10);
    const missing = [...referenced].filter((name) => !declared.has(name));
    expect(missing, `看板引用了不存在的指标：${missing.join(', ')}`).toEqual([]);
  });

  it('刻意未实现的指标不得出现在配置里（它们会永远空图）', () => {
    // `dfr_provider_cost_usd_total` 与 `dfr_gateway_quota_exceeded_total` 是规范里列了、
    // 但因缺少子系统而**刻意不实现**的指标（见 observability-spec §5.1/§5.4）。
    // 把它们画进看板或写成告警，只会制造永远无数据的噪音。
    const notImplemented = ['dfr_provider_cost_usd_total', 'dfr_gateway_quota_exceeded_total'];
    const configs = read(ALERTS) + read(DASHBOARD);
    for (const name of notImplemented) {
      expect(configs, `${name} 未实现，不应出现在监控配置里`).not.toContain(name);
    }
  });
});

describe('告警规则结构完整', () => {
  interface AlertRule {
    alert?: string;
    expr?: string;
    for?: string;
    labels?: { severity?: string };
    annotations?: { summary?: string; description?: string };
  }
  interface AlertGroup {
    name?: string;
    rules?: AlertRule[];
  }

  const groups = (parseYaml(read(ALERTS)) as { groups: AlertGroup[] }).groups;

  it('每组都有名称，每条规则都有 alert/expr/for/severity/summary', () => {
    expect(groups.length).toBeGreaterThanOrEqual(4);
    for (const group of groups) {
      expect(group.name, '规则组必须有 name').toBeTruthy();
      expect((group.rules ?? []).length).toBeGreaterThan(0);
      for (const rule of group.rules ?? []) {
        expect(rule.alert, `规则缺少 alert 名：${JSON.stringify(rule).slice(0, 80)}`).toBeTruthy();
        expect(rule.expr, `${rule.alert} 缺少 expr`).toBeTruthy();
        // `for` 必须显式给（哪怕是 0m）：缺省会继承全局值，容易造成"以为设了抖动抑制其实没有"。
        expect(rule.for, `${rule.alert} 缺少 for`).toBeTruthy();
        expect(rule.labels?.severity, `${rule.alert} 缺少 severity`).toMatch(
          /^(critical|high|medium|low)$/u,
        );
        expect(rule.annotations?.summary, `${rule.alert} 缺少 summary`).toBeTruthy();
      }
    }
  });

  it('覆盖率快照锁定：18 条规则 / 19 面板（文档里的数字随之漂移就是这里红灯）', () => {
    // README / runbook / 交付报告都写了这两个数字；指标或规则增删时它们必须同步。
    const alertCount = groups.flatMap((g) => g.rules ?? []).length;
    expect(alertCount).toBe(18);
    const panels = JSON.parse(read(DASHBOARD)) as { panels?: unknown[] };
    expect((panels.panels ?? []).length).toBe(19);
  });

  it('alert 名全局唯一（重复名会让 Prometheus 拒绝加载规则）', () => {
    const names = groups.flatMap((g) => (g.rules ?? []).map((r) => r.alert));
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(10);
  });
});

describe('Grafana 看板可加载', () => {
  interface Dashboard {
    uid?: string;
    panels?: { id?: number; title?: string; targets?: { expr?: string }[] }[];
  }
  interface DatasourceYaml {
    datasources?: { uid?: string; url?: string }[];
  }

  const dashboard = JSON.parse(read(DASHBOARD)) as Dashboard;
  const datasources = (parseYaml(read(DATASOURCE)) as DatasourceYaml).datasources ?? [];

  it('panel id 唯一且每个 panel 至少有一个查询', () => {
    const panels = dashboard.panels ?? [];
    expect(panels.length).toBeGreaterThanOrEqual(10);
    const ids = panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const panel of panels) {
      expect(panel.title, 'panel 缺少标题').toBeTruthy();
      expect((panel.targets ?? []).length, `panel「${panel.title}」没有查询`).toBeGreaterThan(0);
      for (const target of panel.targets ?? []) {
        expect(target.expr, `panel「${panel.title}」的查询缺 expr`).toBeTruthy();
      }
    }
  });

  it('看板引用的数据源 uid 与 provisioning 一致', () => {
    // uid 不一致的典型症状：看板能打开，但每个 panel 都是 "Datasource not found"。
    const provisioned = new Set(datasources.map((d) => d.uid));
    const uids = JSON.stringify(dashboard).matchAll(/"uid"\s*:\s*"([^"]+)"/gu);
    const referenced = new Set<string>();
    for (const match of uids) referenced.add(match[1]!);
    // 看板自身的 uid（dfr-m1）不是数据源，排除。
    referenced.delete(dashboard.uid ?? '');
    expect(referenced.size).toBeGreaterThan(0);
    for (const uid of referenced) {
      expect(provisioned.has(uid), `看板引用了未 provisioning 的数据源 uid=${uid}`).toBe(true);
    }
  });

  it('Prometheus 抓取目标通过数据源 url 指向 prometheus 服务', () => {
    expect(datasources.some((d) => d.url === 'http://prometheus:9090')).toBe(true);
  });
});

describe('监控配置不含凭证', () => {
  it('alerts / 看板 / provisioning 里没有 API key 形态的字符串', () => {
    // Gateway key 形如 dfr_<8位 keyId>_<20..64 位 secret>（见 apps/gateway/src/auth.ts）。
    const keyPattern = /dfr_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20,64}/u;
    for (const file of [ALERTS, DASHBOARD, DATASOURCE]) {
      expect(read(file), `${file} 不得包含 API key`).not.toMatch(keyPattern);
    }
  });

  it('scrape 配置由 entrypoint 在运行时生成，且只从环境变量取 key', () => {
    const entrypoint = read(ENTRYPOINT);
    // 必须要求环境变量存在（缺失即失败，不静默抓取不到）。
    expect(entrypoint).toContain('DFR_METRICS_API_KEY:?');
    // key 只能经由变量展开进入配置，不能是字面量。
    expect(entrypoint).toMatch(/values:\s*\['\$\{DFR_METRICS_API_KEY\}'\]/u);
    // 生成的配置文件不应落在仓库里（只在容器内 /etc/prometheus）。
    expect(entrypoint).toContain('/etc/prometheus/prometheus.yml');
  });
});

describe('Grafana provisioning 挂载不遮蔽镜像目录', () => {
  const COMPOSE = 'infrastructure/monitoring/docker-compose.monitoring.yml';

  it('只挂载用到的子目录，不整体覆盖 /etc/grafana/provisioning', () => {
    // bind mount 会整体覆盖目录：若把整个 provisioning 挂进来，镜像自带的
    // plugins/alerting/notifiers/access-control 会被遮蔽，Grafana 每次启动都会
    // 打一条 level=error（"Failed to read ... no such file or directory"），
    // 把真实错误淹没在噪音里。这里把它固定成契约。
    const compose = read(COMPOSE);
    expect(compose).toContain('./grafana/provisioning/datasources:/etc/grafana/provisioning/datasources');
    expect(compose).toContain('./grafana/provisioning/dashboards:/etc/grafana/provisioning/dashboards');
    expect(compose).not.toMatch(/^\s*-\s*\.\/grafana\/provisioning:\/etc\/grafana\/provisioning/mu);
  });

  it('被挂载的两个子目录都包含真实配置（不是空目录）', () => {
    // 空目录不会被 git 跟踪，重新 clone 后 bind mount 会挂出空目录。
    expect(read(DATASOURCE).length).toBeGreaterThan(0);
    expect(read('infrastructure/monitoring/grafana/provisioning/dashboards/dfr.yml').length).toBeGreaterThan(0);
  });
});
