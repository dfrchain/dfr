/**
 * Capability model (see docs/architecture/adapter-spec-v0.1.md section 3).
 *
 * A Capability is an Adapter declaration, not a runtime probe:
 * undeclared requests must return DFR_UNSUPPORTED_CAPABILITY; silent degradation is forbidden.
 *
 * 2026-10-03 review fixes (R-01 / R-02):
 * - `chain.info` is no longer a Capability: `ChainAdapter.getInfo()` is a mandatory method, and declaring it
 *   as an optional capability would make "can a chain without chain.info declared still getInfo" semantically uncertain.
 * - `transaction.confirm` is no longer a Capability: confirmation can be derived from `transaction.read` + the Registry's
 *   `FinalityPolicy`, and making it an optional capability would create the meaningless combination "can read transactions but cannot confirm them".
 *   Only use `transaction.confirm.native` when a chain offers a native confirmation subscription.
 *
 * Fact-source rule (R-03): `Registry.capabilities` is the allowlist (what is enabled outwardly),
 * `Adapter.capabilities()` is the capability truth (what the chain can actually do). At startup, verify
 * `registry ⊆ adapter`; a violation fails closed with `DFR_CONFIGURATION_ERROR`; at runtime, the Adapter is authoritative.
 */
import type { ChainId, NetworkId, DecimalUint, Commitment } from './primitives.js';

/**
 * The runtime capability list, the only fact source for `CapabilityId`.
 *
 * Exists as a constant array so the contract is machine-checkable: consistency tests assert this array is
 * exactly the same as the enums in `docs/api/openapi.yaml` and `chains.schema.json`
 * (see tests/contract/spec-consistency.test.ts).
 *
 * Only additions are allowed; never delete or change semantics; additions must sync Registry, OpenAPI, and JSON Schema.
 */
export const CAPABILITY_IDS = [
  'account.balance',
  // ADR-036: account existence / contract determination (eth_getCode + nonce).
  'account.code',
  'block.read',
  'transaction.read',
  'transaction.build',
  'transaction.simulate',
  'transaction.broadcast',
  'event.subscribe',
  'contract.read',
  // ADR-034: event log query (different from contract.read's eth_call semantics).
  'contract.logs',
  /** Native confirmation subscription. Not needed in M0/M1; Core derives confirmations by polling with transaction.read by default. */
  'transaction.confirm.native',
] as const;

/** Capability identifier type derived from the runtime list. */
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** The capability set an Adapter declares, with capability boundary constraints. */
export interface AdapterCapabilities {
  specVersion: '0.1';
  chain: ChainId;
  network: NetworkId;
  capabilities: readonly CapabilityId[];
  constraints?: CapabilityConstraints;
}

export interface CapabilityConstraints {
  /**
   * Maximum block span allowed per query (e.g. an eth_getLogs limit), decimal string.
   *
   * Note (R-05): finality policy is not here. The only fact source for `FinalityPolicy` is the Chain Registry;
   * at startup, the Adapter only asserts "whether I support this policy"; unsupported policies fail closed.
   */
  maxBlockRange?: DecimalUint;
  /** Whether the chain requires a memo/tag. */
  requiresMemo?: boolean;
  /** Whether archive queries are supported. */
  supportsArchive?: boolean;
}

export type FinalityPolicy =
  | { kind: 'none' }
  | { kind: 'confirmations'; confirmations: number }
  | { kind: 'checkpoint'; finalizedTag: true }
  | { kind: 'commitment'; levels: readonly Commitment[] };
