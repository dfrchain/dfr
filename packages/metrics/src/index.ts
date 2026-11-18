/**
 * Prometheus metric registry primitives (a zero-dependency leaf utility).
 *
 * Why a separate package: both Gateway and Transaction need this same
 * machinery ("bounded labels + Prometheus text rendering"). Leaving it on either side, imported by the other, would blur
 * who owns the HTTP/transaction metrics. Duplicating it would be easy to fix in only one copy, so it is extracted as a zero-dependency leaf package, on the same level as `@dfr/types`
 * (it depends on no workspace package).
 *
 * Design points:
 * - **Declare before use**: `declareCounter/Histogram/Gauge` must be called before writing;
 *   a misspelled metric name throws immediately instead of silently creating a new series nobody watches;
 * - **Bounded labels**: a hard cap on the number of time series per metric (default 1000, matching observability-spec chapter 6);
 *   excess is folded into an overflow bucket and never grows without bound;
 * - **Label-value defenses (two layers of defense in depth, neither sufficient on its own)**:
 *   1. Character-set/length allowlist `[A-Za-z0-9_.:-]{1,64}` — blocks format breakage (quotes/newlines/whitespace) and overlong values;
 *   2. Hex-identifier rule — blocks address/hash shapes starting with `0x`.
 *   **The real guarantee is that call sites only pass bounded enums** (chain id, status name, method name, ...). A regex cannot recognize arbitrary high-cardinality values:
 *   a random string with no special characters still passes rule 1. Never treat this module as sufficient proof of "safe labels".
 * - **Deterministic rendering**: metrics are output sorted by name, so the same input always yields the same text (easy to snapshot and diff).
 */

export interface MetricRegistryOptions {
  /** Per-metric time-series cap; excess folds into an overflow bucket. Default 1000. */
  readonly maxSeriesPerMetric?: number;
  /** Histogram buckets (seconds, strictly increasing positives). Default covers 5ms..10s. */
  readonly histogramBucketsSeconds?: readonly number[];
}

export type MetricType = 'counter' | 'histogram' | 'gauge';

interface HistogramSeries {
  count: number;
  sum: number;
  readonly buckets: number[];
}

interface MetricDefinition {
  readonly type: MetricType;
  readonly help: string;
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const SAFE_LABEL_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const METRIC_NAME_RE = /^[a-z][a-z0-9_]*$/u;

/**
 * Shaped as `0x` followed by 40+ hex characters: EVM addresses (40) and hashes (64).
 *
 * This is **defense in depth**, not a general solution: it only covers the most realistic leak shape in this repo (addresses/hashes used as labels).
 * The real way to prevent high cardinality is for call sites to pass only bounded enums. URLs are already blocked by the character-set allowlist (it excludes `/`).
 */
const HEX_IDENTIFIER_RE = /^0x[0-9a-fA-F]{40,}$/u;

/** Label-value normalization: non-conforming values, or values shaped like addresses/hashes, fold to `other`. */
export function sanitizeLabelValue(value: string): string {
  if (!SAFE_LABEL_RE.test(value)) return 'other';
  if (HEX_IDENTIFIER_RE.test(value)) return 'other';
  return value;
}

export class MetricRegistry {
  private readonly maxSeries: number;
  private readonly buckets: readonly number[];
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();
  private readonly gauges = new Map<string, Map<string, number>>();

  constructor(options: MetricRegistryOptions = {}) {
    const maxSeries = options.maxSeriesPerMetric ?? 1_000;
    if (!Number.isInteger(maxSeries) || maxSeries < 1 || maxSeries > 10_000) {
      throw new RangeError('maxSeriesPerMetric must be an integer in 1..10000');
    }
    const buckets = [...(options.histogramBucketsSeconds ?? DEFAULT_BUCKETS)];
    if (
      buckets.some(
        (value, index) =>
          !Number.isFinite(value) || value <= 0 || (index > 0 && value <= buckets[index - 1]!),
      )
    ) {
      throw new RangeError('histogram buckets must be finite, positive, and strictly increasing');
    }
    this.maxSeries = maxSeries;
    this.buckets = buckets;
  }

  declareCounter(name: string, help: string): void {
    this.declare(name, 'counter', help);
  }

  declareHistogram(name: string, help: string): void {
    this.declare(name, 'histogram', help);
  }

  declareGauge(name: string, help: string): void {
    this.declare(name, 'gauge', help);
  }

  increment(name: string, labels: Record<string, string>, by = 1): void {
    const definition = this.requireDefinition(name, 'counter');
    void definition;
    let values = this.counters.get(name);
    if (values === undefined) {
      values = new Map();
      this.counters.set(name, values);
    }
    const bounded = this.boundLabels(values, sanitizeLabels(labels));
    const seriesKey = key(bounded);
    values.set(seriesKey, (values.get(seriesKey) ?? 0) + by);
  }

  observe(name: string, labels: Record<string, string>, rawValue: number): void {
    this.requireDefinition(name, 'histogram');
    // Non-finite or negative values are dropped outright: a NaN bucket in a histogram is worse than dropping one observation.
    if (!Number.isFinite(rawValue) || rawValue < 0) return;
    let seriesMap = this.histograms.get(name);
    if (seriesMap === undefined) {
      seriesMap = new Map();
      this.histograms.set(name, seriesMap);
    }
    const bounded = this.boundLabels(seriesMap, sanitizeLabels(labels));
    const seriesKey = key(bounded);
    let series = seriesMap.get(seriesKey);
    if (series === undefined) {
      series = { count: 0, sum: 0, buckets: this.buckets.map(() => 0) };
      seriesMap.set(seriesKey, series);
    }
    // Representation error unrelated to the implementation: keep 6 decimal places to avoid sum jitter like 0.1+0.2.
    const value = Math.round(rawValue * 1_000_000) / 1_000_000;
    // Narrow to a local constant: TS cannot keep the narrowing of `series` inside a closure (stricter under noUncheckedIndexedAccess).
    const target = series;
    target.count += 1;
    target.sum += value;
    this.buckets.forEach((bound, index) => {
      if (value <= bound) target.buckets[index] = (target.buckets[index] ?? 0) + 1;
    });
  }

  /** Set the gauge's current value (overwrite, not accumulate). */
  setGauge(name: string, labels: Record<string, string>, value: number): void {
    this.requireDefinition(name, 'gauge');
    if (!Number.isFinite(value)) return;
    let values = this.gauges.get(name);
    if (values === undefined) {
      values = new Map();
      this.gauges.set(name, values);
    }
    values.set(key(this.boundLabels(values, sanitizeLabels(labels))), value);
  }

  /** Current series count (used by tests asserting "bounded"). */
  seriesCount(name: string): number {
    return (
      this.counters.get(name)?.size ??
      this.histograms.get(name)?.size ??
      this.gauges.get(name)?.size ??
      0
    );
  }

  /** Render as Prometheus text format 0.0.4; metrics with no data are not output. */
  renderPrometheus(): string {
    const lines: string[] = [];
    for (const name of [...this.definitions.keys()].sort()) {
      const definition = this.definitions.get(name)!;
      if (definition.type === 'counter') this.writeCounter(lines, name, definition.help);
      else if (definition.type === 'gauge') this.writeGauge(lines, name, definition.help);
      else this.writeHistogram(lines, name, definition.help);
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  private declare(name: string, type: MetricType, help: string): void {
    if (!METRIC_NAME_RE.test(name)) {
      throw new Error(`invalid metric name: ${name}`);
    }
    const existing = this.definitions.get(name);
    if (existing !== undefined && existing.type !== type) {
      throw new Error(`metric ${name} already declared as ${existing.type}`);
    }
    this.definitions.set(name, { type, help });
  }

  private requireDefinition(name: string, expected: MetricType): MetricDefinition {
    const definition = this.definitions.get(name);
    if (definition === undefined) {
      throw new Error(`metric ${name} must be declared before use`);
    }
    if (definition.type !== expected) {
      throw new Error(`metric ${name} is a ${definition.type}, not a ${expected}`);
    }
    return definition;
  }

  /**
   * Hard cap on series count; on overflow, replace `chain` with `other` (keeping the other labels so availability information is not lost),
   * and only fold into a single overflow bucket after further overflow.
   */
  private boundLabels<T>(
    values: Map<string, T>,
    labels: Record<string, string>,
  ): Record<string, string> {
    if (values.has(key(labels)) || values.size < this.maxSeries - 1) return labels;
    const overflow = { ...labels, chain: 'other' };
    if (values.has(key(overflow)) || values.size < this.maxSeries) return overflow;
    return { chain: 'other', metric_overflow: 'true' };
  }

  private writeCounter(lines: string[], name: string, help: string): void {
    const values = this.counters.get(name);
    if (values === undefined || values.size === 0) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const [seriesKey, count] of values) lines.push(`${name}${formatLabels(seriesKey)} ${count}`);
  }

  private writeGauge(lines: string[], name: string, help: string): void {
    const values = this.gauges.get(name);
    if (values === undefined || values.size === 0) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [seriesKey, value] of values) {
      lines.push(`${name}${formatLabels(seriesKey)} ${formatNumber(value)}`);
    }
  }

  private writeHistogram(lines: string[], name: string, help: string): void {
    const values = this.histograms.get(name);
    if (values === undefined || values.size === 0) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
    for (const [seriesKey, series] of values) {
      const labels = parseKey(seriesKey);
      this.buckets.forEach((bound, index) => {
        lines.push(
          `${name}_bucket${formatLabels({ ...labels, le: String(bound) })} ${series.buckets[index]}`,
        );
      });
      lines.push(`${name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${series.count}`);
      lines.push(`${name}_sum${formatLabels(labels)} ${formatNumber(series.sum)}`);
      lines.push(`${name}_count${formatLabels(labels)} ${series.count}`);
    }
  }
}

/**
 * Label values are always normalized (callers are not trusted): writing addresses / hashes / URLs and the like into labels is a cardinality disaster,
 * and "remember to sanitize at every call site" is manual discipline that is easy to miss. Putting it on the write path makes it structurally impossible to miss.
 */
function sanitizeLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(labels)) out[name] = sanitizeLabelValue(value);
  return out;
}

function key(labels: Record<string, string>): string {
  return JSON.stringify(labels);
}

function parseKey(value: string): Record<string, string> {
  return JSON.parse(value) as Record<string, string>;
}

function formatLabels(value: string | Record<string, string>): string {
  const labels = typeof value === 'string' ? parseKey(value) : value;
  return `{${Object.entries(labels)
    .map(([name, entry]) => `${name}="${escapeLabel(entry)}"`)
    .join(',')}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/"/gu, '\\"');
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '');
}
