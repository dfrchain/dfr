/**
 * Provider scoring (see docs/architecture/provider-spec-v0.1.md, chapter 4).
 *
 * Rules finalized at M0: the numbers are tunable, the rules must not be changed silently.
 *
 *   score = 100
 *         - latencyPenalty(0..30)   based on P95 vs. baseline
 *         - errorPenalty(0..30)     based on error rate
 *         - quotaPenalty(0..20)     penalty when remaining quota is low
 *         - costPenalty(0..10)      unit cost
 *         + priorityBonus(0..10)    ops priority (same dimension as Registry priority)
 *   floor 0, cap 100
 */
import type { ProviderDescriptor, ProviderId, ProviderScore } from '@dfr/types';

/** The P95 baseline: reaching this latency deducts the full latency score. */
export const LATENCY_BASELINE_MS = 1000;

/** The neutral value when latency is unknown (half of P95), avoiding unfairly penalizing or favoring a new Provider. */
export const LATENCY_UNKNOWN_MS = LATENCY_BASELINE_MS / 2;

export interface ScoreInputs {
  descriptor: ProviderDescriptor;
  latencyP95Ms?: number | undefined;
  errorRate?: number | undefined;
  /** The used quota ratio, 0..1; undefined means unlimited or uncounted. */
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
  // $1 per request deducts the full amount; all M0 configs are 0, keeping the formula for later paid Providers.
  return clamp(parsed * 10, 0, 10);
}

function priorityBonus(descriptor: ProviderDescriptor): number {
  return clamp(descriptor.priority, 0, 10);
}

/** Compute one Provider's score. */
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
