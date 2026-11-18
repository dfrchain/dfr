/**
 * Account model (see docs/architecture/domain-model.md section 4.2).
 *
 * In the Alpha phase, AccountRef only denotes an address reference; no account abstraction, session keys, or smart accounts are involved.
 * No private keys, mnemonics, or any signing credential fields exist or are allowed in this model.
 */
import type { ChainId, DecimalUint } from './primitives.js';

/**
 * Account reference.
 *
 * Audit fix A-08: the `network` field was removed. The network is uniquely determined by `chain`
 * (`ethereum-sepolia` is necessarily testnet), and carrying both would let callers pass contradictory combinations,
 * while the old spec defined no tie-breaking rule for conflicts.
 */
export interface AccountRef {
  chain: ChainId;
  /** Chain-native encoded address; validity is checked by the Adapter, Core makes no format assumptions. */
  address: string;
  /** Only used by some chains (e.g. Cosmos memo/tag). */
  memo?: string;
}

export type AccountKind = 'externally-owned' | 'contract' | 'program' | 'unknown';

export interface Account {
  ref: AccountRef;
  kind: AccountKind;
  /** EVM nonce. */
  nonce?: DecimalUint;
  /** Solana has no nonce; account data length and similar are used as existence references. */
  dataLength?: DecimalUint;
  /** Whether the account already exists (used to identify uninitialized accounts). */
  exists: boolean;
  /** Human-readable label, maintained only by the caller/control plane, never from the chain. */
  label?: string;
}
