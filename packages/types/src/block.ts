/**
 * 区块模型与区块引用（见 docs/architecture/domain-model.md 第 4.4 节）。
 */
import type { ChainId, DecimalUint, Iso8601, Commitment } from './primitives.js';

export type BlockRef =
  | { kind: 'number'; number: DecimalUint }
  | { kind: 'hash'; hash: string }
  | { kind: 'slot'; slot: DecimalUint }
  | { kind: 'tag'; tag: 'latest' | 'safe' | 'finalized'; commitment?: Commitment };

export interface Block {
  chain: ChainId;
  /** EVM 高度。 */
  number?: DecimalUint;
  /** Solana slot。 */
  slot?: DecimalUint;
  hash: string;
  parentHash?: string;
  /** Unix 秒，十进制字符串。 */
  timestamp?: DecimalUint;
  /** 交易数量（只给出计数，交易列表通过分页接口获取）。 */
  transactionCount?: number;
  /** EVM 该区块使用的基础费。 */
  baseFeePerGas?: DecimalUint;
  /** 该区块是否已被后续区块确认（由 FinalityPolicy 判定）。 */
  finality?: FinalityState;
  observedAt: Iso8601;
}

/**
 * 交易/区块的**观测到**的最终性状态。独立声明以避免与 transaction.ts 产生循环依赖。
 *
 * 注意（审计修正 A-09）：本类型包含 `orphaned` / `unknown` 这类**不是有序目标**的取值，
 * 因此**不得**用作"最低要求"参数。需要目标语义时使用 `FinalityLevel`。
 */
export type FinalityState =
  | 'submitted'
  | 'included'
  | 'confirmed'
  | 'finalized'
  | 'orphaned'
  | 'unknown';

/**
 * 严格有序的最终性**目标等级**（审计修正 A-10）。
 *
 * 用于 `ConfirmRequest.minFinality`、`TransactionOptions.waitForFinality` 等"至少达到"语义。
 * 顺序（由弱到强）：submitted < included < confirmed < finalized。
 *
 * 这里刻意不含 `orphaned` / `unknown`：它们描述异常观测结果，不是可追求的目标；
 * 旧版本用完整的 `FinalityState` 导致调用方可以传 `orphaned` 作为"最低最终性"。
 */
export type FinalityLevel = 'submitted' | 'included' | 'confirmed' | 'finalized';

/**
 * `Commitment`（Solana 域）到 `FinalityState`（DFR 观察域）的映射（ADR-031）。
 *
 * 两个枚举只有 `confirmed` / `finalized` 同名；`processed` 在 `FinalityState` 中
 * 没有对应值，最接近的语义是 `included`（已进入区块、未确认）。
 * 该映射必须**显式**存在，否则按 `Commitment` 比 `FinalityState` 会把
 * `included` 误判为"不受支持的 commitment"。
 */
export const COMMITMENT_TO_FINALITY_STATE: Readonly<Record<Commitment, FinalityState>> = {
  processed: 'included',
  confirmed: 'confirmed',
  finalized: 'finalized',
};

/** `FinalityState` → `Commitment` 的反查（不属于任何 commitment 时返回 undefined）。 */
export function commitmentOf(observed: FinalityState): Commitment | undefined {
  if (observed === 'included') return 'processed';
  if (observed === 'confirmed') return 'confirmed';
  if (observed === 'finalized') return 'finalized';
  return undefined;
}

/** FinalityLevel 的强度序号，供 Core 比较"是否达到要求"使用。 */
export const FINALITY_ORDER: Readonly<Record<FinalityLevel, number>> = {
  submitted: 0,
  included: 1,
  confirmed: 2,
  finalized: 3,
};

/** 判断观测状态是否已达到某个目标等级。`orphaned` / `unknown` 一律视为未达到。 */
export function reachesFinalityLevel(
  observed: FinalityState,
  required: FinalityLevel,
): boolean {
  if (observed === 'orphaned' || observed === 'unknown') return false;
  return FINALITY_ORDER[observed] >= FINALITY_ORDER[required];
}
