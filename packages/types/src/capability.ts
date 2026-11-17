/**
 * Capability 模型（见 docs/architecture/adapter-spec-v0.1.md 第 3 节）。
 *
 * Capability 是 Adapter 的声明，不是运行时的试探：
 * 未声明的请求必须返回 DFR_UNSUPPORTED_CAPABILITY，禁止静默降级。
 *
 * 2026-10-03 评审修正（R-01 / R-02）：
 * - `chain.info` 不再作为 Capability：`ChainAdapter.getInfo()` 是强制方法，把它同时
 *   声明为可选能力会导致"未声明 chain.info 的链能否 getInfo"语义不确定。
 * - `transaction.confirm` 不再作为 Capability：确认可由 `transaction.read` + Registry 的
 *   `FinalityPolicy` 派生，做成可选能力会产生"可读交易但不可确认"的无意义组合。
 *   仅当某链提供原生确认订阅时才使用 `transaction.confirm.native`。
 *
 * 事实来源规则（R-03）：`Registry.capabilities` 是允许清单（对外启用了什么），
 * `Adapter.capabilities()` 是能力真相（链实际能做什么）。启动时校验
 * `registry ⊆ adapter`，违反则 `DFR_CONFIGURATION_ERROR` fail-closed；运行时以 Adapter 为准。
 */
import type { ChainId, NetworkId, DecimalUint, Commitment } from './primitives.js';

/**
 * 运行时的能力清单，是 `CapabilityId` 的唯一事实来源。
 *
 * 以常量数组形式存在，使契约可被机器校验：一致性测试会断言本数组与
 * `docs/api/openapi.yaml`、`chains.schema.json` 中的枚举完全相同
 * （见 tests/contract/spec-consistency.test.ts）。
 *
 * 只能增加，不得删除或改变语义；新增需同步 Registry、OpenAPI 与 JSON Schema。
 */
export const CAPABILITY_IDS = [
  'account.balance',
  // ADR-036：账户存在性 / 合约判定（eth_getCode + nonce）。
  'account.code',
  'block.read',
  'transaction.read',
  'transaction.build',
  'transaction.simulate',
  'transaction.broadcast',
  'event.subscribe',
  'contract.read',
  // ADR-034：事件日志查询（与 contract.read 的 eth_call 语义不同）。
  'contract.logs',
  /** 原生确认订阅。M0/M1 不需要；Core 默认用 transaction.read 轮询派生确认。 */
  'transaction.confirm.native',
] as const;

/** 由运行时清单派生的能力标识类型。 */
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** Adapter 声明的能力集合与能力边界约束。 */
export interface AdapterCapabilities {
  specVersion: '0.1';
  chain: ChainId;
  network: NetworkId;
  capabilities: readonly CapabilityId[];
  constraints?: CapabilityConstraints;
}

export interface CapabilityConstraints {
  /**
   * 单次查询允许的最大区块跨度（例如 eth_getLogs 限制），十进制字符串。
   *
   * 注意（R-05）：最终性策略不在此处。`FinalityPolicy` 的唯一事实来源是 Chain Registry；
   * Adapter 启动时只做"我是否支持该策略"的断言，不支持则 fail-closed。
   */
  maxBlockRange?: DecimalUint;
  /** 该链是否要求 memo/tag。 */
  requiresMemo?: boolean;
  /** 是否支持归档查询。 */
  supportsArchive?: boolean;
}

export type FinalityPolicy =
  | { kind: 'none' }
  | { kind: 'confirmations'; confirmations: number }
  | { kind: 'checkpoint'; finalizedTag: true }
  | { kind: 'commitment'; levels: readonly Commitment[] };
