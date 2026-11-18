/**
 * Chains, networks, and runtime chain info (see docs/architecture/domain-model.md section 3.1).
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
 * Delivery milestone (audit fix A-01).
 *
 * This is **registry deployment metadata**, not a domain fact about the chain: it answers "in which milestone this chain is enabled",
 * independent of the chain's own capabilities. So it only appears in `ChainRegistryEntry`, never in `Chain`.
 */
export type Milestone = 'M0' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7';

/**
 * Validation status of the finality config (audit fix A-01).
 *
 * This is a **domain fact**: `unverified` means the FinalityPolicy in the Registry is still an ungrounded assumption,
 * and consumers (especially fund-related callers like BEX) need it to decide whether to trust the chain's finality promise.
 * DFR-014 upgrades it to `verified` with evidence after real RPC verification.
 */
export type FinalityStatus = 'unverified' | 'verified';

/** A chain in the Chain Registry. Static facts; runtime state is in ChainInfo. */
export interface Chain {
  id: ChainId;
  /** Display name, for UI only, never an identifier. */
  displayName: string;
  family: ChainFamily;
  /**
   * Network category. Uniquely determined by `id`; this field is a descriptive attribute, not an independent parameter
   * (audit fix A-07/A-08: the duplicate networkKind field has been removed).
   */
  network: NetworkId;
  /** EVM chainId or other high-level chain identifier, decimal or hex string; empty for non-EVM. */
  externalChainId?: string;
  adapter: ChainAdapterRef;
  finality: FinalityPolicy;
  /** Whether the finality config has been verified with real RPC (audit fix A-01). */
  finalityStatus: FinalityStatus;
  capabilities: readonly CapabilityId[];
  /** Whether a supported browser/explorer exists, for the Console only. */
  explorerUrl?: string;
}

/**
 * A registry entry in the Chain Registry = domain `Chain` + deployment metadata (audit fix A-01).
 *
 * Why split: `Chain` is the domain model; the loader reads the registry and projects a `Chain` for Core;
 * `milestone` is only used by build/gate logic and must not leak into runtime domain objects.
 */
export interface ChainRegistryEntry extends Chain {
  milestone: Milestone;
}

export interface ChainAdapterRef {
  /** E.g. "evm" / "solana". */
  id: string;
  /** semver range, e.g. "^0.1.0". */
  version: string;
}

/**
 * Runtime chain state snapshot.
 * Note: field meanings differ across chain families; unsupported fields must be omitted, not filled with 0.
 */
export interface ChainInfo {
  chain: ChainId;
  network: NetworkId;
  family: ChainFamily;
  /** Latest EVM height. */
  height?: DecimalUint;
  /** Latest Solana slot. */
  slot?: DecimalUint;
  /** Latest EVM block hash. */
  latestBlockHash?: string;
  /** Node software version, e.g. "geth/v1.14.0". */
  nodeVersion?: string;
  /** EVM suggested base fee (wei), decimal string. */
  baseFeePerGas?: DecimalUint;
  /** Whether the chain is in maintenance/degraded state. */
  degraded?: boolean;
  observedAt: Iso8601;
}
