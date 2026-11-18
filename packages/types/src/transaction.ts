/**
 * Transaction and receipt model (see docs/architecture/domain-model.md section 4.5,
 * docs/architecture/transaction-lifecycle.md).
 *
 * Never introduce any private key, mnemonic, or credential field in this file.
 */
import type { ChainId, DecimalUint, Iso8601 } from './primitives.js';
import type { AccountRef } from './account.js';
import type { AssetRef } from './asset.js';
import type { BlockRef, FinalityLevel, FinalityState } from './block.js';
import type { DfrError } from './errors.js';

export type TransactionRef =
  | { kind: 'hash'; hash: string }
  | { kind: 'id'; id: string };

export type TransactionStatus =
  | 'built'
  | 'simulated'
  | 'signed'
  | 'broadcast'
  | 'pending'
  | 'included'
  | 'confirmed'
  | 'finalized'
  | 'failed'
  | 'reverted'
  | 'dropped'
  | 'replaced'
  | 'unknown'
  /**
   * An unbroadcast transaction **explicitly voided** (ADR-037).
   *
   * Only reachable from `built` / `simulated`: `signed` and above **never** enter this state,
   * so the fund-safety constraint "a signed/broadcast nonce cannot be reused" is unaffected.
   */
  | 'abandoned';

export interface Transaction {
  schemaVersion: '1';
  ref: TransactionRef;
  chain: ChainId;
  status: TransactionStatus;
  blockRef?: BlockRef;
  from?: AccountRef;
  to?: AccountRef;
  value?: Amount;
  fee?: Amount;
  /** EVM nonce; other chains may omit it. */
  nonce?: DecimalUint;
  /** Confirmations obtained, decimal string to avoid large-number issues. */
  confirmations?: DecimalUint;
  error?: DfrError;
  observedAt?: Iso8601;
  /**
   * Chain-specific raw data. Internal use only:
   * - never enters a public HTTP response;
   * - never enters logs;
   * - callers must not depend on its structure.
   */
  raw?: unknown;
}

export interface Amount {
  asset: AssetRef;
  amount: DecimalUint;
}

export interface Receipt {
  ref: TransactionRef;
  chain: ChainId;
  /** Whether execution succeeded (EVM receipt.status == 1). */
  success: boolean;
  blockRef?: BlockRef;
  /** Gas or compute consumed, decimal string. */
  gasUsed?: DecimalUint;
  /**
   * Actual fee (including tip). Audit fix A-21: use `Amount` to carry the pricing asset;
   * the old version was a bare DecimalUint, leaving consumers unable to tell which currency the fee was in.
   */
  effectiveFee?: Amount;
  logs?: readonly ChainLog[];
  /** Failure reason (redacted). */
  revertReason?: string;
}

export interface ChainLog {
  /** EVM log index (`logIndex`). */
  index?: DecimalUint;
  address?: string;
  /** Event topic / Solana program identifier. */
  topics?: readonly string[];
  data?: string;
  /** Decoded event parameters (only when the ABI is known). */
  decoded?: Record<string, unknown>;
  /** The block the log is in (needed by `contract.logs` queries; ADR-034). */
  blockRef?: BlockRef;
  /** Transaction hash within the block and log sequence within the transaction. */
  txHash?: string;
  txIndex?: DecimalUint;
  /** Logs voided after a reorg (the `removed` flag of `eth_getLogs`). */
  removed?: boolean;
}

/* ------------------------------------------------------------------ */
/* Transaction lifecycle: build / simulate / sign / broadcast / confirm        */
/* ------------------------------------------------------------------ */

export interface TransactionRequest {
  chain: ChainId;
  from: AccountRef;
  to?: AccountRef;
  value?: Amount;
  /** Calldata encoded as hex (EVM) or base64 (Solana). */
  data?: string;
  maxFee?: DecimalUint;
  /** EVM nonce; when omitted, derived explicitly by the build phase and written to meta. */
  nonce?: DecimalUint;
  /**
   * Solana recent blockhash; when omitted, taken from the latest on-chain value by the build phase (ADR-033).
   * When the engine has already assigned an ordering precondition, it is **injected** into this field so lease and payload agree.
   */
  recentBlockhash?: string;
  commitment?: string;
  options?: TransactionOptions;
}

export interface TransactionOptions {
  /** Default true; a failed simulation must block broadcast. */
  simulateBeforeBroadcast?: boolean;
  /** Default: do not wait for finality. An ordered target level (audit fix A-10). */
  waitForFinality?: FinalityLevel;
  idempotencyKey?: string;
}

export interface UnsignedTransaction {
  schemaVersion: '1';
  chain: ChainId;
  /** Opaque payload, interpretable only by the Adapter that generated it. */
  payload: string;
  meta: UnsignedTransactionMeta;
}

export interface UnsignedTransactionMeta {
  /**
   * The payload's encoding (audit fix A-22). The old version did not declare an encoding, so binary payloads could only rely on convention.
   */
  encoding?: 'hex' | 'base64';
  requiresNonce?: DecimalUint;
  chainIdForSigning?: string;
  /** Solana recent blockhash. */
  recentBlockhash?: string;
  expiresAt?: Iso8601;
  feeEstimate?: Amount;
  /** Risk notes the caller should watch, e.g. the destination address is new. */
  warnings?: readonly string[];
}

export interface SignedTransaction {
  schemaVersion: '1';
  chain: ChainId;
  unsigned: UnsignedTransaction;
  /** Signed payload. Must not be written to logs, error details, or anywhere other than plaintext database storage. */
  signedPayload: string;
  /** Expected hash for dedupe before broadcast. */
  expectedHash: string;
  /** Only identifies the signing source, e.g. "external:wallet", not a credential. */
  signerRef?: string;
}

export interface SimulationResult {
  success: boolean;
  /** Estimated consumption (EVM gas / Solana compute units). */
  estimatedCost?: DecimalUint;
  /** Estimated fee. */
  estimatedFee?: Amount;
  revertReason?: string;
  /** State-change summary, for caller display or policy decisions. */
  stateChanges?: readonly StateChange[];
  warnings?: readonly string[];
}

export interface StateChange {
  kind: 'balance' | 'allowance' | 'storage' | 'account' | 'unknown';
  account?: string;
  asset?: AssetRef;
  before?: string;
  after?: string;
  note?: string;
}

export interface BroadcastResult {
  ref: TransactionRef;
  status: TransactionStatus;
  accepted: boolean;
  /** Raw identifier returned by the broadcast node (redacted). */
  providerId?: string;
  /**
   * Whether this broadcast is a replay (audit fix A-06).
   *
   * The `dropped → broadcast` back edge is defined by transaction-lifecycle.md and requires this flag,
   * but the old contract had no field to carry it, so the spec required a property that did not exist.
   */
  rebroadcast?: boolean;
  observedAt: Iso8601;
}

/**
 * Broadcast options (audit fix A-06).
 *
 * The old `broadcast()` signature was just `(ctx, signed)` and could not carry a replay flag or idempotency key;
 * those are properties of the broadcast call itself, not of the signed transaction, so they go on the options parameter.
 */
export interface BroadcastOptions {
  /** Replay of the same nonce; used to resubmit a `dropped` transaction. */
  rebroadcast?: boolean;
  /** Idempotency key, matching the HTTP layer's Idempotency-Key. */
  idempotencyKey?: string;
  /**
   * The sender in the record (DFR-M1-C03a).
   *
   * Same source as `SimulationOptions.from`: `UnsignedTransaction` / `SignedTransaction`
   * both **lack** a sender, and "the from recovered from the signature must equal the account that originally reserved the nonce"
   * can only come from the record. The Adapter needs it for chain-semantics checks; Core/Gateway only carry it.
   */
  expectedFrom?: AccountRef;
  /**
   * The **unsigned** payload saved in the record (the source of truth).
   *
   * The client sends back the unsigned payload returned by build, but that is only an echo; the Adapter must compare against the record,
   * otherwise "swap parameters but reuse the same transactionId" cannot be detected (m1-api-contract section 3).
   */
  expectedUnsignedPayload?: string;
}

export interface ConfirmRequest {
  chain: ChainId;
  ref: TransactionRef;
  /** Minimum acceptable finality, default decided by the Chain Registry. Ordered target level (audit fix A-10). */
  minFinality?: FinalityLevel;
  timeoutMs?: number;
}

export interface ConfirmationResult {
  ref: TransactionRef;
  status: TransactionStatus;
  finality: FinalityState;
  /** The target actually evaluated; may be omitted when no observation was obtained (e.g. the lease is held by another owner). */
  requiredFinality?: FinalityLevel;
  blockRef?: BlockRef;
  canonicalBlockHash?: string;
  confirmations?: DecimalUint;
  /** true means the requirement was met before the timeout; false means still tracking. */
  reached: boolean;
}
