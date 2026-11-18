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

describe('M0 static API Key authentication (auth-tenancy-spec chapter 3)', () => {
  const secret = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const pepper = 'pepper-value';
  const config: StaticApiKeyConfig = {
    keyId: '7Kq2mXpA',
    currentHash: hashSecret(secret, pepper),
    pepper,
    projectId: 'default',
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  };

  it('the hash is sha256(secret+pepper), and differs from the plaintext', () => {
    expect(config.currentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(config.currentHash).not.toContain(secret);
  });

  it('a valid Key passes, returning keyId and projectId', () => {
    const result = verifyApiKey(`dfr_7Kq2mXpA_${secret}`, config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyId).toBe('7Kq2mXpA');
      expect(result.projectId).toBe('default');
    }
  });

  it('missing / malformed / hash-mismatched Keys all normalize to the same failure, without leaking whether the keyId exists', () => {
    const missing = verifyApiKey(undefined, config);
    const malformed = verifyApiKey('not-a-key', config);
    const wrongSecret = verifyApiKey('dfr_7Kq2mXpA_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', config);
    const unknownKeyId = verifyApiKey(`dfr_00000000_${secret}`, config);

    expect(missing.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    // Correct keyId but wrong secret → follows the same failure path as a nonexistent keyId.
    expect(wrongSecret.ok).toBe(false);
    expect(unknownKeyId.ok).toBe(false);
    if (!wrongSecret.ok && !unknownKeyId.ok) {
      expect(wrongSecret.reason).toBe('mismatch');
      expect(unknownKeyId.reason).toBe('mismatch');
    }
  });

  it('rotation dual-active: current and previous are both usable (zero-downtime rotation)', () => {
    const newSecret = 'brandnewsecretbrandnewsecretbrandnew';
    const rotated: StaticApiKeyConfig = {
      ...config,
      keyId: 'NewKey01',
      currentHash: hashSecret(newSecret, pepper),
      previousKeyId: '7Kq2mXpA',
      previousHash: hashSecret(secret, pepper),
    };
    // New and old Keys are both usable inside the rotation window.
    expect(verifyApiKey(`dfr_NewKey01_${newSecret}`, rotated).ok).toBe(true);
    expect(verifyApiKey(`dfr_7Kq2mXpA_${secret}`, rotated).ok).toBe(true);
    // An old keyId with a new secret must fail (the hash is bound to the keyId; cross-combinations are not allowed).
    expect(verifyApiKey(`dfr_7Kq2mXpA_${newSecret}`, rotated).ok).toBe(false);
  });

  it('constant-time comparison: different lengths do not throw and return false', () => {
    expect(constantTimeEqualHex('ab', 'ab')).toBe(true);
    expect(constantTimeEqualHex('ab', 'abcd')).toBe(false);
    expect(constantTimeEqualHex('ab', 'cd')).toBe(false);
  });

  it('scope checks: chains and capabilities', () => {
    const scoped = { chains: ['ethereum-sepolia' as never], capabilities: ['block.read' as never], allowWrite: false };
    expect(scopeAllows(scoped, { chain: 'ethereum-sepolia', capability: 'block.read' })).toBe(true);
    expect(scopeAllows(scoped, { chain: 'solana-devnet' })).toBe(false);
    expect(scopeAllows(scoped, { capability: 'transaction.broadcast' })).toBe(false);
    expect(scopeAllows({ ...scoped, chains: '*', capabilities: '*' }, { chain: 'anything' })).toBe(true);
  });
});

describe('token bucket rate limiting (gateway-spec chapter 5)', () => {
  it('admits within capacity, rejects beyond it, and gives a Retry-After basis', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(DEFAULT_BUCKETS, () => now);
    const capacity = DEFAULT_BUCKETS.read.capacity;

    for (let i = 0; i < capacity; i += 1) {
      expect(limiter.check('default:key1', 'read').allowed, `#${i}`).toBe(true);
    }
    const denied = limiter.check('default:key1', 'read');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    // After 1s of refill, at least 1 more admission is possible.
    now += 1000;
    expect(limiter.check('default:key1', 'read').allowed).toBe(true);
  });

  it('not a fixed window: no 2x admission at the boundary', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(DEFAULT_BUCKETS, () => now);
    const capacity = DEFAULT_BUCKETS.read.capacity;
    for (let i = 0; i < capacity; i += 1) limiter.check('p:k', 'read');
    // A fixed window would instantly admit a whole bucket (capacity) when the window flips. A token bucket does not.
    now += 1000; // refills only 20 tokens (the read refill rate)
    let allowed = 0;
    while (limiter.check('p:k', 'read').allowed) allowed += 1;
    expect(allowed).toBeLessThan(capacity);
  });

  it('a clock moving backwards cannot conjure tokens or bypass rate limiting', () => {
    let now = 10_000;
    const limiter = new TokenBucketLimiter({
      read: { capacity: 1, refillPerSecond: 1 },
      write: { capacity: 1, refillPerSecond: 1 },
      stream: { capacity: 1, refillPerSecond: 1 },
    }, () => now);

    expect(limiter.check('p:k', 'read').allowed).toBe(true);
    // After the clock moves backwards, updatedAt must not move backwards too, or tokens would appear from nowhere when the clock recovers.
    now = 0;
    expect(limiter.check('p:k', 'read').allowed).toBe(false);
    now = 10_000;
    expect(limiter.check('p:k', 'read').allowed).toBe(false);
    now = 11_000;
    expect(limiter.check('p:k', 'read').allowed).toBe(true);
  });

  it('buckets are isolated by (project,key,routeClass)', () => {
    const limiter = new TokenBucketLimiter(DEFAULT_BUCKETS, () => 0);
    for (let i = 0; i < DEFAULT_BUCKETS.read.capacity; i += 1) limiter.check('p:k1', 'read');
    expect(limiter.check('p:k1', 'read').allowed).toBe(false);
    expect(limiter.check('p:k2', 'read').allowed).toBe(true);
    expect(limiter.check('p:k1', 'write').allowed).toBe(true);
  });
});

describe('BlockRef syntax parsing (review fix R-20)', () => {
  it('all four tagged syntaxes parse into a discriminated union', () => {
    expect(parseBlockRef('number:123', REQ)).toEqual({ kind: 'number', number: '123' });
    expect(parseBlockRef('hash:0xabc', REQ)).toEqual({ kind: 'hash', hash: '0xabc' });
    expect(parseBlockRef('slot:7', REQ)).toEqual({ kind: 'slot', slot: '7' });
    expect(parseBlockRef('tag:finalized', REQ)).toEqual({ kind: 'tag', tag: 'finalized' });
  });

  it('bare numbers / unknown tags → DFR_VALIDATION_FAILED', () => {
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

describe('error categories are only constructed at the layer where they belong', () => {
  it('the gateway only constructs auth / policy / client errors', () => {
    const codes = ['DFR_UNAUTHENTICATED', 'DFR_RATE_LIMITED', 'DFR_VALIDATION_FAILED', 'DFR_NOT_FOUND'];
    for (const code of codes) {
      const err = createDfrError(code as never, { requestId: REQ });
      expect(['auth', 'policy', 'client']).toContain(err.category);
    }
  });
});
