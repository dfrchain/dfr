/**
 * Provider model (see docs/architecture/provider-spec-v0.1.md).
 *
 * Boundary: the Provider only handles transport and endpoint management; it does not understand chain semantics.
 */
import type {
  ChainId,
  NetworkId,
  ProviderId,
  ProviderKind,
  EndpointRef,
  CredentialRef,
  Iso8601,
} from './primitives.js';
import type { CapabilityId } from './capability.js';

export type IdempotencyClass =
  | 'safe-read'
  | 'idempotent-write'
  | 'non-idempotent-write';

export interface ProviderDescriptor {
  id: ProviderId;
  chain: ChainId;
  /** Derived from chain; the registry does not configure it separately (audit fix A-08). */
  network: NetworkId;
  kind: ProviderKind;
  /** Must be a reference (env:/file:/vault:); inline plaintext URL credentials are forbidden. */
  endpointRef: EndpointRef;
  /** Public endpoints use "none". */
  credentialRef: CredentialRef | 'none';
  /** The subset of capabilities this endpoint actually supports. */
  capabilities: readonly CapabilityId[];
  /**
   * Whether it is an archive node (can query historical state / logs).
   *
   * Audit fix A-26: step 1 of load balancing in provider-spec chapter 8 requires filtering candidates by `requiresArchive`,
   * but neither `ProviderDescriptor` nor the JSON Schema carried a field for "whether this endpoint is an archive node",
   * so the filter rule could not be implemented. Add an optional boolean field here (adding an optional field is a compatible change).
   */
  archive?: boolean;
  priority: number;
  weight: number;
  timeoutMs: number;
  quota?: ProviderQuota;
  cost?: ProviderCost;
}

export interface ProviderQuota {
  requestsPerSecond?: number;
  requestsPerDay?: number;
  /** Used quota is counted by the Provider Manager; it is not written into the config file. */
}

/**
 * Atomic pre-occupation port for the Provider daily quota (E5).
 *
 * Semantics: `consume` must first atomically check and consume one unit of quota, returning whether the call is allowed;
 * the caller may only send a request upstream when `allowed=true`. The counter must be shared across processes;
 * "read the counter" and "write the counter" must not be split into two non-atomic steps.
 *
 * The port lives in `@dfr/types` so the Provider layer defines the call shape and the Storage layer implements the SQL,
 * with neither needing to depend on the other.
 */
export interface ProviderQuotaConsumeInput {
  readonly providerId: string;
  readonly chain: ChainId;
  /** UTC calendar day, format `YYYY-MM-DD`. */
  readonly day: string;
  readonly limit: number;
}

export interface ProviderQuotaConsumeResult {
  /** Whether this call is allowed; false means the quota is full or atomic pre-occupation failed. */
  readonly allowed: boolean;
  /** Currently consumed quota (on allow, the value after this successful pre-occupation). */
  readonly used: number;
}

export interface ProviderQuotaUsageInput {
  readonly providerId: string;
  readonly chain: ChainId;
  readonly day: string;
}

export interface ProviderQuotaStore {
  /**
   * Atomically pre-occupy one unit of quota. The implementation must guarantee concurrent calls cannot exceed `limit`.
   * Throws when storage is unavailable; the caller must fail closed and must not keep sending requests.
   */
  consume(input: ProviderQuotaConsumeInput): Promise<ProviderQuotaConsumeResult>;
  /** Read the currently used quota; returns 0 when there is no record. */
  usage(input: ProviderQuotaUsageInput): Promise<number>;
}

export interface ProviderCost {
  unit: 'request' | 'compute-unit' | 'gb';
  /** USD unit price, decimal string. */
  priceUsd: string;
}

export interface ProviderCall {
  /** E.g. "eth_getBalance"; constructed by the Adapter, the Provider does not understand its semantics. */
  method: string;
  params: readonly unknown[];
  /** The only basis for the retry policy. */
  idempotency: IdempotencyClass;
  timeoutMs: number;
}

export interface ProviderContext {
  requestId: string;
  traceId?: string;
  spanId?: string;
  signal: AbortSignal;
}

/** Per-call Provider constraints (R-04). */
export interface ProviderRequirements {
  /**
   * The capabilities this endpoint must support (audit fix A-03).
   *
   * provider-spec chapter 8 step 1 requires filtering candidate Providers by Capability,
   * but the old `ProviderRequirements` could not express a capability need, so routing could not implement the filter rule.
   * The Adapter must declare the capability it is about to execute when acquiring, e.g. `transaction.read`.
   */
  capability?: CapabilityId;
  /** The transport type needed, e.g. subscriptions need json-rpc-ws. */
  kind?: ProviderKind;
  /** Archive data needed (e.g. historical state/log queries). */
  requiresArchive?: boolean;
  /**
   * Stickiness key: the same value must route to the same Provider (e.g. consecutive reads during confirmation tracking).
   * Typical value: the on-chain transaction hash.
   */
  stickyKey?: string;
}

/** A Provider handle held by the Adapter: it can only make calls, never access endpoints or credentials. */
export interface ProviderHandle {
  readonly id: ProviderId;
  readonly chain: ChainId;
  request<T>(call: ProviderCall, ctx: ProviderContext): Promise<T>;
}

/**
 * The Adapter acquires handles on demand via the router (R-04).
 *
 * Injecting a single ProviderHandle cannot express "this call needs archive", "subscriptions need WS", or
 * "confirmation tracking must stay pinned to the same Provider", so AdapterContext injects the router, not a handle.
 */
export interface ProviderRouter {
  readonly chain: ChainId;
  /** Select an available Provider by constraints; throws DFR_CHAIN_UNAVAILABLE when no Provider meets them. */
  acquire(requirements?: ProviderRequirements): Promise<ProviderHandle>;
}

export type ProviderStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ProviderHealth {
  status: ProviderStatus;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  /** 0..1, sliding window. */
  errorRate?: number;
  lastCheckedAt: Iso8601;
  consecutiveFailures: number;
}

export interface ProviderScore {
  providerId: ProviderId;
  /** 0..100, larger is better. */
  score: number;
  inputs: {
    latency: number;
    errorRate: number;
    availability: number;
    quotaRemaining: number;
    cost: number;
    priority: number;
  };
  computedAt: Iso8601;
}

export type CircuitState = 'closed' | 'open' | 'half-open';
