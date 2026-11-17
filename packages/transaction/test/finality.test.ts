import { describe, expect, it } from 'vitest';
import type { DecimalUint, FinalityPolicy, FinalityState } from '@dfr/types';
import { evaluateFinality } from '../src/finality.js';

describe('evaluateFinality', () => {
  it('confirmations 使用十进制字符串比较，达到阈值后为 confirmed', () => {
    const policy: FinalityPolicy = { kind: 'confirmations', confirmations: 12 };
    expect(evaluateFinality({ policy, finalityStatus: 'verified', confirmations: '11' as DecimalUint, required: 'confirmed' }).reached).toBe(false);
    expect(evaluateFinality({ policy, finalityStatus: 'verified', confirmations: '12' as DecimalUint, required: 'confirmed' })).toMatchObject({ observed: 'confirmed', reached: true });
  });

  it('checkpoint 只有 finalized tag 才满足 finalized', () => {
    const policy: FinalityPolicy = { kind: 'checkpoint', finalizedTag: true };
    expect(evaluateFinality({ policy, finalityStatus: 'verified', observed: 'confirmed', required: 'finalized' }).reached).toBe(false);
    expect(evaluateFinality({ policy, finalityStatus: 'verified', observed: 'finalized', required: 'finalized' }).reached).toBe(true);
  });

  it('未验证策略不能作为结算级 finalized 依据', () => {
    expect(evaluateFinality({ policy: { kind: 'checkpoint', finalizedTag: true }, finalityStatus: 'unverified', observed: 'finalized', required: 'finalized' })).toMatchObject({ reached: false, reason: 'unverified_policy' });
  });

  it('unknown/orphaned 永不达标', () => {
    expect(evaluateFinality({ policy: { kind: 'none' }, finalityStatus: 'verified', observed: 'unknown', required: 'submitted' }).reached).toBe(false);
    expect(evaluateFinality({ policy: { kind: 'none' }, finalityStatus: 'verified', observed: 'orphaned', required: 'submitted' }).reached).toBe(false);
  });
});

describe('commitment 策略（ADR-031，M2 Solana 路径的前提）', () => {
  const policy: FinalityPolicy = {
    kind: 'commitment',
    levels: ['processed', 'confirmed', 'finalized'],
  };

  it('included 等价于 processed，属于已声明层级（修复前被误判 unsupported_commitment）', () => {
    // 真实缺陷：policy.levels 是 Commitment（processed|confirmed|finalized），
    // 而 observed 是 FinalityState（submitted|included|...）。两域只有两个值相交，
    // `processed` 在 FinalityState 中无对应值——最接近的 `included` 会被判"不受支持"。
    const result = evaluateFinality({
      policy, finalityStatus: 'verified', observed: 'included', required: 'confirmed',
    });
    expect(result.observed).toBe('included');
    expect(result.reason).not.toBe('unsupported_commitment');
    expect(result.reached).toBe(false); // processed < confirmed，尚未达标但路径可用
  });

  it('processed 本身即可满足 required=included', () => {
    const result = evaluateFinality({
      policy, finalityStatus: 'verified', observed: 'included', required: 'included',
    });
    expect(result).toMatchObject({ observed: 'included', reached: true });
  });

  it('submitted 尚未进入 commitment 层级 → 未达标，但不是"不受支持"', () => {
    const result = evaluateFinality({
      policy, finalityStatus: 'verified', observed: 'submitted', required: 'included',
    });
    expect(result.reached).toBe(false);
    expect(result.reason, '未进入层级不应报 unsupported_commitment').not.toBe('unsupported_commitment');
  });

  it('confirmed / finalized 达标（同名映射）', () => {
    expect(evaluateFinality({ policy, finalityStatus: 'verified', observed: 'confirmed', required: 'confirmed' }).reached).toBe(true);
    expect(evaluateFinality({ policy, finalityStatus: 'verified', observed: 'finalized', required: 'finalized' }).reached).toBe(true);
  });

  it('无法反查为 commitment 的观察仍报 unsupported_commitment（负对照，ADR-031 修订后保留）', () => {
    // 修订前的负对照用"收窄 levels + observed finalized"断言 unsupported——
    // 那正是 F-1 的悖论：观测比声明的最高层级更强，按单调语义应当达标
    // （见下方回归用例）。修订后仍须 fail-closed 的，是根本无法反查、
    // 无法与 commitment 全序比较的观察：例如运行时出现枚举之外的
    // FinalityState（未来扩展或异构 Adapter 的未知值）。
    const result = evaluateFinality({
      policy, finalityStatus: 'verified',
      observed: 'snapshot' as FinalityState, required: 'confirmed',
    });
    expect(result.reason).toBe('unsupported_commitment');
    expect(result.reached).toBe(false);
  });

  it('观测强于声明的最高层级仍按单调语义达标（ADR-031 修订：F-1 回归）', () => {
    // solana-devnet 的真实形状：levels 只声明 [processed, confirmed]
    // （finalityStatus unverified），Adapter 却如实观测到 finalized。
    // 修订前 evaluateFinality 在此报 unsupported_commitment、reached=false，
    // engine.confirm 对已 finalized 的交易永远无法收敛（Finding F-1）。
    const devnet: FinalityPolicy = { kind: 'commitment', levels: ['processed', 'confirmed'] };
    expect(evaluateFinality({
      policy: devnet, finalityStatus: 'unverified', observed: 'finalized', required: 'confirmed',
    })).toMatchObject({ observed: 'finalized', reached: true });
    // required 的 processed 等级在 FinalityLevel 域写作 included。
    expect(evaluateFinality({
      policy: devnet, finalityStatus: 'unverified', observed: 'finalized', required: 'included',
    }).reached).toBe(true);
  });

  it('收窄 levels 到 [confirmed] 时 finalized 观测同样达标（原负对照形状的修订后语义）', () => {
    const narrowed: FinalityPolicy = { kind: 'commitment', levels: ['confirmed'] };
    const result = evaluateFinality({
      policy: narrowed, finalityStatus: 'verified', observed: 'finalized', required: 'confirmed',
    });
    expect(result).toMatchObject({ observed: 'finalized', reached: true });
  });

  it('观测弱于要求时仍未达标（单调语义不改变未达标判定）', () => {
    const devnet: FinalityPolicy = { kind: 'commitment', levels: ['processed', 'confirmed'] };
    const result = evaluateFinality({
      policy: devnet, finalityStatus: 'unverified', observed: 'included', required: 'confirmed',
    });
    expect(result.reached).toBe(false);
    expect(result.reason).not.toBe('unsupported_commitment');
  });

  it('未验证的 devnet 仍不得据此宣称 finalized（finalityStatus 保护伞）', () => {
    const result = evaluateFinality({
      policy, finalityStatus: 'unverified', observed: 'finalized', required: 'finalized',
    });
    expect(result).toMatchObject({ reached: false, reason: 'unverified_policy' });
  });
});
