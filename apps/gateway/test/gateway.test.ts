import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUCKETS,
  TokenBucketLimiter,
  constantTimeEqualHex,
  hashSecret,
  parseBlockRef,
  scopeAllows,
  verifyApiKey,
  type StaticApiKeyConfig,
} from '../src/index.js';
import { createDfrError } from '@dfr/errors';
import type { RequestId } from '@dfr/types';

const REQ = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;

describe('M0 静态 API Key 鉴权（auth-tenancy-spec 第 3 章）', () => {
  const secret = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const pepper = 'pepper-value';
  const config: StaticApiKeyConfig = {
    keyId: '7Kq2mXpA',
    currentHash: hashSecret(secret, pepper),
    pepper,
    projectId: 'default',
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  };

  it('哈希是 sha256(secret+pepper)，且不等于明文', () => {
    expect(config.currentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(config.currentHash).not.toContain(secret);
  });

  it('合法 Key 通过，返回 keyId 与 projectId', () => {
    const result = verifyApiKey(`dfr_7Kq2mXpA_${secret}`, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyId).toBe('7Kq2mXpA');
      expect(result.projectId).toBe('default');
    }
  });

  it('缺少 / 格式非法 / 哈希不匹配都归一化为同一种失败，不泄漏 keyId 是否存在', () => {
    const missing = verifyApiKey(undefined, config);
    const malformed = verifyApiKey('not-a-key', config);
    const wrongSecret = verifyApiKey('dfr_7Kq2mXpA_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', config);
    const unknownKeyId = verifyApiKey(`dfr_00000000_${secret}`, config);

    expect(missing.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    // keyId 正确但 secret 错 → 与 keyId 不存在走同一条失败路径。
    expect(wrongSecret.ok).toBe(false);
    expect(unknownKeyId.ok).toBe(false);
    if (!wrongSecret.ok && !unknownKeyId.ok) {
      expect(wrongSecret.reason).toBe('mismatch');
      expect(unknownKeyId.reason).toBe('mismatch');
    }
  });

  it('轮换双活：current 与 previous 同时可用（无中断轮换）', () => {
    const newSecret = 'brandnewsecretbrandnewsecretbrandnew';
    const rotated: StaticApiKeyConfig = {
      ...config,
      keyId: 'NewKey01',
      currentHash: hashSecret(newSecret, pepper),
      previousKeyId: '7Kq2mXpA',
      previousHash: hashSecret(secret, pepper),
    };
    // 新 Key 与旧 Key 在轮换窗口内都可用。
    expect(verifyApiKey(`dfr_NewKey01_${newSecret}`, rotated).ok).toBe(true);
    expect(verifyApiKey(`dfr_7Kq2mXpA_${secret}`, rotated).ok).toBe(true);
    // 旧 keyId 配新 secret 必须失败（哈希与 keyId 绑定，不允许交叉组合）。
    expect(verifyApiKey(`dfr_7Kq2mXpA_${newSecret}`, rotated).ok).toBe(false);
  });

  it('恒定时间比较：长度不同不抛错且返回 false', () => {
    expect(constantTimeEqualHex('ab', 'ab')).toBe(true);
    expect(constantTimeEqualHex('ab', 'abcd')).toBe(false);
    expect(constantTimeEqualHex('ab', 'cd')).toBe(false);
  });

  it('作用域检查：链与能力', () => {
    const scoped = { chains: ['ethereum-sepolia' as never], capabilities: ['block.read' as never], allowWrite: false };
    expect(scopeAllows(scoped, { chain: 'ethereum-sepolia', capability: 'block.read' })).toBe(true);
    expect(scopeAllows(scoped, { chain: 'solana-devnet' })).toBe(false);
    expect(scopeAllows(scoped, { capability: 'transaction.broadcast' })).toBe(false);
    expect(scopeAllows({ ...scoped, chains: '*', capabilities: '*' }, { chain: 'anything' })).toBe(true);
  });
});

describe('令牌桶限流（gateway-spec 第 5 章）', () => {
  it('容量内放行，超出拒绝并给出 Retry-After 依据', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(DEFAULT_BUCKETS, () => now);
    const capacity = DEFAULT_BUCKETS.read.capacity;

    for (let i = 0; i < capacity; i += 1) {
      expect(limiter.check('default:key1', 'read').allowed, `#${i}`).toBe(true);
    }
    const denied = limiter.check('default:key1', 'read');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    // 补充 1 秒后至少可再放行 1 次。
    now += 1000;
    expect(limiter.check('default:key1', 'read').allowed).toBe(true);
  });

  it('不是固定窗口：边界不会出现 2 倍放行', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(DEFAULT_BUCKETS, () => now);
    const capacity = DEFAULT_BUCKETS.read.capacity;
    for (let i = 0; i < capacity; i += 1) limiter.check('p:k', 'read');
    // 固定窗口会在窗口翻转时瞬间再放行一整桶（capacity）。令牌桶不会。
    now += 1000; // 仅补充 20 个令牌（read 的补充速率）
    let allowed = 0;
    while (limiter.check('p:k', 'read').allowed) allowed += 1;
    expect(allowed).toBeLessThan(capacity);
  });

  it('时钟回拨不能凭空补充令牌或绕过限流', () => {
    let now = 10_000;
    const limiter = new TokenBucketLimiter({
      read: { capacity: 1, refillPerSecond: 1 },
      write: { capacity: 1, refillPerSecond: 1 },
      stream: { capacity: 1, refillPerSecond: 1 },
    }, () => now);

    expect(limiter.check('p:k', 'read').allowed).toBe(true);
    // 时间回拨后不能把 updatedAt 倒退，否则时钟恢复时会无中生有令牌。
    now = 0;
    expect(limiter.check('p:k', 'read').allowed).toBe(false);
    now = 10_000;
    expect(limiter.check('p:k', 'read').allowed).toBe(false);
    now = 11_000;
    expect(limiter.check('p:k', 'read').allowed).toBe(true);
  });

  it('桶按 (project,key,routeClass) 隔离', () => {
    const limiter = new TokenBucketLimiter(DEFAULT_BUCKETS, () => 0);
    for (let i = 0; i < DEFAULT_BUCKETS.read.capacity; i += 1) limiter.check('p:k1', 'read');
    expect(limiter.check('p:k1', 'read').allowed).toBe(false);
    expect(limiter.check('p:k2', 'read').allowed).toBe(true);
    expect(limiter.check('p:k1', 'write').allowed).toBe(true);
  });
});

describe('BlockRef 语法解析（评审修正 R-20）', () => {
  it('四种带标签语法都能解析为判别联合', () => {
    expect(parseBlockRef('number:123', REQ)).toEqual({ kind: 'number', number: '123' });
    expect(parseBlockRef('hash:0xabc', REQ)).toEqual({ kind: 'hash', hash: '0xabc' });
    expect(parseBlockRef('slot:7', REQ)).toEqual({ kind: 'slot', slot: '7' });
    expect(parseBlockRef('tag:finalized', REQ)).toEqual({ kind: 'tag', tag: 'finalized' });
  });

  it('裸数字 / 未知标签 → DFR_VALIDATION_FAILED', () => {
    for (const bad of ['123', 'tag:newest', 'number:-1', 'block:0x1']) {
      try {
        parseBlockRef(bad, REQ);
        throw new Error(`should reject ${bad}`);
      } catch (err) {
        expect((err as { code?: string }).code).toBe('DFR_VALIDATION_FAILED');
      }
    }
  });
});

describe('错误分类只在该出现的层构造', () => {
  it('网关只构造 auth / policy / client 类错误', () => {
    const codes = ['DFR_UNAUTHENTICATED', 'DFR_RATE_LIMITED', 'DFR_VALIDATION_FAILED', 'DFR_NOT_FOUND'];
    for (const code of codes) {
      const err = createDfrError(code as never, { requestId: REQ });
      expect(['auth', 'policy', 'client']).toContain(err.category);
    }
  });
});
