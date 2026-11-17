/**
 * Provider 模型（见 docs/architecture/provider-spec-v0.1.md）。
 *
 * 边界：Provider 只负责传输与端点管理，不理解链语义。
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
  /** 由 chain 推导，注册表不单独配置（审计修正 A-08）。 */
  network: NetworkId;
  kind: ProviderKind;
  /** 必须为引用（env:/file:/vault:），禁止内联明文 URL 凭证。 */
  endpointRef: EndpointRef;
  /** 公开端点使用 "none"。 */
  credentialRef: CredentialRef | 'none';
  /** 该端点实际支持的能力子集。 */
  capabilities: readonly CapabilityId[];
  /**
   * 是否为归档节点（可查询历史状态 / 日志）。
   *
   * 审计修正 A-26：provider-spec 第 8 章的负载均衡第 1 步要求按 `requiresArchive`
   * 过滤候选，但 `ProviderDescriptor` 与 JSON Schema 都没有承载"这个端点是不是归档节点"
   * 的字段，该过滤规则无法实现。这里补一个可选布尔字段（新增可选字段属兼容变更）。
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
  /** 已用额度由 Provider Manager 统计，不写入配置文件。 */
}

/**
 * Provider 日配额的原子预占端口（E5）。
 *
 * 语义：`consume` 必须先原子地判断并消耗一次额度，返回是否允许调用；
 * 调用方只有在 `allowed=true` 时才可以向上游发请求。计数必须跨进程共享，
 * 不能把“读计数”和“写计数”拆成两个非原子步骤。
 *
 * 端口放在 `@dfr/types`，使 Provider 层定义调用形状、Storage 层实现 SQL，
 * 两者不需要互相依赖。
 */
export interface ProviderQuotaConsumeInput {
  readonly providerId: string;
  readonly chain: ChainId;
  /** UTC 自然日，格式 `YYYY-MM-DD`。 */
  readonly day: string;
  readonly limit: number;
}

export interface ProviderQuotaConsumeResult {
  /** 是否允许本次调用；false 表示额度已满或原子预占失败。 */
  readonly allowed: boolean;
  /** 当前已消耗额度（允许时为本次成功预占后的值）。 */
  readonly used: number;
}

export interface ProviderQuotaUsageInput {
  readonly providerId: string;
  readonly chain: ChainId;
  readonly day: string;
}

export interface ProviderQuotaStore {
  /**
   * 原子预占一次额度。实现必须保证并发调用不会超过 `limit`。
   * 存储不可用时抛错；调用方必须 fail-closed，不得继续发请求。
   */
  consume(input: ProviderQuotaConsumeInput): Promise<ProviderQuotaConsumeResult>;
  /** 读取当前已用额度；无记录时返回 0。 */
  usage(input: ProviderQuotaUsageInput): Promise<number>;
}

export interface ProviderCost {
  unit: 'request' | 'compute-unit' | 'gb';
  /** 美元单价，十进制字符串。 */
  priceUsd: string;
}

export interface ProviderCall {
  /** 例如 "eth_getBalance"；由 Adapter 构造，Provider 不理解其语义。 */
  method: string;
  params: readonly unknown[];
  /** 重试策略的唯一依据。 */
  idempotency: IdempotencyClass;
  timeoutMs: number;
}

export interface ProviderContext {
  requestId: string;
  traceId?: string;
  spanId?: string;
  signal: AbortSignal;
}

/** 单次调用的 Provider 约束（R-04）。 */
export interface ProviderRequirements {
  /**
   * 需要该端点支持的能力（审计修正 A-03）。
   *
   * provider-spec 第 8 章第 1 步要求按 Capability 过滤候选 Provider，
   * 但旧版 `ProviderRequirements` 没有表达能力需求，路由无法实现该过滤规则。
   * Adapter 必须在 acquire 时声明它要执行的能力，例如 `transaction.read`。
   */
  capability?: CapabilityId;
  /** 需要的传输类型，例如订阅需要 json-rpc-ws。 */
  kind?: ProviderKind;
  /** 需要归档数据（例如历史状态/日志查询）。 */
  requiresArchive?: boolean;
  /**
   * 粘滞键：同一值必须路由到同一 Provider（例如确认跟踪期间的连续读取）。
   * 典型取值：链上交易哈希。
   */
  stickyKey?: string;
}

/** Adapter 持有的 Provider 句柄：只能发起调用，不能访问端点或凭证。 */
export interface ProviderHandle {
  readonly id: ProviderId;
  readonly chain: ChainId;
  request<T>(call: ProviderCall, ctx: ProviderContext): Promise<T>;
}

/**
 * Adapter 通过路由器按需获取句柄（R-04）。
 *
 * 只注入单一 ProviderHandle 无法表达"这次要 archive"、"订阅要 WS"、
 * "确认跟踪必须粘在同一 Provider"，因此 AdapterContext 注入路由器而非句柄。
 */
export interface ProviderRouter {
  readonly chain: ChainId;
  /** 按约束选择一个可用 Provider；无满足条件的 Provider 时抛 DFR_CHAIN_UNAVAILABLE。 */
  acquire(requirements?: ProviderRequirements): Promise<ProviderHandle>;
}

export type ProviderStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ProviderHealth {
  status: ProviderStatus;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  /** 0..1，滑动窗口。 */
  errorRate?: number;
  lastCheckedAt: Iso8601;
  consecutiveFailures: number;
}

export interface ProviderScore {
  providerId: ProviderId;
  /** 0..100，越大越优。 */
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
