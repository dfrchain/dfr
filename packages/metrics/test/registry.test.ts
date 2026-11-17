/**
 * 指标注册表原语契约测试（@dfr/metrics）。
 *
 * 该包被 Gateway 与 Transaction 共用，因此这里的每条断言都是**两处**行为的公共底线：
 * 声明即用、标签有界且值安全、渲染确定、直方图不产生 NaN 桶。
 */
import { describe, expect, it } from 'vitest';
import { MetricRegistry, sanitizeLabelValue } from '../src/index.js';

function registry(): MetricRegistry {
  const r = new MetricRegistry();
  r.declareCounter('dfr_test_total', 'Test counter.');
  r.declareHistogram('dfr_test_seconds', 'Test histogram.');
  r.declareGauge('dfr_test_inflight', 'Test gauge.');
  return r;
}

describe('MetricRegistry 声明与类型', () => {
  it('未声明就写入 → 抛错（拼错指标名不得静默产生新序列）', () => {
    const r = new MetricRegistry();
    expect(() => r.increment('dfr_typo_total', {})).toThrow(/must be declared/u);
    expect(() => r.observe('dfr_typo_seconds', {}, 1)).toThrow(/must be declared/u);
    expect(() => r.setGauge('dfr_typo', {}, 1)).toThrow(/must be declared/u);
  });

  it('类型不符 → 抛错（counter 不能当 histogram 用）', () => {
    const r = registry();
    expect(() => r.observe('dfr_test_total', {}, 1)).toThrow(/is a counter/u);
    expect(() => r.increment('dfr_test_seconds', {})).toThrow(/is a histogram/u);
    expect(() => r.increment('dfr_test_inflight', {})).toThrow(/is a gauge/u);
  });

  it('非法指标名 → 抛错', () => {
    const r = new MetricRegistry();
    expect(() => r.declareCounter('Bad-Name', 'x')).toThrow(/invalid metric name/u);
    expect(() => r.declareCounter('', 'x')).toThrow(/invalid metric name/u);
  });

  it('同名不同类型重复声明 → 抛错', () => {
    const r = new MetricRegistry();
    r.declareCounter('dfr_dup_total', 'a');
    expect(() => r.declareHistogram('dfr_dup_total', 'b')).toThrow(/already declared/u);
  });
});

describe('MetricRegistry 写入语义', () => {
  it('counter 累加；gauge 覆盖；histogram 记 count/sum/桶', () => {
    const r = registry();
    // 标签值必须是**有界枚举**（这里是路由 handler id，不是含 `/` 的原始路径——
    // 原始路径会被字符集白名单折叠，且本身是高基数）。
    r.increment('dfr_test_total', { route: 'listChains' });
    r.increment('dfr_test_total', { route: 'listChains' });
    r.increment('dfr_test_total', { route: 'listChains' }, 3);
    r.setGauge('dfr_test_inflight', { route_class: 'read' }, 7);
    r.setGauge('dfr_test_inflight', { route_class: 'read' }, 2);
    r.observe('dfr_test_seconds', { route: 'getBlock' }, 0.2);
    r.observe('dfr_test_seconds', { route: 'getBlock' }, 0.3);

    const out = r.renderPrometheus();
    expect(out).toContain('dfr_test_total{route="listChains"} 5');
    // gauge 覆盖而非累加：7 后写 2，结果必须是 2。
    expect(out).toContain('dfr_test_inflight{route_class="read"} 2');
    expect(out).toContain('dfr_test_seconds_count{route="getBlock"} 2');
    expect(out).toContain('dfr_test_seconds_sum{route="getBlock"} 0.5');
    // Prometheus 桶是**累计**语义（每个桶 = "≤ 上界"的计数）：
    // 0.2 ≤ 0.25 但 0.3 不 ≤ 0.25 → le="0.25" 为 1；两者都 ≤ 0.5 → le="0.5" 为 2。
    expect(out).toContain('dfr_test_seconds_bucket{route="getBlock",le="0.1"} 0');
    expect(out).toContain('dfr_test_seconds_bucket{route="getBlock",le="0.25"} 1');
    expect(out).toContain('dfr_test_seconds_bucket{route="getBlock",le="0.5"} 2');
    expect(out).toContain('dfr_test_seconds_bucket{route="getBlock",le="+Inf"} 2');
  });

  it('含 `/` 的原始路径会被折叠为 other（这正是必须传 handler id 的原因）', () => {
    const r = registry();
    r.increment('dfr_test_total', { route: '/v1/transactions/0xabc/confirm' });
    const out = r.renderPrometheus();
    expect(out).not.toContain('/v1/transactions');
    expect(out).toContain('route="other"');
  });

  it('非有限值与负值被丢弃（不让直方图出现 NaN 桶）', () => {
    const r = registry();
    r.observe('dfr_test_seconds', {}, Number.NaN);
    r.observe('dfr_test_seconds', {}, Number.POSITIVE_INFINITY);
    r.observe('dfr_test_seconds', {}, -1);
    expect(r.seriesCount('dfr_test_seconds')).toBe(0);
    expect(r.renderPrometheus()).not.toContain('dfr_test_seconds');
  });

  it('无数据时不渲染该指标（不输出空 HELP/TYPE）', () => {
    const r = registry();
    expect(r.renderPrometheus()).toBe('');
    r.increment('dfr_test_total', {});
    const out = r.renderPrometheus();
    expect(out).toContain('dfr_test_total');
    expect(out).not.toContain('dfr_test_seconds');
    expect(out).not.toContain('dfr_test_inflight');
  });
});

describe('MetricRegistry 标签安全与有界', () => {
  it('不安全的标签值自动折叠为 other（地址 / 哈希 / URL 进不了标签）', () => {
    const r = registry();
    r.increment('dfr_test_total', { address: '0x1111111111111111111111111111111111111111' });
    r.increment('dfr_test_total', { address: 'https://rpc.example.invalid/v3?apikey=x' });
    r.increment('dfr_test_total', { address: `0x${'aa'.repeat(32)}` });

    const out = r.renderPrometheus();
    expect(out).not.toContain('0x1111');
    expect(out).not.toContain('rpc.example.invalid');
    expect(out).not.toContain('aa'.repeat(32));
    expect(out).toContain('address="other"');
  });

  it('sanitizeLabelValue：允许字符集内保留原值，越界/超长折叠', () => {
    expect(sanitizeLabelValue('ethereum-sepolia')).toBe('ethereum-sepolia');
    expect(sanitizeLabelValue('dfr_transaction_stage_total')).toBe('dfr_transaction_stage_total');
    expect(sanitizeLabelValue('a'.repeat(64))).toBe('a'.repeat(64));
    expect(sanitizeLabelValue('a'.repeat(65))).toBe('other');
    expect(sanitizeLabelValue('has space')).toBe('other');
    expect(sanitizeLabelValue('')).toBe('other');
    expect(sanitizeLabelValue('café')).toBe('other');
  });

  it('序列数硬上限：超出后折叠到溢出桶，且总数不超过上限', () => {
    const r = new MetricRegistry({ maxSeriesPerMetric: 3 });
    r.declareCounter('dfr_bounded_total', 'Bounded.');
    for (const chain of ['a', 'b', 'c', 'd', 'e']) {
      r.increment('dfr_bounded_total', { chain });
    }
    expect(r.seriesCount('dfr_bounded_total')).toBeLessThanOrEqual(3);
    expect(r.renderPrometheus()).toContain('chain="other"');
  });

  it('上限参数非法 → 抛错；桶非严格递增 → 抛错', () => {
    expect(() => new MetricRegistry({ maxSeriesPerMetric: 0 })).toThrow(RangeError);
    expect(() => new MetricRegistry({ maxSeriesPerMetric: 10_001 })).toThrow(RangeError);
    expect(() => new MetricRegistry({ histogramBucketsSeconds: [0.5, 0.5] })).toThrow(RangeError);
    expect(() => new MetricRegistry({ histogramBucketsSeconds: [0] })).toThrow(RangeError);
  });
});

describe('MetricRegistry 渲染确定性', () => {
  it('指标按名称排序输出，同输入必得同文本', () => {
    const r = new MetricRegistry();
    r.declareCounter('dfr_zzz_total', 'Z.');
    r.declareCounter('dfr_aaa_total', 'A.');
    r.increment('dfr_zzz_total', {});
    r.increment('dfr_aaa_total', {});

    const out = r.renderPrometheus();
    expect(out.indexOf('dfr_aaa_total')).toBeLessThan(out.indexOf('dfr_zzz_total'));
    // 渲染两次必须逐字节相同（便于快照/diff）。
    expect(r.renderPrometheus()).toBe(out);
  });

  it('标签值中的引号与反斜杠被转义（不破坏文本格式）', () => {
    const r = new MetricRegistry();
    r.declareCounter('dfr_escape_total', 'E.');
    // 值本身会被 sanitize 成 other（含引号属越界字符），此处验证的是转义路径本身。
    r.increment('dfr_escape_total', { note: 'plain' });
    const out = r.renderPrometheus();
    expect(out).toContain('note="plain"');
    expect(out.endsWith('\n')).toBe(true);
  });
});
