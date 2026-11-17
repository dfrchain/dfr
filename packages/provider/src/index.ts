/**
 * @dfr/provider —— DFR Provider 层（DFR-006 / DFR-007）。
 *
 * 规范来源：docs/architecture/provider-spec-v0.1.md
 */
export {
  JsonRpcHttpProvider,
  methodClassOf,
  type Provider,
  type JsonRpcProviderOptions,
  type TransportCall,
  type TransportContext,
} from './transport.js';
export {
  ProviderManager,
  type ProviderManagerOptions,
  type ProviderCallRecord,
  type ProviderObservabilitySnapshot,
} from './manager.js';
export type {
  ProviderQuotaConsumeInput,
  ProviderQuotaConsumeResult,
  ProviderQuotaStore,
  ProviderQuotaUsageInput,
} from '@dfr/types';
export {
  CircuitBreaker,
  DEFAULT_CIRCUIT_OPTIONS,
  type CircuitOptions,
  type MethodClass,
} from './circuit.js';
export { HealthTracker } from './health.js';
export {
  decideRetry,
  BACKOFF_SCHEDULE_MS,
  type RetryDecision,
  type RetryInput,
} from './retry.js';
export {
  scoreProvider,
  LATENCY_BASELINE_MS,
  LATENCY_UNKNOWN_MS,
  type ScoreInputs,
} from './scoring.js';
export {
  createStubFetch,
  stubDescriptor,
  type StubBehavior,
  type StubCall,
  type StubFetchOptions,
} from './testing.js';
