/**
 * @dfr/core — DFR Core (M0: Query Engine + Capability Router).
 */
export {
  DfrCore,
  type AdapterRegistration,
  type DfrCoreOptions,
  type CallContext,
  type TransactionStores,
  type ChainReadiness,
  type CoreReadiness,
  type AdapterCallRecord,
  type CoreOperationRecord,
} from './core.js';
export type { ProviderCallRecord, ProviderObservabilitySnapshot } from '@dfr/provider';
export {
  InMemoryTransactionObservationStore,
  type TransactionObservationStore,
} from './stores.js';
export type {
  TransactionStore,
  IdempotencyStore,
  NonceStore,
  TrackerLeaseStore,
  TransactionRecord,
  IdempotencyRecord,
} from './stores.js';
