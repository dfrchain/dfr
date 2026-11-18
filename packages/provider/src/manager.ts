/**
 * Provider Manager / Router (DFR-007, see provider-spec chapter 8).
 *
 * Externally, only `acquire(requirements)` is exposed; after the Adapter gets a handle it calls `request()`,
 * and candidate filtering, scoring, weighted selection, failover, and retries all happen inside the Manager.
 *
 * Key constraints:
 * - switching RPC Providers must not require Adapter changes;
 * - All Providers unavailable -> DFR_CHAIN_UNAVAILABLE (fail-closed, no stale cache returned);
 * - broadcast (non-idempotent-write) is never auto-retried.
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

/** The observation record produced by each Provider call (provider-spec chapter 9 fields). */
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
 * A single Provider's observation snapshot (the observability-spec §5.4 gauge data source).
 *
 * `quotaUsedRatio` is optional: when `quota.requestsPerDay` is not configured, the value is **not provided**,
 * instead of fabricating 0 or 1 — see the `observabilitySnapshot()` note.
 */
export interface ProviderObservabilitySnapshot {
  readonly providerId: string;
  readonly network: string;
  readonly health: Provider['healthSnapshot'] extends (now: number) => infer H ? H : never;
  /** Read-path circuit-breaker state; the write path has its own separate breaker (spec chapter 7). */
  readonly circuitState: string;
  /** The score computed with the **same** scoring formula as at routing time, keeping the wording consistent. */
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
  /** The safe-read retry budget cap, default 3 (spec chapter 6). */
  maxSafeReadRetries?: number;
  /** Whether idempotent-write may retry once on the same Provider; default false (explicit authorization required). */
  allowIdempotentWriteRetry?: boolean;
  /**
   * E5: the cross-process Provider daily-quota Store.
   *
   * Without one, in-process counting continues (backward compatible; accurate for single-instance deployments). With one,
   * every real call must atomically reserve quota first; a storage failure fails closed.
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
  /** The health-probe single-flight set. */
  private readonly probing = new Set<string>();
  /** Each Provider's call count for the current day (for the quota ratio); rolls automatically by calendar day. */
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

  /** The number of Providers currently configured for the chain (M0 acceptance requires at least 2 for EVM). */
  get providerCount(): number {
    return this.providers.length;
  }

  /** Select a Provider by constraints, returning a handle that can only initiate calls (the Adapter never sees endpoints or credentials). */
  async acquire(requirements: ProviderRequirements = {}): Promise<ProviderHandle> {
    const chosen = this.pickCandidate(requirements);
    if (chosen === null) {
      // Consistent with the `request()` fallback: first distinguish "why there is no candidate".
      // All breakers open already has its own `DFR_PROVIDER_CIRCUIT_OPEN`; quota exhaustion used to degrade into
      // "no available Provider meets the conditions", misleading ops into thinking it was an upstream failure.
      const quotaBlocked = this.quotaExhaustedCount(requirements);
      if (quotaBlocked > 0 && quotaBlocked === this.providerCount) {
        throw createDfrError('DFR_QUOTA_EXCEEDED', {
          requestId: newRequestId(),
          message: `All Providers for chain ${this.chain} have exhausted their daily quota`,
          chain: this.chain,
          details: { quotaKind: 'provider_daily', blockedProviders: quotaBlocked },
        });
      }
      throw createDfrError('DFR_CHAIN_UNAVAILABLE', {
        requestId: newRequestId(),
        message: `No available Provider for chain ${this.chain} meets the conditions`,
        chain: this.chain,
      });
    }
    if (requirements.stickyKey !== undefined) {
      this.sticky.set(requirements.stickyKey, chosen.descriptor.id);
    }
    return new ManagedProviderHandle(this, chosen.descriptor.id, requirements);
  }

  /** The handle's request entry: candidate switching + retries + circuit breaker + metrics all converge here. */
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
      // Quota counts "calls issued" (successes and failures both count), because upstream quotas usually count requests too.
      // E5: with a persistent Store injected, the reservation must atomically complete before the real request; a rejection or Store failure
      // must not continue to the upstream. Without an injection, keep the original in-process behavior.
      const quotaDecision = await this.reserveDailyCall(descriptor);
      if (!quotaDecision.allowed) {
        if (this.hasUntried(requirements, methodClass, tried)) continue;
        throw createDfrError('DFR_QUOTA_EXCEEDED', {
          requestId: ctx.requestId as RequestId,
          message: `All Providers for chain ${this.chain} have exhausted their daily quota`,
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

    // Quota exhaustion must be judged before "no candidate": otherwise acquire has already returned a handle,
    // but execute would misreport DFR_CHAIN_UNAVAILABLE when it finds no candidate, making ops treat a quota problem
    // as an upstream failure. Use the same criterion as acquire(), keeping the error codes consistent.
    const quotaBlocked = this.quotaExhaustedCount(requirements);
    if (quotaBlocked > 0 && quotaBlocked === this.providerCount) {
      throw createDfrError('DFR_QUOTA_EXCEEDED', {
        requestId: ctx.requestId as RequestId,
        message: `All Providers for chain ${this.chain} have exhausted their daily quota`,
        chain: this.chain,
        details: { quotaKind: 'provider_daily', blockedProviders: quotaBlocked },
      });
    }

    // Distinguish "breaker open" from "no available Provider": both fail closed, but with different error codes,
    // so callers and ops can tell "the upstream is down" from "we opened the breaker ourselves" (error-spec 4.5).
    if (this.openCircuitCount(methodClass) > 0) {
      throw createDfrError('DFR_PROVIDER_CIRCUIT_OPEN', {
        requestId: ctx.requestId as RequestId,
        message: `Providers for chain ${this.chain} are in circuit-breaker state`,
        chain: this.chain,
        details: { methodClass, openProviders: this.openCircuitCount(methodClass) },
      });
    }

    throw createDfrError('DFR_CHAIN_UNAVAILABLE', {
      requestId: ctx.requestId as RequestId,
      message: `All Providers for chain ${this.chain} are unavailable`,
      chain: this.chain,
      cause: lastError,
    });
  }

  private openCircuitCount(methodClass: MethodClass): number {
    return this.providers.filter(
      (p) => this.circuitFor(p.id, methodClass).current === 'open',
    ).length;
  }

  /* ---------------- Candidate selection ---------------- */

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

      // provider-spec §8 step 1 explicitly requires: **quota exhausted → exclude**.
      // This fills a gap the spec already wrote but the implementation lacked; it is not a new feature:
      // with `requestsPerDay: 500000`, DFR would still issue the 500001st call, having only fed the gauge and the score before,
      // blowing up the upstream quota (and possibly triggering a ban from them).
      // Only Providers with requestsPerDay **explicitly configured** are constrained: unconfigured = unlimited (same behavior as before).
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

  /** Weighted random among the top 2 candidates (spec chapter 8 step 3). */
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

  /* ---------------- Ops observation ---------------- */

  /** Health snapshot (for patrol scripts or metrics export). */
  healthSnapshot(): { providerId: string; health: ReturnType<Provider['healthSnapshot']> }[] {
    const now = this.now();
    return this.providers.map((p) => ({ providerId: p.id, health: p.healthSnapshot(now) }));
  }

  /**
   * Observation snapshot (the observability-spec §5.4 gauge data source).
   *
   * Why a separate method is needed: `healthSnapshot()` only gives the health window, while §5.4 also requires
   * breaker state, scores, and quota headroom. These are **derived values** (the score is computed from the health window + descriptor),
   * and rather than letting callers assemble them and risk a score wording inconsistent with routing time, the Manager computes them once —
   * guaranteeing "the score seen in metrics" is "the score used at routing time".
   *
   * Read-only; it triggers no network calls.
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
        // Quota is optional: when unconfigured, the value is **not** provided (no fabricated 0/1).
        ...(quotaUsedRatio !== undefined ? { quotaUsedRatio } : {}),
      };
    });
  }

  /**
   * Async observation snapshot (E5): same wording as the sync version, but quotaUsedRatio is read from the persistent Store.
   *
   * Why `observabilitySnapshot()` alone cannot just be changed: the ProviderMetrics refresh path is an async timer,
   * but the sync method is called directly by Core/tests, and making it async would break the existing public signature. The new method keeps compatibility;
   * the production metrics path uses it to avoid under-reporting quota usage after multi-instance / restart, when the local Map is low.
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

  /** The daily quota usage ratio; undefined when no quota is configured (callers skip that gauge). */
  private quotaUsedRatio(providerId: string, descriptor: ProviderDescriptor): number | undefined {
    const quota = descriptor.quota;
    if (quota === undefined || quota.requestsPerDay === undefined || quota.requestsPerDay <= 0) {
      return undefined;
    }
    return Math.min(1, this.dailyCallCount(providerId) / quota.requestsPerDay);
  }

  /** Record one real call (for the in-process quota ratio). Rolls by UTC calendar day, auto-zeroing across days. */
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
   * Reserve one daily quota unit.
   *
   * - Without a Store: in-process increment (the old behavior);
   * - with a Store: delegate to an atomic `consume`; a Store error propagates upward, failing the call path closed.
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
    // Even when the Store refuses, update the local view with the returned used count, for gauges and later diagnosis.
    this.dailyCalls.set(descriptor.id, { day, count: result.used });
    return result;
  }

  /**
   * Whether this Provider's daily quota is exhausted (the provider-spec §8 step 1 filter condition).
   *
   * Semantic boundaries (deliberate):
   * - **Unconfigured** `requestsPerDay` or a value ≤ 0 ⇒ unlimited, return false.
   *   This is backward compatibility: existing deployments have no quota configuration, and behavior must stay exactly as before.
   * - Only a count that **reaches** the cap counts as exhausted. The count increments before every real call (`recordDailyCall`),
   *   so a cap of N means "at most N calls issued per day", consistent with the usual upstream billing wording.
   * - The check uses `>=`: reaching the cap excludes the Provider, avoiding a "the N+1th call" off-by-one.
   */
  private dailyQuotaExhausted(descriptor: ProviderDescriptor): boolean {
    const limit = descriptor.quota?.requestsPerDay;
    if (limit === undefined || limit <= 0) return false;
    return this.dailyCallCount(descriptor.id) >= limit;
  }

  /**
   * The number of Providers excluded for daily quota exhaustion (for the `acquire` fallback diagnosis).
   *
   * Keeps the same criterion as the `eligibleCandidates` filter, avoiding a self-contradiction like "the filter says gone,
   * but the diagnosis says not exhausted". Only quota is judged here, not breakers/capabilities.
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
   * A single low-weight probe (spec chapter 5).
   *
   * Health data is recorded automatically inside `provider.request()`; this only initiates the call.
   * Note: probing **does not** go through the ProviderManager retry and breaker paths, so health checks themselves are not amplified by breakers.
   */
  /**
   * A single low-weight probe.
   *
   * `timeoutMs` may override the default 5s: readiness probes (/readyz) need a shorter timeout than the periodic health patrol,
   * or a slow endpoint would cause seconds of latency on the readiness path.
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
   * Start the periodic health check.
   *
   * The rhythm is set by the HealthTracker's probe interval (healthy 60s / degraded 15s / unhealthy 5s backoff),
   * so the tick here only "checks whether any probe is due" and produces no high-frequency requests.
   * Each Provider is single-flight, avoiding probe storms (spec chapter 5).
   */
  startHealthChecks(tickMs = 1000): void {
    if (this.healthTimer !== undefined) return;
    this.healthTimer = setInterval(() => {
      void this.sweepHealth();
    }, tickMs);
    // Do not let the health-check timer keep the process alive.
    this.healthTimer.unref?.();
  }

  stopHealthChecks(): void {
    if (this.healthTimer === undefined) return;
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  /** Run one patrol round immediately; tests can call it directly without starting the timer. */
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

/** The handle delegates calls to the Manager, so failover is transparent to the Adapter. */
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
