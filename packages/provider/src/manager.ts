/**
 * Provider Manager / Router（DFR-007，见 provider-spec 第 8 章）。
 *
 * 对外只暴露 `acquire(requirements)`；Adapter 拿到句柄后调用 `request()`，
 * 候选过滤、评分、加权选择、失败切换与重试都发生在 Manager 内部。
 *
 * 关键约束：
 * - 更换 RPC Provider 不需要修改 Adapter；
 * - 全部 Provider 不可用 → DFR_CHAIN_UNAVAILABLE（fail-closed，不返回过期缓存）；
 * - 广播类（non-idempotent-write）绝不自动重试。
 */
import { randomBytes } from 'node:crypto';
import { createDfrError, isDfrError, newRequestId } from '@dfr/errors';
import type {
  ChainId,
  ProviderDescriptor,
  ProviderHandle,
  ProviderId,
  ProviderRequirements,
  ProviderRouter,
  ProviderQuotaStore,
  RequestId,
} from '@dfr/types';
import { CircuitBreaker, DEFAULT_CIRCUIT_OPTIONS, type MethodClass } from './circuit.js';
import { decideRetry } from './retry.js';
import { scoreProvider } from './scoring.js';
import {
  JsonRpcHttpProvider,
  methodClassOf,
  type Provider,
  type TransportCall,
  type TransportContext,
} from './transport.js';

/** 每次 Provider 调用产出的观测记录（provider-spec 第 9 章字段）。 */
export interface ProviderCallRecord {
  requestId: RequestId;
  traceId?: string | undefined;
  spanId?: string | undefined;
  chain: ChainId;
  network: string;
  providerId: string;
  providerKind: string;
  method: string;
  methodClass: MethodClass;
  latencyMs: number;
  status: 'success' | 'error';
  errorCode?: string | undefined;
  retryCount: number;
  circuitState: string;
  scoreAtCall: number;
  failover: boolean;
}

/**
 * 单个 Provider 的观测快照（observability-spec §5.4 的 gauge 数据源）。
 *
 * `quotaUsedRatio` 为可选：未配置 `quota.requestsPerDay` 时**不提供**该值，
 * 而不是伪造 0 或 1——见 `observabilitySnapshot()` 的说明。
 */
export interface ProviderObservabilitySnapshot {
  readonly providerId: string;
  readonly network: string;
  readonly health: Provider['healthSnapshot'] extends (now: number) => infer H ? H : never;
  /** 读路径熔断器状态；写路径另有独立熔断器（spec 第 7 章）。 */
  readonly circuitState: string;
  /** 与选路时**同一个**评分公式算出的分数，保证口径一致。 */
  readonly score: number;
  readonly quotaUsedRatio?: number;
}

export interface ProviderManagerOptions {
  chain: ChainId;
  descriptors: readonly ProviderDescriptor[];
  resolveEndpoint: (descriptor: ProviderDescriptor) => string;
  resolveCredential: (descriptor: ProviderDescriptor) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onCall?: (record: ProviderCallRecord) => void;
  /** safe-read 重试预算上限，默认 3（spec 第 6 章）。 */
  maxSafeReadRetries?: number;
  /** idempotent-write 是否允许同 Provider 重试一次；默认 false（需显式授权）。 */
  allowIdempotentWriteRetry?: boolean;
  /**
   * E5：跨进程 Provider 日配额 Store。
   *
   * 未提供时沿用进程内计数（向后兼容；单实例部署准确）。提供时，
   * 每次真实调用前必须原子预占额度，存储故障即 fail-closed。
   */
  quotaStore?: ProviderQuotaStore;
}

interface Candidate {
  provider: Provider;
  descriptor: ProviderDescriptor;
  score: number;
}

const DEFAULT_MAX_SAFE_READ_RETRIES = 3;

export class ProviderManager implements ProviderRouter {
  readonly chain: ChainId;

  private readonly options: ProviderManagerOptions;
  private readonly providers: readonly Provider[];
  private readonly circuits = new Map<string, CircuitBreaker>();
  private readonly sticky = new Map<string, string>();
  /** 健康探针单飞集合。 */
  private readonly probing = new Set<string>();
  /** 每 Provider 的当日调用计数（配额比例用）；按自然日自动滚动。 */
  private readonly dailyCalls = new Map<string, { readonly day: string; count: number }>();
  private healthTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ProviderManagerOptions) {
    this.options = options;
    this.chain = options.chain;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    this.providers = options.descriptors
      .filter((d) => d.chain === options.chain)
      .map((descriptor) => {
        const providerOptions: ConstructorParameters<typeof JsonRpcHttpProvider>[0] = {
          descriptor,
          endpoint: options.resolveEndpoint(descriptor),
        };
        const credential = options.resolveCredential(descriptor);
        if (credential !== undefined) providerOptions.credential = credential;
        if (options.fetchImpl !== undefined) providerOptions.fetchImpl = options.fetchImpl;
        providerOptions.now = this.now;
        return new JsonRpcHttpProvider(providerOptions);
      });
  }

  /** 该链当前配置的 Provider 数量（M0 验收要求 EVM 至少 2 个）。 */
  get providerCount(): number {
    return this.providers.length;
  }

  /** 按约束选择 Provider，返回只能发起调用的句柄（Adapter 看不到端点与凭证）。 */
  async acquire(requirements: ProviderRequirements = {}): Promise<ProviderHandle> {
    const chosen = this.pickCandidate(requirements);
    if (chosen === null) {
      // 与 `request()` 的兜底一致：先区分"为什么没有候选"。
      // 全部熔断已有专门的 `DFR_PROVIDER_CIRCUIT_OPEN`；配额耗尽此前会退化成
      // "没有满足条件的可用 Provider"，让运维误以为是上游故障。
      const quotaBlocked = this.quotaExhaustedCount(requirements);
      if (quotaBlocked > 0 && quotaBlocked === this.providerCount) {
        throw createDfrError('DFR_QUOTA_EXCEEDED', {
          requestId: newRequestId(),
          message: `链 ${this.chain} 的全部 Provider 当日配额已用尽`,
          chain: this.chain,
          details: { quotaKind: 'provider_daily', blockedProviders: quotaBlocked },
        });
      }
      throw createDfrError('DFR_CHAIN_UNAVAILABLE', {
        requestId: newRequestId(),
        message: `链 ${this.chain} 没有满足条件的可用 Provider`,
        chain: this.chain,
      });
    }
    if (requirements.stickyKey !== undefined) {
      this.sticky.set(requirements.stickyKey, chosen.descriptor.id);
    }
    return new ManagedProviderHandle(this, chosen.descriptor.id, requirements);
  }

  /** 句柄的 request 入口：候选切换 + 重试 + 熔断 + 指标都在这里收敛。 */
  async execute<T>(
    call: TransportCall,
    ctx: TransportContext,
    requirements: ProviderRequirements,
    preferredId: ProviderId,
  ): Promise<T> {
    const methodClass = methodClassOf(call.idempotency);
    const tried = new Set<string>();
    let attempts = 0;
    let lastError: unknown;

    const candidateCount = this.eligibleCandidates(requirements, methodClass).length;
    const safeReadBudget = Math.min(
      this.options.maxSafeReadRetries ?? DEFAULT_MAX_SAFE_READ_RETRIES,
      Math.max(1, candidateCount),
    );

    for (;;) {
      attempts += 1;
      const candidate = this.nextCandidate(requirements, methodClass, tried, preferredId);
      if (candidate === null) break;

      const { provider, descriptor } = candidate;
      tried.add(descriptor.id);
      // 配额按"发出的调用"计数（成功与失败都算），因为上游配额通常也按请求计。
      // E5：注入持久 Store 时，预占必须在真正请求前原子完成；拒绝或 Store 故障
      // 都不能继续调用上游。未注入时保留原有进程内行为。
      const quotaDecision = await this.reserveDailyCall(descriptor);
      if (!quotaDecision.allowed) {
        if (this.hasUntried(requirements, methodClass, tried)) continue;
        throw createDfrError('DFR_QUOTA_EXCEEDED', {
          requestId: ctx.requestId as RequestId,
          message: `链 ${this.chain} 的全部 Provider 当日配额已用尽`,
          chain: this.chain,
          details: { quotaKind: 'provider_daily' },
        });
      }
      const started = this.now();
      const circuit = this.circuitFor(descriptor.id, methodClass);
      const attemptContext: TransportContext = {
        ...ctx,
        spanId: randomBytes(8).toString('hex'),
      };

      try {
        const result = await provider.request<T>(call, attemptContext);
        circuit.onSuccess(this.now());
        this.emitRecord(attemptContext, descriptor, call, methodClass, {
          latencyMs: this.now() - started,
          status: 'success',
          retryCount: attempts - 1,
          circuitState: circuit.current,
          scoreAtCall: candidate.score,
          failover: attempts > 1,
        });
        return result;
      } catch (error) {
        lastError = error;
        circuit.onFailure(this.now());
        this.emitRecord(attemptContext, descriptor, call, methodClass, {
          latencyMs: this.now() - started,
          status: 'error',
          errorCode: isDfrError(error) ? error.code : 'DFR_INTERNAL_ERROR',
          retryCount: attempts - 1,
          circuitState: circuit.current,
          scoreAtCall: candidate.score,
          failover: attempts > 1,
        });

        const decision = decideRetry({
          error,
          idempotency: call.idempotency,
          attempts,
          safeReadBudget,
          hasUntriedProvider: this.hasUntried(requirements, methodClass, tried),
          allowIdempotentWriteRetry: this.options.allowIdempotentWriteRetry ?? false,
          jitter: this.random(),
        });
        if (!decision.retry) break;
        await this.sleep(decision.delayMs ?? 0);
      }
    }

    if (isDfrError(lastError)) throw lastError;

    // 配额耗尽必须在“没有候选”之前判定：否则 acquire 已返回句柄，
    // 但 execute 找不到候选时会误报 DFR_CHAIN_UNAVAILABLE，让运维把额度问题
    // 当成上游故障。与 acquire() 使用同一判据，保持错误码一致。
    const quotaBlocked = this.quotaExhaustedCount(requirements);
    if (quotaBlocked > 0 && quotaBlocked === this.providerCount) {
      throw createDfrError('DFR_QUOTA_EXCEEDED', {
        requestId: ctx.requestId as RequestId,
        message: `链 ${this.chain} 的全部 Provider 当日配额已用尽`,
        chain: this.chain,
        details: { quotaKind: 'provider_daily', blockedProviders: quotaBlocked },
      });
    }

    // 区分"熔断打开"与"没有可用 Provider"：两者都 fail-closed，但错误码不同，
    // 便于调用方与运维判断是"上游挂了"还是"我们主动熔断了"（error-spec 4.5）。
    if (this.openCircuitCount(methodClass) > 0) {
      throw createDfrError('DFR_PROVIDER_CIRCUIT_OPEN', {
        requestId: ctx.requestId as RequestId,
        message: `链 ${this.chain} 的 Provider 处于熔断状态`,
        chain: this.chain,
        details: { methodClass, openProviders: this.openCircuitCount(methodClass) },
      });
    }

    throw createDfrError('DFR_CHAIN_UNAVAILABLE', {
      requestId: ctx.requestId as RequestId,
      message: `链 ${this.chain} 的全部 Provider 均不可用`,
      chain: this.chain,
      cause: lastError,
    });
  }

  private openCircuitCount(methodClass: MethodClass): number {
    return this.providers.filter(
      (p) => this.circuitFor(p.id, methodClass).current === 'open',
    ).length;
  }

  /* ---------------- 候选选择 ---------------- */

  private eligibleCandidates(
    requirements: ProviderRequirements,
    methodClass: MethodClass,
  ): Candidate[] {
    const now = this.now();
    const candidates: Candidate[] = [];
    for (const provider of this.providers) {
      const descriptor = provider.descriptor;
      if (requirements.capability !== undefined) {
        if (!descriptor.capabilities.includes(requirements.capability)) continue;
      }
      if (requirements.kind !== undefined && descriptor.kind !== requirements.kind) continue;
      if (requirements.requiresArchive === true && descriptor.archive !== true) continue;

      const circuit = this.circuitFor(descriptor.id, methodClass);
      if (!circuit.allow(now)) continue;

      // provider-spec §8 第 1 步明确要求：**配额耗尽 → 剔除**。
      // 这是规范已写、实现缺失的补齐，不是新增特性：
      // `requestsPerDay: 500000` 此前只喂 gauge 与评分，DFR 照样会发出第 500001 次调用，
      // 把上游的额度打爆（并可能触发对方的封禁）。
      // 只约束**显式配置了** requestsPerDay 的 Provider：未配置 = 不限额（与此前行为一致）。
      if (this.dailyQuotaExhausted(descriptor)) continue;

      const health = provider.healthSnapshot(now);
      const scored = scoreProvider({
        descriptor,
        latencyP95Ms: health.latencyP95Ms,
        errorRate: health.errorRate,
        now,
      });
      candidates.push({ provider, descriptor, score: scored.score });
    }
    candidates.sort((a, b) => {
      const healthRank = (candidate: Candidate): number => {
        const status = candidate.provider.healthSnapshot(now).status;
        return status === 'healthy' ? 2 : status === 'degraded' ? 1 : 0;
      };
      const healthDelta = healthRank(b) - healthRank(a);
      if (healthDelta !== 0) return healthDelta;
      if (b.score !== a.score) return b.score - a.score;
      return b.descriptor.priority - a.descriptor.priority;
    });
    return candidates;
  }

  private pickCandidate(requirements: ProviderRequirements): Candidate | null {
    const candidates = this.eligibleCandidates(requirements, 'read');
    if (candidates.length === 0) return null;

    if (requirements.stickyKey !== undefined) {
      const pinned = this.sticky.get(requirements.stickyKey);
      if (pinned !== undefined) {
        const found = candidates.find((c) => c.descriptor.id === pinned);
        if (found !== undefined) return found;
      }
    }
    return this.weightedTop2(candidates);
  }

  private nextCandidate(
    requirements: ProviderRequirements,
    methodClass: MethodClass,
    tried: ReadonlySet<string>,
    preferredId: ProviderId,
  ): Candidate | null {
    const candidates = this.eligibleCandidates(requirements, methodClass).filter(
      (c) => !tried.has(c.descriptor.id),
    );
    if (candidates.length === 0) return null;
    if (tried.size === 0) {
      const preferred = candidates.find((c) => c.descriptor.id === preferredId);
      if (preferred !== undefined) return preferred;
    }
    return this.weightedTop2(candidates);
  }

  private hasUntried(
    requirements: ProviderRequirements,
    methodClass: MethodClass,
    tried: ReadonlySet<string>,
  ): boolean {
    return this.eligibleCandidates(requirements, methodClass).some(
      (c) => !tried.has(c.descriptor.id),
    );
  }

  /** 前 2 个候选做加权随机（spec 第 8 章第 3 步）。 */
  private weightedTop2(candidates: readonly Candidate[]): Candidate {
    const pool = candidates.slice(0, 2);
    const first = pool[0] as Candidate;
    if (pool.length === 1) return first;

    const weights = pool.map((c) => Math.max(1, c.descriptor.weight));
    const total = weights.reduce((a, b) => a + b, 0);
    const roll = this.random() * total;
    let acc = 0;
    for (let i = 0; i < pool.length; i += 1) {
      acc += weights[i] as number;
      if (roll < acc) return pool[i] as Candidate;
    }
    return first;
  }

  private circuitFor(providerId: string, methodClass: MethodClass): CircuitBreaker {
    const key = `${providerId}:${methodClass}`;
    let circuit = this.circuits.get(key);
    if (circuit === undefined) {
      circuit = new CircuitBreaker(DEFAULT_CIRCUIT_OPTIONS);
      this.circuits.set(key, circuit);
    }
    return circuit;
  }

  private emitRecord(
    ctx: TransportContext,
    descriptor: ProviderDescriptor,
    call: TransportCall,
    methodClass: MethodClass,
    outcome: {
      latencyMs: number;
      status: 'success' | 'error';
      errorCode?: string | undefined;
      retryCount: number;
      circuitState: string;
      scoreAtCall: number;
      failover: boolean;
    },
  ): void {
    if (this.options.onCall === undefined) return;
    this.options.onCall({
      requestId: ctx.requestId as RequestId,
      ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
      ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
      chain: this.chain,
      network: descriptor.network,
      providerId: descriptor.id,
      providerKind: descriptor.kind,
      method: call.method,
      methodClass,
      ...outcome,
    });
  }

  /* ---------------- 运维观测 ---------------- */

  /** 健康快照（供巡检脚本或指标导出使用）。 */
  healthSnapshot(): { providerId: string; health: ReturnType<Provider['healthSnapshot']> }[] {
    const now = this.now();
    return this.providers.map((p) => ({ providerId: p.id, health: p.healthSnapshot(now) }));
  }

  /**
   * 观测快照（observability-spec §5.4 的 gauge 数据源）。
   *
   * 为什么需要单独一个方法：`healthSnapshot()` 只给健康窗口，而 §5.4 还要求
   * 熔断状态、评分与配额余量。这些是**派生值**（评分由健康窗口 + descriptor 算出），
   * 与其让调用方自己拼装、导致评分口径与路由时不一致，不如在 Manager 内一次算好——
   * 保证"指标里看到的评分"就是"选路时用的评分"。
   *
   * 只读，不触发任何网络调用。
   */
  observabilitySnapshot(): ProviderObservabilitySnapshot[] {
    const now = this.now();
    return this.providers.map((provider) => {
      const descriptor = provider.descriptor;
      const health = provider.healthSnapshot(now);
      const scored = scoreProvider({
        descriptor,
        latencyP95Ms: health.latencyP95Ms,
        errorRate: health.errorRate,
        now,
      });
      const quotaUsedRatio = this.quotaUsedRatio(provider.id, descriptor);
      return {
        providerId: provider.id,
        network: descriptor.network,
        health,
        circuitState: this.circuitFor(provider.id, 'read').current,
        score: scored.score,
        // 配额是可选的：未配置时**不**提供该值（不伪造 0/1）。
        ...(quotaUsedRatio !== undefined ? { quotaUsedRatio } : {}),
      };
    });
  }

  /**
   * 异步观测快照（E5）：与同步版本同口径，但 quotaUsedRatio 从持久 Store 读取。
   *
   * 为什么不能只改 `observabilitySnapshot()`：ProviderMetrics 的刷新路径是异步定时器，
   * 但同步方法被 Core/测试直接调用，改成 async 会破坏现有公开签名。新增方法保持兼容，
   * 生产指标路径使用它，避免多实例 / 重启后本地 Map 低报配额用量。
   */
  async observabilitySnapshotAsync(): Promise<ProviderObservabilitySnapshot[]> {
    const snapshots = this.observabilitySnapshot();
    const store = this.options.quotaStore;
    if (store === undefined) return snapshots;
    const day = new Date(this.now()).toISOString().slice(0, 10);

    return await Promise.all(
      snapshots.map(async (snapshot) => {
        const descriptor = this.providers.find((p) => p.id === snapshot.providerId)?.descriptor;
        const limit = descriptor?.quota?.requestsPerDay;
        if (descriptor === undefined || limit === undefined || limit <= 0) return snapshot;
        const used = await store.usage({ providerId: descriptor.id, chain: this.chain, day });
        return { ...snapshot, quotaUsedRatio: Math.min(1, used / limit) };
      }),
    );
  }

  /** 当日配额使用比例；无 quota 配置时返回 undefined（调用方跳过该 gauge）。 */
  private quotaUsedRatio(providerId: string, descriptor: ProviderDescriptor): number | undefined {
    const quota = descriptor.quota;
    if (quota === undefined || quota.requestsPerDay === undefined || quota.requestsPerDay <= 0) {
      return undefined;
    }
    return Math.min(1, this.dailyCallCount(providerId) / quota.requestsPerDay);
  }

  /** 记录一次真实调用（用于进程内配额比例）。按 UTC 自然日滚动，跨日自动归零。 */
  private recordDailyCall(providerId: string): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const current = this.dailyCalls.get(providerId);
    this.dailyCalls.set(
      providerId,
      current !== undefined && current.day === day
        ? { day, count: current.count + 1 }
        : { day, count: 1 },
    );
  }

  private dailyCallCount(providerId: string): number {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const current = this.dailyCalls.get(providerId);
    return current !== undefined && current.day === day ? current.count : 0;
  }

  /**
   * 预占一次日配额。
   *
   * - 未接 Store：进程内自增（旧行为）；
   * - 接 Store：委托原子 `consume`；Store 抛错时向上传播，让调用路径 fail-closed。
   */
  private async reserveDailyCall(descriptor: ProviderDescriptor): Promise<{ allowed: boolean; used: number }> {
    const limit = descriptor.quota?.requestsPerDay;
    const store = this.options.quotaStore;
    if (store === undefined || limit === undefined || limit <= 0) {
      this.recordDailyCall(descriptor.id);
      return { allowed: true, used: this.dailyCallCount(descriptor.id) };
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const result = await store.consume({
      providerId: descriptor.id,
      chain: this.chain,
      day,
      limit,
    });
    // 即使 Store 拒绝，也用返回的 used 更新本地视图，供 gauge 与后续诊断使用。
    this.dailyCalls.set(descriptor.id, { day, count: result.used });
    return result;
  }

  /**
   * 该 Provider 的当日配额是否已用尽（provider-spec §8 第 1 步的过滤条件）。
   *
   * 语义边界（刻意如此）：
   * - **未配置** `requestsPerDay` 或值 ≤ 0 ⇒ 不限额，返回 false。
   *   这是向后兼容：既有部署没有配额配置，行为必须与从前完全一致。
   * - 只有**计数达到**上限才算耗尽。计数在每次真实调用前自增（`recordDailyCall`），
   *   因此上限 N 表示"当日最多发出 N 次调用"，与上游通常的计费口径一致。
   * - 判定用 `>=`：达到上限即剔除，避免"第 N+1 次"这一点差。
   */
  private dailyQuotaExhausted(descriptor: ProviderDescriptor): boolean {
    const limit = descriptor.quota?.requestsPerDay;
    if (limit === undefined || limit <= 0) return false;
    return this.dailyCallCount(descriptor.id) >= limit;
  }

  /**
   * 因当日配额耗尽而被剔除的 Provider 数量（`acquire` 的兜底诊断用）。
   *
   * 与 `eligibleCandidates` 的过滤条件保持同一判据，避免"过滤说没了、
   * 诊断说没耗尽"这种自相矛盾。这里只按配额判断，不看熔断/能力。
   */
  private quotaExhaustedCount(requirements: ProviderRequirements): number {
    return this.providers.filter((provider) => {
      const descriptor = provider.descriptor;
      if (requirements.capability !== undefined && !descriptor.capabilities.includes(requirements.capability)) {
        return false;
      }
      if (requirements.kind !== undefined && descriptor.kind !== requirements.kind) return false;
      if (requirements.requiresArchive === true && descriptor.archive !== true) return false;
      return this.dailyQuotaExhausted(descriptor);
    }).length;
  }

  circuitState(providerId: string, methodClass: MethodClass): string {
    return this.circuitFor(providerId, methodClass).current;
  }

  /**
   * 单次低权重探针（spec 第 5 章）。
   *
   * 健康数据由 `provider.request()` 内部自动记录，这里只负责发起调用。
   * 注意：探测**不走** ProviderManager 的重试与熔断路径，避免健康检查本身被熔断放大。
   */
  /**
   * 单次低权重探针。
   *
   * `timeoutMs` 可覆盖默认 5s：就绪探针（/readyz）需要比周期健康巡检更短的超时，
   * 否则一个慢端点在就绪路径上会产生秒级延迟。
   */
  async probe(providerId: string, timeoutMs = 5000): Promise<boolean> {
    const provider = this.providers.find((p) => p.id === providerId);
    if (provider === undefined) return false;
    const controller = new AbortController();
    try {
      await provider.request(
        {
          method: provider.probeMethod,
          params: [],
          idempotency: 'safe-read',
          timeoutMs: Math.max(1, Math.min(timeoutMs, 5000)),
        },
        { requestId: newRequestId(), signal: controller.signal },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 启动周期性健康检查。
   *
   * 节奏由 HealthTracker 的探针间隔决定（healthy 60s / degraded 15s / unhealthy 5s 退避），
   * 因此这里的 tick 只是"检查有没有到期的探针"，不产生高频请求。
   * 每个 Provider 单飞，避免探测风暴（spec 第 5 章）。
   */
  startHealthChecks(tickMs = 1000): void {
    if (this.healthTimer !== undefined) return;
    this.healthTimer = setInterval(() => {
      void this.sweepHealth();
    }, tickMs);
    // 不要因为健康检查定时器阻止进程退出。
    this.healthTimer.unref?.();
  }

  stopHealthChecks(): void {
    if (this.healthTimer === undefined) return;
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  /** 立即巡检一轮；测试可直接调用而不启动定时器。 */
  async sweepHealth(): Promise<void> {
    const now = this.now();
    for (const provider of this.providers) {
      if (provider.tracker.msUntilProbe(now) > 0) continue;
      if (this.probing.has(provider.id)) continue;
      this.probing.add(provider.id);
      try {
        await this.probe(provider.id);
      } finally {
        this.probing.delete(provider.id);
      }
    }
  }
}

/** 句柄把调用委托给 Manager，因此失败切换对 Adapter 透明。 */
class ManagedProviderHandle implements ProviderHandle {
  readonly id: ProviderId;
  readonly chain: ChainId;
  private readonly manager: ProviderManager;
  private readonly requirements: ProviderRequirements;

  constructor(manager: ProviderManager, providerId: ProviderId, requirements: ProviderRequirements) {
    this.manager = manager;
    this.id = providerId;
    this.chain = manager.chain;
    this.requirements = requirements;
  }

  async request<T>(call: TransportCall, ctx: TransportContext): Promise<T> {
    return this.manager.execute<T>(call, ctx, this.requirements, this.id);
  }
}
