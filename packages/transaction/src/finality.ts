/** 纯最终性判定（DFR-M1-D01）：不访问链、Store 或时钟。 */
import { commitmentOf, reachesFinalityLevel } from '@dfr/types';
import type { DecimalUint, FinalityLevel, FinalityPolicy, FinalityState, FinalityStatus } from '@dfr/types';

export interface EvaluateFinalityInput {
  readonly policy: FinalityPolicy;
  readonly finalityStatus: FinalityStatus;
  readonly required: FinalityLevel;
  /** Adapter / tracker 已观测到的结算状态。 */
  readonly observed?: FinalityState;
  /** confirmations 策略的链上确认数，十进制字符串。 */
  readonly confirmations?: DecimalUint;
}

export interface FinalityEvaluation {
  readonly observed: FinalityState;
  readonly reached: boolean;
  readonly reason?: 'unverified_policy' | 'insufficient_confirmations' | 'unsupported_commitment';
}

export function evaluateFinality(input: EvaluateFinalityInput): FinalityEvaluation {
  let observed = input.observed ?? 'submitted';
  if (observed === 'unknown' || observed === 'orphaned') return { observed, reached: false };

  if (input.policy.kind === 'confirmations') {
    const confirmations = input.confirmations === undefined ? 0n : BigInt(input.confirmations);
    if (confirmations >= BigInt(input.policy.confirmations)) observed = 'confirmed';
    else if (observed !== 'finalized') {
      return { observed, reached: false, reason: 'insufficient_confirmations' };
    }
  }

  if (input.policy.kind === 'commitment') {
    // ADR-031：`observed` 是 FinalityState，而 `levels` 是 Commitment，两域不同名。
    // 先反查它代表的 commitment。
    const commitment = commitmentOf(observed);
    if (commitment === undefined) {
      if (observed === 'submitted') {
        // 尚未进入任何 commitment 层级——这是"还没到"，不是"不受支持"（ADR-031 §2 不变）。
        return { observed, reached: false };
      }
      // 无法反查、无法与 commitment 全序比较的观察（例如运行时出现的未知枚举值）：
      // fail-closed，仍报 unsupported_commitment（ADR-031 2026-11-05 修订后保留）。
      return { observed, reached: false, reason: 'unsupported_commitment' };
    }
    // ADR-031 2026-11-05 修订（单调语义）：commitment 是全序
    // processed < confirmed < finalized，观测强度达到/超过 required 即达标——
    // 即使它强于 `levels` 声明的最高层级（如 devnet 只声明 [processed, confirmed]，
    // 而 Adapter 如实观测到 finalized）。`levels` 声明的是"实际可区分的层级"
    // （ADR-031 §3），不再用作观测的准入闸门；是否达标由下方共享的
    // reachesFinalityLevel 按同一全序裁决（映射保序），弱于 required 即未达标。
  }

  // 未经真实链验证的策略不得支撑结算级 finalized 声明。
  if (input.required === 'finalized' && input.finalityStatus !== 'verified') {
    return { observed, reached: false, reason: 'unverified_policy' };
  }
  return { observed, reached: reachesFinalityLevel(observed, input.required) };
}
