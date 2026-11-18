// Contract test for consistency between monitoring configuration and code.
//
// Why it must exist: Prometheus/Grafana will **not** error when they reference a metric that does not exist —
// queries just return empty, dashboards become a field of "No data", and alerts never fire. A metric silently
// breaking after a rename is the most common way monitoring dies, and it is usually discovered only on the day
// an alert is actually needed.
//
// This test turns "every metric referenced in config must really exist in code" into the **compile-time
// equivalent**: the moment a metric is renamed or deleted, this goes red.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string): string => readFileSync(resolve(repoRoot, p), 'utf8');

/** The production source where metric definitions live (keep this list in sync when adding a metrics module). */
const METRIC_SOURCE_FILES = [
  'apps/gateway/src/gateway-metrics.ts',
  'apps/gateway/src/layer-metrics.ts',
  'packages/transaction/src/metrics.ts',
] as const;

const ALERTS = 'infrastructure/monitoring/prometheus/alerts.yml';
const DASHBOARD = 'infrastructure/monitoring/grafana/dashboards/dfr-m1.json';
const DATASOURCE = 'infrastructure/monitoring/grafana/provisioning/datasources/dfr.yml';
const ENTRYPOINT = 'infrastructure/monitoring/prometheus/entrypoint.sh';

/** Extracts the **declared** metric names from production source (`const NAME = 'dfr_...';`). */
function declaredMetrics(): Set<string> {
  const names = new Set<string>();
  for (const file of METRIC_SOURCE_FILES) {
    for (const match of read(file).matchAll(/const\s+[A-Z0-9_]+\s*=\s*'(dfr_[a-z0-9_]+)'\s*;/gu)) {
      names.add(match[1]!);
    }
  }
  return names;
}

/** Extracts the **referenced** metric names from arbitrary text, normalising histogram suffixes to the base name. */
function referencedMetrics(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/\bdfr_[a-z0-9_]+/gu)) {
    names.add(match[0]!.replace(/_(bucket|sum|count)$/u, ''));
  }
  return names;
}

describe('Monitoring configuration matches code (guards against metric drift)', () => {
  it('metric definitions can be extracted from production source (the guard itself works)', () => {
    const declared = declaredMetrics();
    // Baseline: M1's 27 metrics. If this number drops sharply, the extraction regex or file list is broken —
    // and then the "references ⊆ declarations" check below would become vacuously true, leaving the guard useless.
    expect(declared.size).toBeGreaterThanOrEqual(25);
    expect(declared.has('dfr_gateway_requests_total')).toBe(true);
    expect(declared.has('dfr_provider_circuit_state')).toBe(true);
    expect(declared.has('dfr_transaction_stage_total')).toBe(true);
  });

  it('every metric referenced by alert rules exists in code', () => {
    const declared = declaredMetrics();
    const referenced = referencedMetrics(read(ALERTS));
    expect(referenced.size).toBeGreaterThan(10);
    const missing = [...referenced].filter((name) => !declared.has(name));
    expect(missing, `Alert rules reference nonexistent metrics: ${missing.join(', ')}`).toEqual([]);
  });

  it('every metric referenced by the Grafana dashboard exists in code', () => {
    const declared = declaredMetrics();
    const referenced = referencedMetrics(read(DASHBOARD));
    expect(referenced.size).toBeGreaterThan(10);
    const missing = [...referenced].filter((name) => !declared.has(name));
    expect(missing, `The dashboard references nonexistent metrics: ${missing.join(', ')}`).toEqual([]);
  });

  it('deliberately unimplemented metrics must not appear in config (they would graph empty forever)', () => {
    // `dfr_provider_cost_usd_total` and `dfr_gateway_quota_exceeded_total` are listed in the spec but
    // **deliberately not implemented** for lack of the subsystem (see observability-spec §5.1/§5.4).
    // Drawing them on a dashboard or writing them as alerts would only create permanently empty noise.
    const notImplemented = ['dfr_provider_cost_usd_total', 'dfr_gateway_quota_exceeded_total'];
    const configs = read(ALERTS) + read(DASHBOARD);
    for (const name of notImplemented) {
      expect(configs, `${name} is not implemented and must not appear in monitoring config`).not.toContain(name);
    }
  });
});

describe('Alert rule structure is complete', () => {
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

  it('every group has a name, and every rule has alert/expr/for/severity/summary', () => {
    expect(groups.length).toBeGreaterThanOrEqual(4);
    for (const group of groups) {
      expect(group.name, 'a rule group must have a name').toBeTruthy();
      expect((group.rules ?? []).length).toBeGreaterThan(0);
      for (const rule of group.rules ?? []) {
        expect(rule.alert, `Rule is missing an alert name: ${JSON.stringify(rule).slice(0, 80)}`).toBeTruthy();
        expect(rule.expr, `${rule.alert} is missing expr`).toBeTruthy();
        // `for` must be given explicitly (even 0m): the default inherits the global value, easily creating
        // "thought jitter suppression was set but was not".
        expect(rule.for, `${rule.alert} is missing for`).toBeTruthy();
        expect(rule.labels?.severity, `${rule.alert} is missing severity`).toMatch(
          /^(critical|high|medium|low)$/u,
        );
        expect(rule.annotations?.summary, `${rule.alert} is missing summary`).toBeTruthy();
      }
    }
  });

  it('coverage snapshot locked: 18 rules / 19 panels (if the numbers in the docs drift, this goes red)', () => {
    // README / runbook / delivery report all state these two numbers; they must be updated in sync when metrics
    // or rules change.
    const alertCount = groups.flatMap((g) => g.rules ?? []).length;
    expect(alertCount).toBe(18);
    const panels = JSON.parse(read(DASHBOARD)) as { panels?: unknown[] };
    expect((panels.panels ?? []).length).toBe(19);
  });

  it('alert names are globally unique (a duplicate name makes Prometheus refuse to load the rules)', () => {
    const names = groups.flatMap((g) => (g.rules ?? []).map((r) => r.alert));
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(10);
  });
});

describe('Grafana dashboard loads', () => {
  interface Dashboard {
    uid?: string;
    panels?: { id?: number; title?: string; targets?: { expr?: string }[] }[];
  }
  interface DatasourceYaml {
    datasources?: { uid?: string; url?: string }[];
  }

  const dashboard = JSON.parse(read(DASHBOARD)) as Dashboard;
  const datasources = (parseYaml(read(DATASOURCE)) as DatasourceYaml).datasources ?? [];

  it('panel ids are unique and every panel has at least one query', () => {
    const panels = dashboard.panels ?? [];
    expect(panels.length).toBeGreaterThanOrEqual(10);
    const ids = panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const panel of panels) {
      expect(panel.title, 'a panel is missing a title').toBeTruthy();
      expect((panel.targets ?? []).length, `panel "${panel.title}" has no queries`).toBeGreaterThan(0);
      for (const target of panel.targets ?? []) {
        expect(target.expr, `panel "${panel.title}" query is missing expr`).toBeTruthy();
      }
    }
  });

  it('the datasource uids referenced by the dashboard match provisioning', () => {
    // Typical symptom of a uid mismatch: the dashboard opens, but every panel says "Datasource not found".
    const provisioned = new Set(datasources.map((d) => d.uid));
    const uids = JSON.stringify(dashboard).matchAll(/"uid"\s*:\s*"([^"]+)"/gu);
    const referenced = new Set<string>();
    for (const match of uids) referenced.add(match[1]!);
    // The dashboard's own uid (dfr-m1) is not a datasource; exclude it.
    referenced.delete(dashboard.uid ?? '');
    expect(referenced.size).toBeGreaterThan(0);
    for (const uid of referenced) {
      expect(provisioned.has(uid), `The dashboard references a datasource uid that was not provisioned: uid=${uid}`).toBe(true);
    }
  });

  it('Prometheus scrape targets point at the prometheus service via the datasource url', () => {
    expect(datasources.some((d) => d.url === 'http://prometheus:9090')).toBe(true);
  });
});

describe('Monitoring configuration contains no credentials', () => {
  it('alerts / dashboard / provisioning contain no API-key-shaped strings', () => {
    // A Gateway key looks like dfr_<8-char keyId>_<20..64-char secret> (see apps/gateway/src/auth.ts).
    const keyPattern = /dfr_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20,64}/u;
    for (const file of [ALERTS, DASHBOARD, DATASOURCE]) {
      expect(read(file), `${file} must not contain an API key`).not.toMatch(keyPattern);
    }
  });

  it('the scrape config is generated at runtime by the entrypoint and takes the key only from an environment variable', () => {
    const entrypoint = read(ENTRYPOINT);
    // The environment variable must be required (missing means failure, not silently scraping nothing).
    expect(entrypoint).toContain('DFR_METRICS_API_KEY:?');
    // The key may only enter the config via variable expansion, never as a literal.
    expect(entrypoint).toMatch(/values:\s*\['\$\{DFR_METRICS_API_KEY\}'\]/u);
    // The generated config file must not land in the repo (only inside the container at /etc/prometheus).
    expect(entrypoint).toContain('/etc/prometheus/prometheus.yml');
  });
});

describe('Grafana provisioning mounts do not shadow image directories', () => {
  const COMPOSE = 'infrastructure/monitoring/docker-compose.monitoring.yml';

  it('only the subdirectories in use are mounted, not all of /etc/grafana/provisioning', () => {
    // A bind mount shadows the whole directory: mounting all of provisioning would hide the image's built-in
    // plugins/alerting/notifiers/access-control, and Grafana would log a level=error
    // ("Failed to read ... no such file or directory") on every startup, drowning real errors in noise.
    // This pins it as a contract.
    const compose = read(COMPOSE);
    expect(compose).toContain('./grafana/provisioning/datasources:/etc/grafana/provisioning/datasources');
    expect(compose).toContain('./grafana/provisioning/dashboards:/etc/grafana/provisioning/dashboards');
    expect(compose).not.toMatch(/^\s*-\s*\.\/grafana\/provisioning:\/etc\/grafana\/provisioning/mu);
  });

  it('both mounted subdirectories contain real configuration (not empty directories)', () => {
    // Empty directories are not tracked by git, so after a fresh clone the bind mount would mount an empty directory.
    expect(read(DATASOURCE).length).toBeGreaterThan(0);
    expect(read('infrastructure/monitoring/grafana/provisioning/dashboards/dfr.yml').length).toBeGreaterThan(0);
  });
});
