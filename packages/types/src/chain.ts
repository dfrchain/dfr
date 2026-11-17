/**
 * 链、网络与运行时链信息（见 docs/architecture/domain-model.md 第 3.1 节）。
 */
import type {
  ChainId,
  ChainFamily,
  NetworkId,
  DecimalUint,
  Iso8601,
} from './primitives.js';
import type { CapabilityId, FinalityPolicy } from './capability.js';

/**
 * 交付里程碑（审计修正 A-01）。
 *
 * 这是**注册表部署元数据**，不是链的领域事实：它回答"这条链在哪个里程碑启用"，
 * 与链本身的能力无关。因此它只出现在 `ChainRegistryEntry`，不进入 `Chain`。
 */
export type Milestone = 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7';

/**
 * 最终性配置的验证状态（审计修正 A-01）。
 *
 * 这是**领域事实**：`unverified` 表示 Registry 中的 FinalityPolicy 仍是无依据的假设，
 * 消费方（尤其 BEX 这类资金相关调用方）需要据此决定是否信任该链的最终性承诺。
 * DFR-014 用真实 RPC 验证后升级为 `verified`，并附证据。
 */
export type FinalityStatus = 'unverified' | 'verified';

/** Chain Registry 中的一条链。静态事实，运行时状态见 ChainInfo。 */
export interface Chain {
  id: ChainId;
  /** 展示名，仅用于 UI，不可作为标识。 */
  displayName: string;
  family: ChainFamily;
  /**
   * 网络类别。由 `id` 唯一决定，此字段是描述属性而非独立参数
   * （审计修正 A-07/A-08：已删除重复的 networkKind 字段）。
   */
  network: NetworkId;
  /** EVM chainId 等高链标识，十进制或十六进制字符串；非 EVM 可为空。 */
  externalChainId?: string;
  adapter: ChainAdapterRef;
  finality: FinalityPolicy;
  /** 最终性配置是否已用真实 RPC 验证（审计修正 A-01）。 */
  finalityStatus: FinalityStatus;
  capabilities: readonly CapabilityId[];
  /** 是否存在受支持的浏览器/资源管理器，仅用于 Console。 */
  explorerUrl?: string;
}

/**
 * Chain Registry 中的一条注册表条目 = 领域 `Chain` + 部署元数据（审计修正 A-01）。
 *
 * 拆分的理由：`Chain` 是领域模型，加载器从注册表读取后应投影出 `Chain` 交给 Core；
 * `milestone` 只被构建/门禁逻辑使用，不应泄漏到运行时领域对象。
 */
export interface ChainRegistryEntry extends Chain {
  milestone: Milestone;
}

export interface ChainAdapterRef {
  /** 例如 "evm" / "solana"。 */
  id: string;
  /** semver 范围，例如 "^0.1.0"。 */
  version: string;
}

/**
 * 运行时链状态快照。
 * 注意：不同链族字段含义不同，未支持字段必须省略而不是填 0。
 */
export interface ChainInfo {
  chain: ChainId;
  network: NetworkId;
  family: ChainFamily;
  /** EVM 最新高度。 */
  height?: DecimalUint;
  /** Solana 最新 slot。 */
  slot?: DecimalUint;
  /** EVM 最新区块哈希。 */
  latestBlockHash?: string;
  /** 节点软件版本，例如 "geth/v1.14.0"。 */
  nodeVersion?: string;
  /** EVM 建议的 base fee（wei），十进制字符串。 */
  baseFeePerGas?: DecimalUint;
  /** 该链是否处于维护/降级状态。 */
  degraded?: boolean;
  observedAt: Iso8601;
}
