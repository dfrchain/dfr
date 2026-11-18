import { describe, expect, it } from 'vitest';
import type { ChainId, ProviderDescriptor } from '@dfr/types';
import { isDfrError } from '@dfr/errors';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_OPTIONS,
  JsonRpcHttpProvider,
  ProviderManager,
  createStubFetch,
  decideRetry,
  scoreProvider,
  stubDescriptor,
  type ProviderCallRecord,
  type ProviderQuotaStore,
  type ProviderQuotaConsumeInput,
  type ProviderQuotaConsumeResult,
  type ProviderQuotaUsageInput,
  type StubBehavior,
} from '../src/index.js';
import { createDfrError } from '@dfr/errors';

const CHAIN = 'ethereum-sepolia' as ChainId;
const endpoint = (d: ProviderDescriptor): string => `https://stub.local/${d.id}`;
const noCredential = (): undefined => undefined;

function makeManager(
  behaviors: Record<string, StubBehavior[]>,
  options: {
    descriptors?: ProviderDescriptor[];
    records?: ProviderCallRecord[];
    quotaStore?: ProviderQuotaStore;
  } = {},
): { manager: ProviderManager; records: ProviderCallRecord[] } {
  const records = options.records ?? [];
  const descriptors =
    options.descriptors ?? [
      stubDescriptor('primary', CHAIN, { priority: 10, weight: 1 }),
      stubDescriptor('secondary', CHAIN, { priority: 9, weight: 1 }),
    ];
  const manager = new ProviderManager({
    chain: CHAIN,
    descriptors,
    resolveEndpoint: endpoint,
    resolveCredential: noCredential,
    fetchImpl: createStubFetch({ behaviors }),
    sleep: async () => {},
    random: () => 0, // Deterministic: hits top-1 / no jitter
    onCall: (r) => records.push(r),
    ...(options.quotaStore !== undefined ? { quotaStore: options.quotaStore } : {}),
  });
  return { manager, records };
}

const readCall = (method = 'eth_getBalance') =>
  ({ method, params: ['0xabc'], idempotency: 'safe-read' as const, timeoutMs: 200 });
const ctx = { requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN', signal: new AbortController().signal };

  describe('Provider transport (DFR-006)', () => {
    it('returns result on success and records health', async () => {
    const fetchImpl = createStubFetch({ behaviors: { p: [{ kind: 'result', value: '0x1' }] } });
    const provider = new JsonRpcHttpProvider({
      descriptor: stubDescriptor('p', CHAIN),
      endpoint: 'https://stub.local/p',
      fetchImpl,
    });
    const value = await provider.request<string>(readCall(), ctx);
    expect(value).toBe('0x1');
    expect(provider.healthSnapshot(Date.now()).latencyP50Ms).toBeGreaterThanOrEqual(0);
  });

    it('injects the W3C traceparent into the RPC; the Provider call record keeps the same correlation field', async () => {
    let sentTraceparent: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      sentTraceparent = new Headers(init?.headers).get('traceparent');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const records: ProviderCallRecord[] = [];
    const { manager } = makeManager({ primary: [{ kind: 'result', value: '0x1' }] }, { records });
    // A direct transport assertion isolates header formation from manager retries.
    const provider = new JsonRpcHttpProvider({
      descriptor: stubDescriptor('trace-provider', CHAIN),
      endpoint: 'https://stub.local/trace',
      fetchImpl,
    });
    await provider.request(readCall(), { ...ctx, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
    expect(sentTraceparent).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);

    const handle = await manager.acquire();
    await handle.request(readCall(), { ...ctx, traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) });
    expect(records[0]?.traceId).toBe('c'.repeat(32));
    expect(records[0]?.spanId).toMatch(/^[0-9a-f]{16}$/u);
    expect(records[0]?.spanId).not.toBe('d'.repeat(16));
  });

    it('HTTP 5xx -> DFR_PROVIDER_UNAVAILABLE; 429 -> DFR_PROVIDER_RATE_LIMITED', async () => {
    const five = new JsonRpcHttpProvider({
      descriptor: stubDescriptor('p', CHAIN),
      endpoint: 'https://stub.local/p',
      fetchImpl: createStubFetch({ behaviors: { p: [{ kind: 'http', status: 503 }] } }),
    });
    await expect(five.request(readCall(), ctx)).rejects.toMatchObject({ code: 'DFR_PROVIDER_UNAVAILABLE' });

    const limited = new JsonRpcHttpProvider({
      descriptor: stubDescriptor('p', CHAIN),
      endpoint: 'https://stub.local/p',
      fetchImpl: createStubFetch({ behaviors: { p: [{ kind: 'http', status: 429 }] } }),
    });
    await expect(limited.request(readCall(), ctx)).rejects.toMatchObject({ code: 'DFR_PROVIDER_RATE_LIMITED' });
  });

    it('JSON-RPC errors are normalized per the error-spec mapping table', async () => {
    const cases: [string, string][] = [
      ['nonce too low', 'DFR_NONCE_CONFLICT'],
      ['insufficient funds for gas', 'DFR_INSUFFICIENT_FUNDS'],
      ['execution reverted: nope', 'DFR_TRANSACTION_REVERTED'],
      ['something exotic', 'DFR_PROVIDER_UNAVAILABLE'],
    ];
    for (const [message, expected] of cases) {
      const provider = new JsonRpcHttpProvider({
        descriptor: stubDescriptor('p', CHAIN),
        endpoint: 'https://stub.local/p',
        fetchImpl: createStubFetch({ behaviors: { p: [{ kind: 'rpc-error', code: -32000, message }] } }),
      });
      await expect(provider.request(readCall(), ctx)).rejects.toMatchObject({ code: expected });
    }
  });

    it('error details do not echo the endpoint or credentials (redaction regression)', async () => {
    const provider = new JsonRpcHttpProvider({
      descriptor: stubDescriptor('p', CHAIN),
      endpoint: 'https://rpc.example.com/v1?apikey=SUPERSECRET',
      credential: 'SUPERSECRET',
      fetchImpl: createStubFetch({ behaviors: { p: [{ kind: 'http', status: 503 }] } }),
    });
    try {
      await provider.request(readCall(), ctx);
      throw new Error('should throw');
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain('SUPERSECRET');
    }
  });

    it('timeout -> DFR_PROVIDER_TIMEOUT', async () => {
    const provider = new JsonRpcHttpProvider({
      descriptor: stubDescriptor('p', CHAIN, { timeoutMs: 1000 }),
      endpoint: 'https://stub.local/p',
      fetchImpl: createStubFetch({ behaviors: { p: [{ kind: 'timeout' }] } }),
    });
    await expect(
      provider.request({ ...readCall(), timeoutMs: 20 }, ctx),
    ).rejects.toMatchObject({ code: 'DFR_PROVIDER_TIMEOUT' });
  });
});

  describe('Provider Manager failover (DFR-007 acceptance: primary Provider 5xx auto-switches)', () => {
    it('switches to the standby when the primary Provider returns 5xx; the caller notices nothing and results agree', async () => {
    const { manager, records } = makeManager({
      primary: [{ kind: 'http', status: 503 }],
      secondary: [{ kind: 'result', value: '0x42' }],
    });
    const handle = await manager.acquire({ capability: 'account.balance' });
    const value = await handle.request<string>(readCall(), ctx);
    expect(value).toBe('0x42');

    const providers = records.map((r) => r.providerId);
    expect(providers).toEqual(['primary', 'secondary']);
    expect(records[1]?.failover).toBe(true);
    expect(records[1]?.retryCount).toBe(1);
  });

    it('the primary Provider is selected again after it recovers; it never stays stuck on the standby', async () => {
    const { manager, records } = makeManager({
      primary: [{ kind: 'http', status: 503 }, { kind: 'result', value: 'primary-recovered' }],
      secondary: [{ kind: 'result', value: 'secondary' }],
    });

    const first = await manager.acquire({ capability: 'account.balance' });
    expect(await first.request<string>(readCall(), ctx)).toBe('secondary');

    // After three consecutive successful periodic health probes, the primary recovers from unknown to healthy.
    await manager.probe('primary');
    await manager.probe('primary');
    await manager.probe('primary');

    const second = await manager.acquire({ capability: 'account.balance' });
    expect(await second.request<string>(readCall(), ctx)).toBe('primary-recovered');
    expect(records.map((record) => record.providerId)).toEqual(['primary', 'secondary', 'primary']);
  });

    it('each call produces all fields required by chapter 9 of the spec', async () => {
    const { manager, records } = makeManager({ primary: [{ kind: 'result', value: '0x1' }] });
    const handle = await manager.acquire({ capability: 'account.balance' });
    await handle.request(readCall(), { ...ctx, traceId: 'trace-1' });
    const r = records[0]!;
    for (const field of [
      'requestId', 'traceId', 'chain', 'network', 'providerId', 'providerKind',
      'method', 'methodClass', 'latencyMs', 'status', 'retryCount', 'circuitState', 'scoreAtCall',
    ]) {
      expect(r, field).toHaveProperty(field);
    }
    expect(r.requestId).toBe(ctx.requestId);
    expect(r.traceId).toBe('trace-1');
  });

    it('all Providers unavailable -> throws the last normalized error, no stale cache returned', async () => {
    const { manager } = makeManager({
      primary: [{ kind: 'http', status: 503 }],
      secondary: [{ kind: 'network-error', message: 'ECONNRESET' }],
    });
    const handle = await manager.acquire();
    await expect(handle.request(readCall(), ctx)).rejects.toSatisfy(isDfrError);
  });

    it('capability filtering: Providers not meeting the capability are removed', async () => {
    const descriptors = [
      stubDescriptor('balance-only', CHAIN, { capabilities: ['account.balance'], priority: 10 }),
      stubDescriptor('block-only', CHAIN, { capabilities: ['block.read'], priority: 9 }),
    ];
    const { manager, records } = makeManager(
      { 'balance-only': [{ kind: 'result', value: '0x1' }], 'block-only': [{ kind: 'result', value: '0x2' }] },
      { descriptors },
    );
    const handle = await manager.acquire({ capability: 'block.read' });
    await handle.request({ ...readCall(), method: 'eth_getBlockByNumber' }, ctx);
    expect(records.map((r) => r.providerId)).toEqual(['block-only']);
  });

    it('requiresArchive only hits Providers marked as archive (audit fix A-26)', async () => {
    const descriptors = [
      stubDescriptor('hot', CHAIN, { priority: 10 }),
      stubDescriptor('archive', CHAIN, { priority: 1, archive: true }),
    ];
    const { manager, records } = makeManager(
      { hot: [{ kind: 'result', value: 'hot' }], archive: [{ kind: 'result', value: 'archive' }] },
      { descriptors },
    );
    const handle = await manager.acquire({ requiresArchive: true });
    const value = await handle.request<string>(readCall(), ctx);
    expect(value).toBe('archive');
    expect(records.map((r) => r.providerId)).toEqual(['archive']);
  });
});

  describe('Retry policy (provider-spec chapter 6)', () => {
    it('broadcast class (non-idempotent-write) never retries automatically — prevents fund accidents', async () => {
    const { manager, records } = makeManager({
      primary: [{ kind: 'http', status: 503 }],
      secondary: [{ kind: 'result', value: '0xok' }],
    });
    const handle = await manager.acquire();
    await expect(
      handle.request(
        { method: 'eth_sendRawTransaction', params: ['0xdead'], idempotency: 'non-idempotent-write', timeoutMs: 200 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'DFR_PROVIDER_UNAVAILABLE' });
    expect(records).toHaveLength(1);
    expect(records[0]?.providerId).toBe('primary');
  });

    it('safe-read does not repeat the same Provider', async () => {
    const { manager, records } = makeManager({
      primary: [{ kind: 'http', status: 503 }],
      secondary: [{ kind: 'http', status: 503 }],
    });
    const handle = await manager.acquire();
    await expect(handle.request(readCall(), ctx)).rejects.toBeDefined();
    expect(records.map((r) => r.providerId)).toEqual(['primary', 'secondary']);
    expect(new Set(records.map((r) => r.providerId)).size).toBe(records.length);
  });

    it('idempotent-write does not retry by default (explicit authorization required)', async () => {
    const { manager, records } = makeManager({ primary: [{ kind: 'http', status: 503 }] });
    const handle = await manager.acquire();
    await expect(
      handle.request({ method: 'eth_sendRawTransaction', params: [], idempotency: 'idempotent-write', timeoutMs: 200 }, ctx),
    ).rejects.toBeDefined();
    expect(records).toHaveLength(1);
  });
});

  describe('Pure function deciding retries (error mapping table covered entry by entry)', () => {
  const base = {
    idempotency: 'safe-read' as const,
    attempts: 1,
    safeReadBudget: 3,
    hasUntriedProvider: true,
    allowIdempotentWriteRetry: false,
    jitter: 0.5,
  };

    it('error codes that forbid retry never retry', async () => {
    for (const code of ['DFR_INVALID_ACCOUNT', 'DFR_UNSUPPORTED_CAPABILITY', 'DFR_TRANSACTION_REVERTED', 'DFR_POLICY_DENIED']) {
      const error = createDfrError(code as never, { requestId: ctx.requestId as never });
      expect(decideRetry({ ...base, error }).retry, code).toBe(false);
    }
  });

    it('HTTP 4xx (except 408/429) does not retry', async () => {
    const error = createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
      requestId: ctx.requestId as never,
      details: { httpStatus: 404 },
    });
    expect(decideRetry({ ...base, error }).retry).toBe(false);
  });

    it('network/timeout classes are retryable, backoff 50/150/400 plus jitter', async () => {
    const error = createDfrError('DFR_PROVIDER_TIMEOUT', { requestId: ctx.requestId as never });
    // The backoff table has three tiers, so a budget of 4 attempts is needed to observe the third tier.
    const budget4 = { ...base, safeReadBudget: 4 };
    expect(decideRetry({ ...budget4, error }).delayMs).toBe(50);
    expect(decideRetry({ ...budget4, attempts: 2, error }).delayMs).toBe(150);
    expect(decideRetry({ ...budget4, attempts: 3, error }).delayMs).toBe(400);
    // Default budget 3 allows only two retries, so the third tier is unreachable (consistent with "at most min(3, Provider count)").
    expect(decideRetry({ ...base, attempts: 3, error }).retry).toBe(false);
  });

    it('stops after the retry budget is exhausted', async () => {
    const error = createDfrError('DFR_PROVIDER_TIMEOUT', { requestId: ctx.requestId as never });
    expect(decideRetry({ ...base, attempts: 3, safeReadBudget: 3, error }).retry).toBe(false);
    expect(decideRetry({ ...base, attempts: 1, safeReadBudget: 3, hasUntriedProvider: false, error }).retry).toBe(false);
  });
});

  describe('Circuit breaker state machine (DFR-007 acceptance: opened -> half-open -> closed)', () => {
    it('5 consecutive failures open it, it half-opens on expiry, 3 consecutive successes close it', async () => {
    let now = 0;
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_OPTIONS);
    expect(cb.current).toBe('closed');

    for (let i = 0; i < 5; i += 1) cb.onFailure(now);
    expect(cb.current).toBe('open');
    expect(cb.allow(now + 1000)).toBe(false);
    expect(cb.current).toBe('open');

    now += DEFAULT_CIRCUIT_OPTIONS.openBaseMs;
    expect(cb.allow(now)).toBe(true);
    expect(cb.current).toBe('half-open');

    cb.onSuccess(now);
    cb.onSuccess(now);
    expect(cb.current).toBe('half-open');
    cb.onSuccess(now);
    expect(cb.current).toBe('closed');
  });

    it('a failure during half-open reopens it immediately, and the open duration backs off exponentially', async () => {
    let now = 0;
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_OPTIONS);
    for (let i = 0; i < 5; i += 1) cb.onFailure(now);
    now += DEFAULT_CIRCUIT_OPTIONS.openBaseMs;
    cb.allow(now);
    expect(cb.current).toBe('half-open');
    cb.onFailure(now);
    expect(cb.current).toBe('open');
    // Second open: backoff doubles (60s); at 30s it still does not admit.
    expect(cb.allow(now + DEFAULT_CIRCUIT_OPTIONS.openBaseMs)).toBe(false);
    expect(cb.allow(now + DEFAULT_CIRCUIT_OPTIONS.openBaseMs * 2)).toBe(true);
  });

    it('circuit breaker granularity is (providerId, method category): read-class failures do not affect write class', async () => {
    const { manager } = makeManager({
      primary: [
        { kind: 'http', status: 503 },
        { kind: 'http', status: 503 },
        { kind: 'http', status: 503 },
        { kind: 'http', status: 503 },
        { kind: 'http', status: 503 },
      ],
      secondary: [{ kind: 'http', status: 503 }],
    });
    const handle = await manager.acquire();
    for (let i = 0; i < 5; i += 1) {
      await handle.request(readCall(), ctx).catch(() => undefined);
    }
    expect(manager.circuitState('primary', 'read')).toBe('open');
    expect(manager.circuitState('primary', 'write')).toBe('closed');
  });
});

  describe('Scoring formula (provider-spec chapter 4)', () => {
    it('with no observation data, the score is bounded by the priority cap at 0..100', async () => {
    const score = scoreProvider({ descriptor: stubDescriptor('p', CHAIN, { priority: 10 }), now: 0 });
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.inputs.priority).toBe(10);
  });

    it('high latency and high error rate lower the score', async () => {
    const descriptor = stubDescriptor('p', CHAIN, { priority: 0 });
    const healthy = scoreProvider({ descriptor, latencyP95Ms: 50, errorRate: 0, now: 0 });
    const sick = scoreProvider({ descriptor, latencyP95Ms: 2000, errorRate: 0.9, now: 0 });
    expect(sick.score).toBeLessThan(healthy.score);
    expect(healthy.score - sick.score).toBeGreaterThan(30);
  });

    it('the priority reward uses the same 0..10 scale as the Registry (review fix R-14)', async () => {
    const low = scoreProvider({ descriptor: stubDescriptor('l', CHAIN, { priority: 0 }), latencyP95Ms: 1000, now: 0 });
    const high = scoreProvider({ descriptor: stubDescriptor('h', CHAIN, { priority: 10 }), latencyP95Ms: 1000, now: 0 });
    expect(high.score - low.score).toBe(10);
  });
});


  describe('Half-open state admits only one probe (spec chapter 7)', () => {
    it('concurrent admission during half-open is limited to 1', async () => {
    let now = 0;
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_OPTIONS);
    for (let i = 0; i < 5; i += 1) cb.onFailure(now);
    now += DEFAULT_CIRCUIT_OPTIONS.openBaseMs;

    // The first allow() after expiry admits the probe; later concurrent requests must fail immediately.
    expect(cb.allow(now)).toBe(true);
    expect(cb.current).toBe('half-open');
    expect(cb.allow(now)).toBe(false);
    expect(cb.allow(now)).toBe(false);

    // After the probe succeeds, admission resumes.
    cb.onSuccess(now);
    expect(cb.allow(now)).toBe(true);
  });
});

  describe('Error code when the circuit breaker is open (error-spec 4.5)', () => {
    it('all Providers circuit-open -> DFR_PROVIDER_CIRCUIT_OPEN, not DFR_CHAIN_UNAVAILABLE', async () => {
    const { manager } = makeManager({
      primary: Array.from({ length: 6 }, () => ({ kind: 'http' as const, status: 503 })),
      secondary: Array.from({ length: 6 }, () => ({ kind: 'http' as const, status: 503 })),
    });
    const handle = await manager.acquire();
    for (let i = 0; i < 6; i += 1) {
      await handle.request(readCall(), ctx).catch(() => undefined);
    }
    expect(manager.circuitState('primary', 'read')).toBe('open');
    await expect(handle.request(readCall(), ctx)).rejects.toMatchObject({
      code: 'DFR_PROVIDER_CIRCUIT_OPEN',
    });
  });
});

  describe('Health check loop (spec chapter 5: no high-frequency probing)', () => {
    it('sweepHealth only probes when due, and never produces duplicate concurrent probes', async () => {
    let now = 1_000_000;
    let rpcCalls = 0;
    const descriptors = [stubDescriptor('p', CHAIN, { priority: 10 })];
    const manager = new ProviderManager({
      chain: CHAIN,
      descriptors,
      resolveEndpoint: endpoint,
      resolveCredential: noCredential,
      now: () => now,
      sleep: async () => {},
      fetchImpl: createStubFetch({
        onCall: () => {
          rpcCalls += 1;
        },
        behaviors: { p: [{ kind: 'result', value: '0xaa36a7' }] },
      }),
    });

    // First sweep: unknown state -> probing allowed.
    await manager.sweepHealth();
    expect(rpcCalls).toBe(1);

    // Sweeping again at the same moment: not due, must not probe again.
    await manager.sweepHealth();
    expect(rpcCalls).toBe(1);

    // Advance to the healthy Provider's next cycle (60s).
    now += 60_001;
    await manager.sweepHealth();
    expect(rpcCalls).toBe(2);

    manager.stopHealthChecks();
  });
});

  describe('Provider daily quota enforcement (provider-spec §8 step 1: quota exhausted -> excluded)', () => {
  // Background: the filter steps in spec §8 list "quota exhausted" alongside circuit breaker and capability as exclusion conditions,
  // but the implementation previously used requestsPerDay only as an **observation** (gauge + score), never blocking.
  // As a result, a Provider declaring requestsPerDay: 500000 would be sent a 500001st request,
  // blowing up the upstream quota. This group of tests locks in the enforcement semantics.
  //
  // API convention: every call must `acquire()` (route) then `handle.request()`;
  // quota is decided at the routing stage, so after exhaustion it should route to the standby Provider.
  const callOnce = async (manager: ProviderManager, capability: 'account.balance' = 'account.balance'): Promise<string> => {
    const handle = await manager.acquire({ capability });
    return handle.request<string>(readCall(), ctx);
  };

    it('after reaching the requestsPerDay limit, that Provider is excluded (falls over to the standby)', async () => {
    const { manager, records } = makeManager(
      {
        primary: [{ kind: 'result', value: '0x1' }],
        secondary: [{ kind: 'result', value: '0x2' }],
      },
      {
        descriptors: [
          // Limit 2: the first two hit primary; from the third, primary is excluded
          stubDescriptor('primary', CHAIN, { priority: 10, weight: 1, quota: { requestsPerDay: 2 } }),
          stubDescriptor('secondary', CHAIN, { priority: 9, weight: 1 }),
        ],
      },
    );

    await callOnce(manager); // primary #1
    await callOnce(manager); // primary #2
    await callOnce(manager); // primary exhausted -> secondary
    await callOnce(manager); // continue -> secondary

    expect(records.map((r) => r.providerId)).toEqual([
      'primary',
      'primary',
      'secondary',
      'secondary',
    ]);
  });

    it('a Provider without requestsPerDay configured is unlimited (behavior as before)', async () => {
    const { manager, records } = makeManager(
      {
        primary: [
          { kind: 'result', value: '0x1' },
          { kind: 'result', value: '0x1' },
          { kind: 'result', value: '0x1' },
        ],
      },
      { descriptors: [stubDescriptor('primary', CHAIN, { priority: 10, weight: 1 })] },
    );
    for (let i = 0; i < 3; i += 1) await callOnce(manager);
    expect(records.every((r) => r.providerId === 'primary')).toBe(true);
  });

    it('requestsPerDay <= 0 counts as unlimited (do not treat 0 as "no calls at all")', async () => {
    const { manager, records } = makeManager(
      { primary: [{ kind: 'result', value: '0x1' }] },
      {
        descriptors: [
          stubDescriptor('primary', CHAIN, { priority: 10, weight: 1, quota: { requestsPerDay: 0 } }),
        ],
      },
    );
    await expect(callOnce(manager)).resolves.toBe('0x1');
    expect(records).toHaveLength(1);
  });

    it('all Providers quota-exhausted -> acquire throws DFR_QUOTA_EXCEEDED (distinguishable, no over-issuing)', async () => {
    const { manager, records } = makeManager(
      {
        primary: [
          { kind: 'result', value: '0x1' },
          { kind: 'result', value: '0x1' },
        ],
      },
      {
        descriptors: [
          stubDescriptor('primary', CHAIN, { priority: 10, weight: 1, quota: { requestsPerDay: 1 } }),
          stubDescriptor('secondary', CHAIN, { priority: 9, weight: 1, quota: { requestsPerDay: 1 } }),
        ],
      },
    );
    // Each Provider consumes 1 call, then its quota is exhausted
    await callOnce(manager);
    await callOnce(manager);
    const before = records.length;
    // Quota is decided at the **routing stage**: when all are exhausted, acquire throws directly with no handle,
    // and never issues call N+1. The error code must be DFR_QUOTA_EXCEEDED, not
    // DFR_CHAIN_UNAVAILABLE — the latter would mislead ops into thinking it is an upstream outage.
    await expect(manager.acquire({ capability: 'account.balance' })).rejects.toSatisfy(
      (e: unknown) => isDfrError(e) && e.code === 'DFR_QUOTA_EXCEEDED',
    );
    expect(records.length).toBe(before);
  });

    it('quota exhaustion does not affect the gauge: usedRatio is 1 when the limit is reached', async () => {
    const { manager } = makeManager(
      { primary: [{ kind: 'result', value: '0x1' }] },
      {
        descriptors: [
          stubDescriptor('primary', CHAIN, { priority: 10, weight: 1, quota: { requestsPerDay: 1 } }),
        ],
      },
    );
    await callOnce(manager);
    const snapshot = manager.observabilitySnapshot().find((s) => s.providerId === 'primary');
    expect(snapshot?.quotaUsedRatio).toBe(1);
  });
});

  describe('Provider quota persistent Store (E5)', () => {
  class FakeQuotaStore implements ProviderQuotaStore {
    readonly consumed: ProviderQuotaConsumeInput[] = [];
    constructor(
      private readonly limitAllowed: number,
      private readonly fail = false,
    ) {}

    async consume(input: ProviderQuotaConsumeInput): Promise<ProviderQuotaConsumeResult> {
      if (this.fail) throw new Error('quota store unavailable');
      this.consumed.push(input);
      const used = this.consumed.length;
      return { allowed: used <= this.limitAllowed, used };
    }

    async usage(_input: ProviderQuotaUsageInput): Promise<number> {
      return this.consumed.length;
    }
  }

    it('calls are refused after the persistent Store limit is reached, and upstream is no longer touched', async () => {
    const quotaStore = new FakeQuotaStore(0);
    const { manager, records } = makeManager(
      {
        primary: [
          { kind: 'result', value: '0x1' },
          { kind: 'result', value: '0x2' },
        ],
      },
      {
        descriptors: [
          stubDescriptor('primary', CHAIN, { priority: 10, weight: 1, quota: { requestsPerDay: 1 } }),
        ],
        quotaStore,
      },
    );
    const handle = await manager.acquire({ capability: 'account.balance' });
    await expect(handle.request<string>(readCall(), ctx)).rejects.toMatchObject({
      code: 'DFR_QUOTA_EXCEEDED',
    });
    expect(records).toHaveLength(0);
    expect(quotaStore.consumed).toHaveLength(1);
  });

    it('on persistent Store failure, fail-closed, no upstream call', async () => {
    const quotaStore = new FakeQuotaStore(1, true);
    const { manager, records } = makeManager(
      { primary: [{ kind: 'result', value: '0x1' }] },
      {
        descriptors: [
          stubDescriptor('primary', CHAIN, { priority: 10, weight: 1, quota: { requestsPerDay: 1 } }),
        ],
        quotaStore,
      },
    );
    const handle = await manager.acquire({ capability: 'account.balance' });
    await expect(handle.request<string>(readCall(), ctx)).rejects.toThrow('quota store unavailable');
    expect(records).toHaveLength(0);
  });

    it('the observability snapshot reads global usage from the persistent Store, not just this process's counter', async () => {
    const quotaStore: ProviderQuotaStore = {
      consume: async () => ({ allowed: true, used: 7 }),
      usage: async () => 7,
    };
    const { manager } = makeManager(
      { primary: [{ kind: 'result', value: '0x1' }] },
      {
        descriptors: [
          stubDescriptor('primary', CHAIN, { priority: 10, weight: 1, quota: { requestsPerDay: 10 } }),
        ],
        quotaStore,
      },
    );

    const snapshot = (await manager.observabilitySnapshotAsync())
      .find((entry) => entry.providerId === 'primary');
    expect(snapshot?.quotaUsedRatio).toBe(0.7);
  });
});
