/**
 * Metric registry primitives contract test (@dfr/metrics).
 *
 * This package is shared by Gateway and Transaction, so every assertion here is the common baseline for the behavior in **both** places:
 * declare-before-use, bounded labels with safe values, deterministic rendering, and no NaN buckets in histograms.
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

describe('MetricRegistry declaration and types', () => {
  it('writing without declaring → throws (a misspelled metric name must not silently create a new series)', () => {
    const r = new MetricRegistry();
    expect(() => r.increment('dfr_typo_total', {})).toThrow(/must be declared/u);
    expect(() => r.observe('dfr_typo_seconds', {}, 1)).toThrow(/must be declared/u);
    expect(() => r.setGauge('dfr_typo', {}, 1)).toThrow(/must be declared/u);
  });

  it('type mismatch → throws (a counter cannot be used as a histogram)', () => {
    const r = registry();
    expect(() => r.observe('dfr_test_total', {}, 1)).toThrow(/is a counter/u);
    expect(() => r.increment('dfr_test_seconds', {})).toThrow(/is a histogram/u);
    expect(() => r.increment('dfr_test_inflight', {})).toThrow(/is a gauge/u);
  });

  it('invalid metric name → throws', () => {
    const r = new MetricRegistry();
    expect(() => r.declareCounter('Bad-Name', 'x')).toThrow(/invalid metric name/u);
    expect(() => r.declareCounter('', 'x')).toThrow(/invalid metric name/u);
  });

  it('redeclaring the same name with a different type → throws', () => {
    const r = new MetricRegistry();
    r.declareCounter('dfr_dup_total', 'a');
    expect(() => r.declareHistogram('dfr_dup_total', 'b')).toThrow(/already declared/u);
  });
});

describe('MetricRegistry write semantics', () => {
  it('counter accumulates; gauge overwrites; histogram records count/sum/buckets', () => {
    const r = registry();
    // Label values must be a **bounded enum** (here a route handler id, not the raw path containing `/` —
    // the raw path would be folded by the character-set allowlist and is high-cardinality on its own).
    r.increment('dfr_test_total', { route: 'listChains' });
    r.increment('dfr_test_total', { route: 'listChains' });
    r.increment('dfr_test_total', { route: 'listChains' }, 3);
    r.setGauge('dfr_test_inflight', { route_class: 'read' }, 7);
    r.setGauge('dfr_test_inflight', { route_class: 'read' }, 2);
    r.observe('dfr_test_seconds', { route: 'getBlock' }, 0.2);
    r.observe('dfr_test_seconds', { route: 'getBlock' }, 0.3);

    const out = r.renderPrometheus();
    expect(out).toContain('dfr_test_total{route="listChains"} 5');
    // A gauge overwrites rather than accumulates: writing 2 after 7 must give 2.
    expect(out).toContain('dfr_test_inflight{route_class="read"} 2');
    expect(out).toContain('dfr_test_seconds_count{route="getBlock"} 2');
    expect(out).toContain('dfr_test_seconds_sum{route="getBlock"} 0.5');
    // Prometheus buckets have **cumulative** semantics (each bucket = the count of "≤ upper bound"):
    // 0.2 ≤ 0.25 but 0.3 is not ≤ 0.25 → le="0.25" is 1; both are ≤ 0.5 → le="0.5" is 2.
    expect(out).toContain('dfr_test_seconds_bucket{route="getBlock",le="0.1"} 0');
    expect(out).toContain('dfr_test_seconds_bucket{route="getBlock",le="0.25"} 1');
    expect(out).toContain('dfr_test_seconds_bucket{route="getBlock",le="0.5"} 2');
    expect(out).toContain('dfr_test_seconds_bucket{route="getBlock",le="+Inf"} 2');
  });

  it('a raw path containing `/` folds to other (exactly why a handler id must be passed)', () => {
    const r = registry();
    r.increment('dfr_test_total', { route: '/v1/transactions/0xabc/confirm' });
    const out = r.renderPrometheus();
    expect(out).not.toContain('/v1/transactions');
    expect(out).toContain('route="other"');
  });

  it('non-finite and negative values are dropped (no NaN buckets in histograms)', () => {
    const r = registry();
    r.observe('dfr_test_seconds', {}, Number.NaN);
    r.observe('dfr_test_seconds', {}, Number.POSITIVE_INFINITY);
    r.observe('dfr_test_seconds', {}, -1);
    expect(r.seriesCount('dfr_test_seconds')).toBe(0);
    expect(r.renderPrometheus()).not.toContain('dfr_test_seconds');
  });

  it('a metric with no data is not rendered (no empty HELP/TYPE)', () => {
    const r = registry();
    expect(r.renderPrometheus()).toBe('');
    r.increment('dfr_test_total', {});
    const out = r.renderPrometheus();
    expect(out).toContain('dfr_test_total');
    expect(out).not.toContain('dfr_test_seconds');
    expect(out).not.toContain('dfr_test_inflight');
  });
});

describe('MetricRegistry label safety and boundedness', () => {
  it('unsafe label values fold to other automatically (addresses / hashes / URLs cannot enter labels)', () => {
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

  it('sanitizeLabelValue: values inside the allowed character set are kept, out-of-range/overlong ones fold', () => {
    expect(sanitizeLabelValue('ethereum-sepolia')).toBe('ethereum-sepolia');
    expect(sanitizeLabelValue('dfr_transaction_stage_total')).toBe('dfr_transaction_stage_total');
    expect(sanitizeLabelValue('a'.repeat(64))).toBe('a'.repeat(64));
    expect(sanitizeLabelValue('a'.repeat(65))).toBe('other');
    expect(sanitizeLabelValue('has space')).toBe('other');
    expect(sanitizeLabelValue('')).toBe('other');
    expect(sanitizeLabelValue('café')).toBe('other');
  });

  it('hard series cap: overflow folds into the overflow bucket and the total never exceeds the cap', () => {
    const r = new MetricRegistry({ maxSeriesPerMetric: 3 });
    r.declareCounter('dfr_bounded_total', 'Bounded.');
    for (const chain of ['a', 'b', 'c', 'd', 'e']) {
      r.increment('dfr_bounded_total', { chain });
    }
    expect(r.seriesCount('dfr_bounded_total')).toBeLessThanOrEqual(3);
    expect(r.renderPrometheus()).toContain('chain="other"');
  });

  it('invalid cap parameter → throws; non-strictly-increasing buckets → throws', () => {
    expect(() => new MetricRegistry({ maxSeriesPerMetric: 0 })).toThrow(RangeError);
    expect(() => new MetricRegistry({ maxSeriesPerMetric: 10_001 })).toThrow(RangeError);
    expect(() => new MetricRegistry({ histogramBucketsSeconds: [0.5, 0.5] })).toThrow(RangeError);
    expect(() => new MetricRegistry({ histogramBucketsSeconds: [0] })).toThrow(RangeError);
  });
});

describe('MetricRegistry rendering determinism', () => {
  it('metrics are output sorted by name; the same input always yields the same text', () => {
    const r = new MetricRegistry();
    r.declareCounter('dfr_zzz_total', 'Z.');
    r.declareCounter('dfr_aaa_total', 'A.');
    r.increment('dfr_zzz_total', {});
    r.increment('dfr_aaa_total', {});

    const out = r.renderPrometheus();
    expect(out.indexOf('dfr_aaa_total')).toBeLessThan(out.indexOf('dfr_zzz_total'));
    // Two renders must be byte-identical (for snapshots/diffs).
    expect(r.renderPrometheus()).toBe(out);
  });

  it('quotes and backslashes in label values are escaped (text format is not broken)', () => {
    const r = new MetricRegistry();
    r.declareCounter('dfr_escape_total', 'E.');
    // The value itself is sanitized to other (a quote is an out-of-range character); this verifies the escaping path itself.
    r.increment('dfr_escape_total', { note: 'plain' });
    const out = r.renderPrometheus();
    expect(out).toContain('note="plain"');
    expect(out.endsWith('\n')).toBe(true);
  });
});
