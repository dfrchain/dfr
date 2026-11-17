// Span 身份不变量（M5 E6）。
// 重点：W3C 把"全零"定义为非法，因此生成器必须**不可能**产出全零——
// 这条用真实随机源跑了多轮，而不是只测一次。
import { describe, expect, it } from 'vitest';
import { isValidSpanId, isValidTraceId, newSpanId, newTraceId, nowUnixNano } from '../src/span.js';

describe('id 生成', () => {
  it('trace id 是 32 位十六进制且合法', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newTraceId();
      expect(id).toMatch(/^[0-9a-f]{32}$/u);
      expect(isValidTraceId(id)).toBe(true);
    }
  });

  it('span id 是 16 位十六进制且合法', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newSpanId();
      expect(id).toMatch(/^[0-9a-f]{16}$/u);
      expect(isValidSpanId(id)).toBe(true);
    }
  });

  it('id 不重复（抽样 500 对）', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(newSpanId());
    expect(seen.size).toBe(500);
  });
});

describe('合法性校验', () => {
  it('拒绝全零（W3C 显式非法）', () => {
    expect(isValidTraceId('0'.repeat(32))).toBe(false);
    expect(isValidSpanId('0'.repeat(16))).toBe(false);
  });

  it('拒绝长度/字符集错误', () => {
    expect(isValidTraceId('abc')).toBe(false);
    expect(isValidTraceId('Z'.repeat(32))).toBe(false);
    expect(isValidSpanId('1234567890abcde')).toBe(false);
  });
});

describe('nowUnixNano', () => {
  it('使用 BigInt，不丢精度', () => {
    // 1_700_000_000_000 ms → 1.7e18 ns，超出 Number 安全整数（9.007e15）
    expect(nowUnixNano(() => 1_700_000_000_000)).toBe('1700000000000000000');
  });
});
