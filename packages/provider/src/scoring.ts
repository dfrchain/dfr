/**
 * Provider 评分（见 docs/architecture/provider-spec-v0.1.md 第 4 章）。
 *
 * 规则 M0 定稿：数值可调，规则不可暗改。
 *
 *   score = 100
 *         - latencyPenalty(0..30)   基于 P95 相对基线
 *         - errorPenalty(0..30)     基于错误率
 *         - quotaPenalty(0..20)     额度剩余不足时惩罚
 *         - costPenalty(0..10)      单位成本
 *         + priorityBonus(0..10)    运营优先级（与 Registry priority 同量纲）
 *   下限 0，上限 100
 */
import type { ProviderDescriptor, ProviderId, ProviderScore } from '@dfr/types';

/** P95 基线：达到该延迟即扣满延迟分。 */
export const LATENCY_BASELINE_MS = 1000;

/** 延迟未知时的中性取值（P95 的一半），避免新 Provider 被无端惩罚或过度优待。 */
export const LATENCY_UNKNOWN_MS = LATENCY_BASELINE_MS / 2;

export interface ScoreInputs {
  descriptor: ProviderDescriptor;
  latencyP95Ms?: number | undefined;
  errorRate?: number | undefined;
  /** 已用配额比例 0..1；undefined 表示无限额或未统计。 */
  quotaUsedRatio?: number | undefined;
  now: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function latencyPenalty(p95: number): number {
  return clamp((p95 / LATENCY_BASELINE_MS) * 30, 0, 30);
}

function errorPenalty(errorRate: number): number {
  return clamp(errorRate * 30, 0, 30);
}

function quotaPenalty(usedRatio: number | undefined): number {
  if (usedRatio === undefined) return 0;
  return clamp(usedRatio * 20, 0, 20);
}

function costPenalty(descriptor: ProviderDescriptor): number {
  const price = descriptor.cost?.priceUsd;
  if (price === undefined) return 0;
  const parsed = Number(price);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // 每请求 1 美元即扣满；M0 配置全为 0，保留公式供后续接入付费 Provider。
  return clamp(parsed * 10, 0, 10);
}

function priorityBonus(descriptor: ProviderDescriptor): number {
  return clamp(descriptor.priority, 0, 10);
}

/** 计算单个 Provider 的得分。 */
export function scoreProvider(inputs: ScoreInputs): ProviderScore {
  const { descriptor, now } = inputs;
  const latency = latencyPenalty(inputs.latencyP95Ms ?? LATENCY_UNKNOWN_MS);
  const errorRate = clamp(inputs.errorRate ?? 0, 0, 1);
  const error = errorPenalty(errorRate);
  const quota = quotaPenalty(inputs.quotaUsedRatio);
  const cost = costPenalty(descriptor);
  const priority = priorityBonus(descriptor);

  const score = clamp(100 - latency - error - quota - cost + priority, 0, 100);

  const providerId: ProviderId = descriptor.id;
  return {
    providerId,
    score,
    inputs: {
      latency,
      errorRate: error,
      availability: 0,
      quotaRemaining: quota,
      cost,
      priority,
    },
    computedAt: new Date(now).toISOString() as ProviderScore['computedAt'],
  };
}
