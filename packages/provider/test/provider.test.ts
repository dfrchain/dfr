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
    random: () => 0, // 确定性：命中 top-1 / 无抖动
    onCall: (r) => records.push(r),
    ...(options.quotaStore !== undefined ? { quotaStore: options.quotaStore } : {}),
  });
  return { manager, records };
}

const readCall = (method = 'eth_getBalance') =>
  ({ method, params: ['0xabc'], idempotency: 'safe-read' as const, timeoutMs: 200 });
const ctx = { requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN', signal: new AbortController().signal };

describe('Provider 传输（DFR-006）', () => {
  it('成功时返回 result 并记录健康', async () => {
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

  it('向 RPC 注入 W3C traceparent，Provider call record 保留同一关联字段', async () => {
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

  it('HTTP 5xx → DFR_PROVIDER_UNAVAILABLE；429 → DFR_PROVIDER_RATE_LIMITED', async () => {
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

  it('JSON-RPC 错误按 error-spec 映射表归一化', async () => {
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

  it('错误详情不回显端点与凭证（脱敏回归）', async () => {
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

  it('超时 → DFR_PROVIDER_TIMEOUT', async () => {
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

describe('Provider Manager 故障切换（DFR-007 验收：主 Provider 5xx 自动切换）', () => {
  it('主 Provider 返回 5xx 时切换到备用，调用方无感知且结果一致', async () => {
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

  it('主 Provider 恢复后会重新被选择，不会永久黏在备用端', async () => {
    const { manager, records } = makeManager({
      primary: [{ kind: 'http', status: 503 }, { kind: 'result', value: 'primary-recovered' }],
      secondary: [{ kind: 'result', value: 'secondary' }],
    });

    const first = await manager.acquire({ capability: 'account.balance' });
    expect(await first.request<string>(readCall(), ctx)).toBe('secondary');

    // 周期健康探针连续三次成功后，主端从 unknown 恢复为 healthy。
    await manager.probe('primary');
    await manager.probe('primary');
    await manager.probe('primary');

    const second = await manager.acquire({ capability: 'account.balance' });
    expect(await second.request<string>(readCall(), ctx)).toBe('primary-recovered');
    expect(records.map((record) => record.providerId)).toEqual(['primary', 'secondary', 'primary']);
  });

  it('每次调用产出规范第 9 章要求的全部字段', async () => {
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

  it('全部 Provider 不可用 → 抛出最后一次归一化错误，不返回过期缓存', async () => {
    const { manager } = makeManager({
      primary: [{ kind: 'http', status: 503 }],
      secondary: [{ kind: 'network-error', message: 'ECONNRESET' }],
    });
    const handle = await manager.acquire();
    await expect(handle.request(readCall(), ctx)).rejects.toSatisfy(isDfrError);
  });

  it('能力过滤：不满足 capability 的 Provider 被剔除', async () => {
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

  it('requiresArchive 只命中标记为归档的 Provider（审计修正 A-26）', async () => {
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

describe('重试策略（provider-spec 第 6 章）', () => {
  it('广播类（non-idempotent-write）绝不自动重试 —— 防资金事故', async () => {
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

  it('safe-read 不重复同一 Provider', async () => {
    const { manager, records } = makeManager({
      primary: [{ kind: 'http', status: 503 }],
      secondary: [{ kind: 'http', status: 503 }],
    });
    const handle = await manager.acquire();
    await expect(handle.request(readCall(), ctx)).rejects.toBeDefined();
    expect(records.map((r) => r.providerId)).toEqual(['primary', 'secondary']);
    expect(new Set(records.map((r) => r.providerId)).size).toBe(records.length);
  });

  it('idempotent-write 默认不重试（需显式授权）', async () => {
    const { manager, records } = makeManager({ primary: [{ kind: 'http', status: 503 }] });
    const handle = await manager.acquire();
    await expect(
      handle.request({ method: 'eth_sendRawTransaction', params: [], idempotency: 'idempotent-write', timeoutMs: 200 }, ctx),
    ).rejects.toBeDefined();
    expect(records).toHaveLength(1);
  });
});

describe('决定重试的纯函数（错误映射表逐条覆盖）', () => {
  const base = {
    idempotency: 'safe-read' as const,
    attempts: 1,
    safeReadBudget: 3,
    hasUntriedProvider: true,
    allowIdempotentWriteRetry: false,
    jitter: 0.5,
  };

  it('禁止重试的错误码一律不重试', () => {
    for (const code of ['DFR_INVALID_ACCOUNT', 'DFR_UNSUPPORTED_CAPABILITY', 'DFR_TRANSACTION_REVERTED', 'DFR_POLICY_DENIED']) {
      const error = createDfrError(code as never, { requestId: ctx.requestId as never });
      expect(decideRetry({ ...base, error }).retry, code).toBe(false);
    }
  });

  it('HTTP 4xx（除 408/429）不重试', () => {
    const error = createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
      requestId: ctx.requestId as never,
      details: { httpStatus: 404 },
    });
    expect(decideRetry({ ...base, error }).retry).toBe(false);
  });

  it('网络/超时类可重试，退避 50/150/400 加抖动', () => {
    const error = createDfrError('DFR_PROVIDER_TIMEOUT', { requestId: ctx.requestId as never });
    // 退避表有三档，因此需要 4 次尝试预算才能观察到第三档。
    const budget4 = { ...base, safeReadBudget: 4 };
    expect(decideRetry({ ...budget4, error }).delayMs).toBe(50);
    expect(decideRetry({ ...budget4, attempts: 2, error }).delayMs).toBe(150);
    expect(decideRetry({ ...budget4, attempts: 3, error }).delayMs).toBe(400);
    // 默认预算 3 只有两次重试，第三档不可达（与"最多 min(3, Provider 数)"一致）。
    expect(decideRetry({ ...base, attempts: 3, error }).retry).toBe(false);
  });

  it('重试预算耗尽后停止', () => {
    const error = createDfrError('DFR_PROVIDER_TIMEOUT', { requestId: ctx.requestId as never });
    expect(decideRetry({ ...base, attempts: 3, safeReadBudget: 3, error }).retry).toBe(false);
    expect(decideRetry({ ...base, attempts: 1, safeReadBudget: 3, hasUntriedProvider: false, error }).retry).toBe(false);
  });
});

describe('熔断状态机（DFR-007 验收：opened → half-open → closed）', () => {
  it('连续 5 次失败打开，到期半开，连续 3 次成功关闭', () => {
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

  it('半开期间失败立即重新打开，且打开时长指数退避', () => {
    let now = 0;
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_OPTIONS);
    for (let i = 0; i < 5; i += 1) cb.onFailure(now);
    now += DEFAULT_CIRCUIT_OPTIONS.openBaseMs;
    cb.allow(now);
    expect(cb.current).toBe('half-open');
    cb.onFailure(now);
    expect(cb.current).toBe('open');
    // 第二次打开：退避翻倍（60s），30s 时仍不放行。
    expect(cb.allow(now + DEFAULT_CIRCUIT_OPTIONS.openBaseMs)).toBe(false);
    expect(cb.allow(now + DEFAULT_CIRCUIT_OPTIONS.openBaseMs * 2)).toBe(true);
  });

  it('熔断按 (providerId, method 类别) 粒度：读类失败不影响写类', async () => {
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

describe('评分公式（provider-spec 第 4 章）', () => {
  it('无观测数据时得分受优先级上限约束在 0..100', () => {
    const score = scoreProvider({ descriptor: stubDescriptor('p', CHAIN, { priority: 10 }), now: 0 });
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.inputs.priority).toBe(10);
  });

  it('高延迟与高错误率降低得分', () => {
    const descriptor = stubDescriptor('p', CHAIN, { priority: 0 });
    const healthy = scoreProvider({ descriptor, latencyP95Ms: 50, errorRate: 0, now: 0 });
    const sick = scoreProvider({ descriptor, latencyP95Ms: 2000, errorRate: 0.9, now: 0 });
    expect(sick.score).toBeLessThan(healthy.score);
    expect(healthy.score - sick.score).toBeGreaterThan(30);
  });

  it('优先级奖励与 Registry 的 0..10 量纲一致（评审修正 R-14）', () => {
    const low = scoreProvider({ descriptor: stubDescriptor('l', CHAIN, { priority: 0 }), latencyP95Ms: 1000, now: 0 });
    const high = scoreProvider({ descriptor: stubDescriptor('h', CHAIN, { priority: 10 }), latencyP95Ms: 1000, now: 0 });
    expect(high.score - low.score).toBe(10);
  });
});


describe('半开状态只放行一个探针（spec 第 7 章）', () => {
  it('半开期间并发放行被限制为 1 个', () => {
    let now = 0;
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_OPTIONS);
    for (let i = 0; i < 5; i += 1) cb.onFailure(now);
    now += DEFAULT_CIRCUIT_OPTIONS.openBaseMs;

    // 到期后的第一次 allow() 放行探针；后续并发请求必须立即失败。
    expect(cb.allow(now)).toBe(true);
    expect(cb.current).toBe('half-open');
    expect(cb.allow(now)).toBe(false);
    expect(cb.allow(now)).toBe(false);

    // 探针成功后重新放行。
    cb.onSuccess(now);
    expect(cb.allow(now)).toBe(true);
  });
});

describe('熔断打开时的错误码（error-spec 4.5）', () => {
  it('全部 Provider 熔断 → DFR_PROVIDER_CIRCUIT_OPEN，而不是 DFR_CHAIN_UNAVAILABLE', async () => {
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

describe('健康检查循环（spec 第 5 章：禁止高频探测）', () => {
  it('sweepHealth 只在到期时探测，且不产生重复并发探测', async () => {
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

    // 首次巡检：unknown 状态 → 允许探测。
    await manager.sweepHealth();
    expect(rpcCalls).toBe(1);

    // 同一时刻再次巡检：未到期，不应再探测。
    await manager.sweepHealth();
    expect(rpcCalls).toBe(1);

    // 前进到健康 Provider 的下一个周期（60s）。
    now += 60_001;
    await manager.sweepHealth();
    expect(rpcCalls).toBe(2);

    manager.stopHealthChecks();
  });
});

describe('Provider 当日配额强制（provider-spec §8 第 1 步：配额耗尽 → 剔除）', () => {
  // 背景：spec §8 的过滤步骤把"配额耗尽"列为与熔断、能力并列的剔除条件，
  // 但实现里此前只把 requestsPerDay 用作**观测**（gauge + 评分），从不拦截。
  // 结果是声明 requestsPerDay: 500000 的 Provider 会被发到第 500001 次，
  // 把上游额度打爆。这一组测试锁定强制语义。
  //
  // API 口径：每次调用都要 `acquire()`（路由）后 `handle.request()`；
  // 配额在路由阶段判定，因此耗尽后应路由到备用 Provider。
  const callOnce = async (manager: ProviderManager, capability: 'account.balance' = 'account.balance'): Promise<string> => {
    const handle = await manager.acquire({ capability });
    return handle.request<string>(readCall(), ctx);
  };

  it('达到 requestsPerDay 上限后该 Provider 被剔除（转投备用）', async () => {
    const { manager, records } = makeManager(
      {
        primary: [{ kind: 'result', value: '0x1' }],
        secondary: [{ kind: 'result', value: '0x2' }],
      },
      {
        descriptors: [
          // 上限 2：前两次命中 primary，第三次起 primary 被剔除
          stubDescriptor('primary', CHAIN, { priority: 10, weight: 1, quota: { requestsPerDay: 2 } }),
          stubDescriptor('secondary', CHAIN, { priority: 9, weight: 1 }),
        ],
      },
    );

    await callOnce(manager); // primary #1
    await callOnce(manager); // primary #2
    await callOnce(manager); // primary 已耗尽 → secondary
    await callOnce(manager); // 继续 → secondary

    expect(records.map((r) => r.providerId)).toEqual([
      'primary',
      'primary',
      'secondary',
      'secondary',
    ]);
  });

  it('未配置 requestsPerDay 的 Provider 不限额（行为与从前一致）', async () => {
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

  it('requestsPerDay <= 0 视为不限额（不把 0 当作“一次都不许”）', async () => {
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

  it('全部 Provider 配额耗尽 → acquire 抛 DFR_QUOTA_EXCEEDED（可区分，不超发）', async () => {
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
    // 每个 Provider 各消耗 1 次，配额随即耗尽
    await callOnce(manager);
    await callOnce(manager);
    const before = records.length;
    // 配额在**路由阶段**判定：全部耗尽时 acquire 直接抛错，不产生句柄，
    // 更不会发出第 N+1 次调用。错误码必须是 DFR_QUOTA_EXCEEDED 而不是
    // DFR_CHAIN_UNAVAILABLE —— 后者会让运维误判成上游故障。
    await expect(manager.acquire({ capability: 'account.balance' })).rejects.toSatisfy(
      (e: unknown) => isDfrError(e) && e.code === 'DFR_QUOTA_EXCEEDED',
    );
    expect(records.length).toBe(before);
  });

  it('配额耗尽不影响 gauge 口径：usedRatio 在达到上限时为 1', async () => {
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

describe('Provider 配额持久 Store（E5）', () => {
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

  it('达到持久 Store 上限后拒绝调用，且不再触达上游', async () => {
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

  it('持久 Store 故障时 fail-closed，不调用上游', async () => {
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

  it('可观测快照从持久 Store 读取全局用量，而不是只读本进程计数', async () => {
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
