/**
 * In-process developer usage metering (`GET /v1/usage`, developer-product task 03).
 *
 * Why this module exists: the commercial acceptance bar requires a developer to "view usage".
 * Before it, the only usage signal was Prometheus counters — an operator tool with no project
 * attribution in the HTTP contract.
 *
 * Boundary (deliberately conservative):
 * - This is a **request meter**, not a billing ledger. It records authenticated API calls in
 *   this Gateway process and forgets them on restart.
 * - Durable aggregation, plan/quota enforcement, and invoicing are NOT implemented here and are
 *   listed as unsellable in docs/api/capability-matrix.md.
 * - Labels are bounded: route ids / capabilities / error codes are enums and chain labels are
 *   capped (`other` after the cap), so a caller cannot grow memory without limit.
 */
import type { Iso8601, UsageRouteClass } from '@dfr/types';

/** One authenticated API call, as seen by the Gateway after route matching. */
export interface UsageRecordInput {
  readonly projectId: string;
  /** Bounded route handler id (never a raw path). */
  readonly route: string;
  readonly routeClass: UsageRouteClass;
  readonly statusCode: number;
  readonly chain?: string;
  readonly capability?: string;
  /** DFR error code when the request failed; absent on success. */
  readonly errorCode?: string;
}

export interface UsageMeterOptions {
  /**
   * Maximum number of distinct chain labels kept per project; further chains collapse into
   * `other`. Chains come from caller-supplied query strings, so this map needs a hard bound.
   */
  readonly maxChainLabels?: number;
  /** Injectable clock, so `period.start` / `lastRequestAt` are deterministic in tests. */
  readonly now?: () => number;
}

export interface UsageSnapshot {
  readonly projectId: string;
  readonly period: { readonly start: Iso8601; readonly end: Iso8601 };
  readonly requests: {
    readonly total: number;
    readonly byRouteClass: Partial<Record<UsageRouteClass, number>>;
    readonly byStatusClass: Partial<Record<'success' | 'clientError' | 'serverError', number>>;
    readonly byRoute: Record<string, number>;
    readonly byChain: Record<string, number>;
    readonly byCapability: Record<string, number>;
    readonly byErrorCode: Record<string, number>;
  };
  readonly lastRequestAt?: Iso8601;
}

interface ProjectCounters {
  total: number;
  byRouteClass: Map<UsageRouteClass, number>;
  byStatusClass: Map<'success' | 'clientError' | 'serverError', number>;
  byRoute: Map<string, number>;
  byChain: Map<string, number>;
  byCapability: Map<string, number>;
  byErrorCode: Map<string, number>;
  lastRequestAt: number | undefined;
}

const DEFAULT_MAX_CHAIN_LABELS = 32;

export class UsageMeter {
  private readonly projects = new Map<string, ProjectCounters>();
  private readonly maxChainLabels: number;
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(options: UsageMeterOptions = {}) {
    this.maxChainLabels = options.maxChainLabels ?? DEFAULT_MAX_CHAIN_LABELS;
    if (!Number.isSafeInteger(this.maxChainLabels) || this.maxChainLabels < 1) {
      throw new RangeError('UsageMeter: maxChainLabels must be a positive safe integer');
    }
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  record(input: UsageRecordInput): void {
    const counters = this.countersFor(input.projectId);
    counters.total += 1;
    increment(counters.byRouteClass, input.routeClass);
    increment(counters.byStatusClass, statusClassOf(input.statusCode));
    increment(counters.byRoute, input.route);
    if (input.chain !== undefined) {
      increment(counters.byChain, this.boundedChainLabel(counters, input.chain));
    }
    if (input.capability !== undefined) increment(counters.byCapability, input.capability);
    if (input.errorCode !== undefined) increment(counters.byErrorCode, input.errorCode);
    const at = this.now();
    counters.lastRequestAt = counters.lastRequestAt === undefined ? at : Math.max(counters.lastRequestAt, at);
  }

  snapshot(projectId: string): UsageSnapshot {
    const counters = this.projects.get(projectId);
    const end = this.now();
    const base = {
      projectId,
      period: { start: iso(this.startedAt), end: iso(end) },
      requests: {
        total: counters?.total ?? 0,
        byRouteClass: toObject(counters?.byRouteClass),
        byStatusClass: toObject(counters?.byStatusClass),
        byRoute: toObject(counters?.byRoute),
        byChain: toObject(counters?.byChain),
        byCapability: toObject(counters?.byCapability),
        byErrorCode: toObject(counters?.byErrorCode),
      },
    };
    if (counters?.lastRequestAt === undefined) return base;
    return { ...base, lastRequestAt: iso(counters.lastRequestAt) };
  }

  private countersFor(projectId: string): ProjectCounters {
    let counters = this.projects.get(projectId);
    if (counters === undefined) {
      counters = {
        total: 0,
        byRouteClass: new Map(),
        byStatusClass: new Map(),
        byRoute: new Map(),
        byChain: new Map(),
        byCapability: new Map(),
        byErrorCode: new Map(),
        lastRequestAt: undefined,
      };
      this.projects.set(projectId, counters);
    }
    return counters;
  }

  private boundedChainLabel(counters: ProjectCounters, chain: string): string {
    if (counters.byChain.has(chain) || counters.byChain.size < this.maxChainLabels) return chain;
    return 'other';
  }
}

function statusClassOf(statusCode: number): 'success' | 'clientError' | 'serverError' {
  if (statusCode >= 500) return 'serverError';
  if (statusCode >= 400) return 'clientError';
  return 'success';
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Stable key order keeps the JSON response diff-friendly and makes exact assertions possible. */
function toObject<K extends string>(map: Map<K, number> | undefined): Record<K, number> {
  if (map === undefined) return {} as Record<K, number>;
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as Record<
    K,
    number
  >;
}

function iso(ms: number): Iso8601 {
  return new Date(ms).toISOString() as Iso8601;
}
