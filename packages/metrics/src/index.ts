/**
 * Prometheus 指标注册表原语（零依赖叶子工具）。
 *
 * 为什么单独成包：Gateway 与 Transaction 都需要"有界标签 + Prometheus 文本渲染"这同一套
 * 机制。把它留在任一侧、由另一侧 import，会让"谁拥有 HTTP/事务指标"的归属变得含糊；
 * 复制两份则是并发无关但极易只修一份的重复。因此提取为零依赖叶子包，与 `@dfr/types`
 * 同一量级（不依赖任何工作区包）。
 *
 * 设计要点：
 * - **先声明后使用**：`declareCounter/Histogram/Gauge` 必须在写入前调用，
 *   拼错指标名会立刻抛错，而不是静默产生一个没人看的新序列；
 * - **标签有界**：单个指标的时间序列数硬上限（默认 1000，与 observability-spec 第 6 章一致），
 *   超出时折叠到溢出桶，绝不无限增长；
 * - **标签值防线（两层纵深防御，都不是充分条件）**：
  1. 字符集/长度白名单 `[A-Za-z0-9_.:-]{1,64}`——挡住格式破坏（引号/换行/空白）与超长值；
  2. 十六进制标识符规则——挡住 `0x` 开头的地址/哈希形态。
  **真正的保证来自调用点只传有界枚举**（chain id、状态名、方法名…）。正则无法识别任意高基数值：
  一个不含特殊字符的随机字符串仍会通过第 1 条。切勿把本模块当"安全标签"的充分证明。
 * - **渲染确定性**：指标按名称排序输出，同一输入必得同一文本（便于快照与 diff）。
 */

export interface MetricRegistryOptions {
  /** 单指标时间序列上限；超出折叠到溢出桶。默认 1000。 */
  readonly maxSeriesPerMetric?: number;
  /** 直方图桶（秒，严格递增正数）。默认覆盖 5ms..10s。 */
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
 * 形如 `0x` 后跟 40+ 个十六进制字符：EVM 地址（40）与各种哈希（64）。
 *
 * 这是**纵深防御**，不是通用解法：它只覆盖本仓库最现实的泄漏形态（把地址/哈希当标签）。
 * 真正防止高基数的办法是调用点只传有界枚举。URL 已由字符集白名单挡住（含 `/`）。
 */
const HEX_IDENTIFIER_RE = /^0x[0-9a-fA-F]{40,}$/u;

/** 标签值规范化：不合规或形似地址/哈希的值折叠为 `other`。 */
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
    // 非有限值或负值直接丢弃：让直方图出现 NaN 桶比丢掉一次观测更糟。
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
    // 与实现无关的表示误差：保留 6 位小数，避免 0.1+0.2 之类的和值抖动。
    const value = Math.round(rawValue * 1_000_000) / 1_000_000;
    // 收窄到局部常量：闭包内 TS 无法保持对 `series` 的窄化（noUncheckedIndexedAccess 下更严格）。
    const target = series;
    target.count += 1;
    target.sum += value;
    this.buckets.forEach((bound, index) => {
      if (value <= bound) target.buckets[index] = (target.buckets[index] ?? 0) + 1;
    });
  }

  /** 设置 gauge 当前值（覆盖，不累加）。 */
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

  /** 当前序列数（测试断言"有界"用）。 */
  seriesCount(name: string): number {
    return (
      this.counters.get(name)?.size ??
      this.histograms.get(name)?.size ??
      this.gauges.get(name)?.size ??
      0
    );
  }

  /** 渲染为 Prometheus 文本格式 0.0.4；无数据的指标不输出。 */
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
   * 序列数硬上限；超出时把 `chain` 替换为 `other`（保留其余标签以免丢失可用性信息），
   * 再超时才折叠为单一溢出桶。
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
 * 标签值一律规范化（不信任调用方）：把地址 / 哈希 / URL 之类写进标签是基数灾难，
 * 而"记得在每处调用点 sanitize" 是容易漏的人工纪律。放在写入路径上则结构上不可能漏。
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
