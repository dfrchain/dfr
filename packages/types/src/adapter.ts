/**
 * Adapter contract (see docs/architecture/adapter-spec-v0.1.md).
 *
 * Uses "base interface + Capability-split interfaces", not a single wide interface.
 * Undeclared capabilities must return DFR_UNSUPPORTED_CAPABILITY; silent degradation is forbidden.
 */
import type { ChainId, NetworkId, ChainFamily, RequestId, DecimalUint } from './primitives.js';
import type { SequencingToken } from './sequencing.js';
import type { CapabilityId, AdapterCapabilities } from './capability.js';
import type { ChainInfo } from './chain.js';
import type { Account, AccountRef } from './account.js';
import type { AssetRef, Balance } from './asset.js';
import type { BlockRef, Block, FinalityState } from './block.js';
import type { ChainLog } from './transaction.js';
import type {
  TransactionRef,
  Transaction,
  Receipt,
  TransactionRequest,
  UnsignedTransaction,
  SignedTransaction,
  SimulationResult,
  BroadcastResult,
  BroadcastOptions,
  ConfirmRequest,
  ConfirmationResult,
} from './transaction.js';
import type { EventFilter, ChainEvent } from './event.js';
import type { ProviderRouter } from './provider.js';

/** Injected by the Provider Manager; the Adapter holds no endpoints or credentials. */
export interface AdapterContext {
  chain: ChainId;
  network: NetworkId;
  /** Provider router; the Adapter acquires on demand and holds no endpoints or credentials. */
  providers: ProviderRouter;
  signal: AbortSignal;
  requestId: RequestId;
  traceId?: string;
  spanId?: string;
}

/** The base interface every Adapter must implement. */
export interface ChainAdapter {
  readonly family: ChainFamily;
  /** Adapter implementation version (semver). */
  readonly version: string;
  readonly specVersion: '0.1';
  getInfo(ctx: AdapterContext): Promise<ChainInfo>;
  capabilities(): AdapterCapabilities;
}

export interface GetBalanceRequest {
  account: AccountRef;
  asset?: AssetRef;
  consistency?: ConsistencyHint;
}

export interface BalanceCapability {
  getBalance(ctx: AdapterContext, req: GetBalanceRequest): Promise<Balance>;
}

export interface BlockCapability {
  getBlock(ctx: AdapterContext, ref: BlockRef): Promise<Block | null>;
}

export interface TransactionQueryCapability {
  getTransaction(ctx: AdapterContext, ref: TransactionRef): Promise<Transaction | null>;
  getReceipt?(ctx: AdapterContext, ref: TransactionRef): Promise<Receipt | null>;
}

export interface BuildCapability {
  build(ctx: AdapterContext, req: TransactionRequest): Promise<UnsignedTransaction>;
}

/**
 * Supplementary input for `simulate` (added in DFR-M1-B07, optional, backward compatible).
 *
 * `UnsignedTransaction` itself carries no sender (the payload has only chainId/nonce/to/value/gas/data
 * and fee fields). Calling the Adapter directly without `options` keeps B03 behavior: no fabricated `from`,
 * and an explicit statement in `warnings` that "sender-related checks were not covered".
 *
 * The Transaction Engine owns the record and knows the payload's sender; it passes `from` via `options.from` so the
 * Adapter can add `from` to `eth_call`, making the balance / allowance / nonce checks actually effective.
 */
export interface SimulationOptions {
  /** The sender in the record; only meaningful on the payload path (`UnsignedTransaction`). */
  from?: AccountRef;
}

export interface SimulationCapability {
  simulate(
    ctx: AdapterContext,
    req: TransactionRequest | UnsignedTransaction,
    options?: SimulationOptions,
  ): Promise<SimulationResult>;
}

/**
 * Non-Capability Adapter extension method: read the on-chain pending nonce (DFR-M1-B07).
 *
 * Deliberately **not** in `CapabilityId` / `capabilities()`: it is not an outward-facing API capability and cannot be
 * routed directly by the Gateway; it only serves the Transaction Engine's nonce lease (m1-storage-model §3).
 * Core decides support by "method existence"; when missing, it fails closed to
 * `DFR_UNSUPPORTED_CAPABILITY` with no silent degradation.
 */
export interface PendingNonceReadMethod {
  /** On-chain pending nonce, decimal string (never via JS `number`). */
  getPendingNonce(ctx: AdapterContext, account: AccountRef): Promise<DecimalUint>;
}

/**
 * Non-Capability Adapter extension method: decide whether an **ordering precondition** has expired under current chain state
 * (DFR-M3-A01, ADR-032).
 *
 * Why the Adapter must own it (roadmap M3's first red line: "chain-specific expiry semantics live in the Adapter"):
 * expiry is **chain-specific** —
 *   - Solana: compare `getBlockHeight()` against the token's `lastValidBlockHeight`
 *     (by **block height**, not time; measured devnet window is about 166 blocks);
 *   - EVM: a nonce never "expires", it is only consumed by a higher nonce → do not implement this method.
 *
 * As with `PendingNonceReadMethod`: not in `CapabilityId` / `capabilities()`, cannot be
 * routed directly by the Gateway; it only serves the Transaction Engine's sequencing lease (`SequencingStore`).
 * Core decides support by **method existence**; when missing, it is treated as "never expires" (EVM semantics) —
 * this is an explicit convention, not silent degradation.
 */
/**
 * Non-Capability Adapter extension method: get this chain's current **ordering precondition** (ADR-032/033).
 *
 * As with `PendingNonceReadMethod`: not in `CapabilityId` / `capabilities()`, only serves
 * the Transaction Engine's sequencing lease — EVM uses `getPendingNonce` (the nonce path),
 * Solana uses this method (the blockhash path). Core decides which path to take by method existence.
 */
export interface SequencingTokenReadMethod {
  getSequencingToken(ctx: AdapterContext, account: AccountRef): Promise<SequencingToken>;
}

/**
 * Non-Capability Adapter extension method: inject the **engine-assigned ordering precondition** into the request (ADR-033).
 *
 * Solana's `build` must use the blockhash already chosen by the engine/Store and placed under lease (otherwise lease and payload
 * disagree, bypassing the "repeated builds of the same transaction are stable" guarantee). EVM uses `req.nonce`,
 * and does not need this method.
 */
export interface EnsureSequencingTokenMethod {
  /** Returns the request with the ordering precondition injected (input not mutated); an illegally shaped token fails closed. */
  withSequencingToken(req: TransactionRequest, token: SequencingToken): TransactionRequest;
}

export interface SequencingTokenExpiryMethod {
  isSequencingExpired(ctx: AdapterContext, token: SequencingToken): Promise<boolean>;
}

/**
 * Input/output of on-chain observation after broadcast (DFR-M1-C03b, ADR-019).
 *
 * Defined in `types` rather than `transaction` because it is the **chain-access contract** between Adapter and Core
 * (the Adapter reports what it saw), while "which state event it maps to" is state semantics and stays in the transaction package.
 * Core only carries these fields; it does not interpret them.
 */
export interface BroadcastObservationRequest {
  readonly chain: ChainId;
  /** The expectedHash in the record (recomputed from the payload, not declared by the caller). */
  readonly txHash: string;
  readonly from: AccountRef;
  readonly nonce: DecimalUint;
}

export type BroadcastObservation =
  | { readonly kind: 'included'; readonly txHash: string; readonly blockRef?: BlockRef }
  | { readonly kind: 'pending'; readonly txHash: string }
  | { readonly kind: 'replaced'; readonly nonce: DecimalUint; readonly byTxHash?: string }
  /**
   * Not found by expectedHash, and the nonce is still unoccupied.
   *
   * Note: **not the same as dropped** — mempool propagation is asynchronous, and other endpoints may still hold the transaction.
   * Whether it counts as `dropped` is decided by the upper layer after the `dropTimeoutMs` window (ADR-019).
   */
  | { readonly kind: 'absent' };

/**
 * Non-Capability Adapter extension method: observe the on-chain situation after broadcast (DFR-M1-C03b).
 *
 * As with `PendingNonceReadMethod`: not in `CapabilityId` / `capabilities()`,
 * because it is an internal coordination entry, not an outward-facing API capability. Core decides by method existence;
 * when missing, the engine keeps `unknown` (fail-closed, never pretends dropped / failed).
 */
export interface BroadcastObservationReadMethod {
  observeBroadcast(
    ctx: AdapterContext,
    req: BroadcastObservationRequest,
  ): Promise<BroadcastObservation>;
}

/** A single read-only confirmation observation; Provider/Adapter do no polling or state persistence. */
export interface ChainConfirmationObservation {
  readonly status: Transaction['status'];
  readonly finality: FinalityState;
  readonly blockRef?: BlockRef;
  readonly canonicalBlockHash?: string;
  readonly confirmations?: DecimalUint;
}

/**
 * Internal confirmation observation entry, not the `transaction.confirm.native` Capability.
 * Core/Transaction own finality policy decisions, leases, waiting, and persistence coordination.
 */
export interface ConfirmationObservationReadMethod {
  observeConfirmation(
    ctx: AdapterContext,
    req: { readonly txHash: string },
  ): Promise<ChainConfirmationObservation | null>;
}

export interface BroadcastCapability {
  /**
   * Broadcast a signed transaction.
   *
   * Audit fix A-06: added the `options` parameter to carry the `rebroadcast` flag and idempotency key.
   * transaction-lifecycle.md requires a `dropped → broadcast` replay to carry `rebroadcast: true`,
   * but the old signature had nowhere to carry it.
   */
  broadcast(
    ctx: AdapterContext,
    signed: SignedTransaction,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult>;
}

/**
 * Native confirmation capability (optional, R-02).
 *
 * The default path is Core deriving confirmations by polling with transaction.read + the Registry's FinalityPolicy;
 * only chains offering native confirmation subscriptions implement this interface and declare `transaction.confirm.native`.
 */
export interface NativeConfirmCapability {
  waitForConfirmation(ctx: AdapterContext, req: ConfirmRequest): Promise<ConfirmationResult>;
}

/** event.subscribe is a deployment-level capability (ADR-025): the Adapter does not implement it; this interface is only for type mapping. */
export interface EventCapability {
  subscribe(ctx: AdapterContext, filter: EventFilter): AsyncIterable<ChainEvent>;
}

/**
 * Read-only contract call (ADR-035, `eth_call`).
 *
 * Two inputs, pick exactly one; **providing both fails closed** (to avoid ambiguity over "which one"):
 *   - `data`: pre-encoded calldata (`0x…`) — use this when BEX already has `cast calldata`;
 *   - `abi` + `method` (+ `args`): encoded by the Adapter with viem, decoded against outputs and returned.
 */
export interface ContractReadRequest {
  readonly chain?: ChainId;
  readonly contract: string;
  /** Pre-encoded calldata (0x…). Either this or abi/method. */
  readonly data?: string;
  /** Human-readable or JSON fragment; used for encoding and decoding when method is provided. */
  readonly abi?: readonly (string | Record<string, unknown>)[];
  readonly method?: string;
  readonly args?: readonly unknown[];
  readonly blockRef?: BlockRef;
}

export interface ContractReadResult {
  /** The raw `eth_call` return (0x…). */
  readonly data: string;
  /** Value decoded against outputs when abi+method are provided; otherwise absent. */
  readonly decoded?: unknown;
}

export interface ContractReadCapability {
  readContract(ctx: AdapterContext, req: ContractReadRequest): Promise<ContractReadResult>;
}

/**
 * Account existence / contract determination (ADR-036, `eth_getCode` + `eth_getTransactionCount`).
 *
 * Reuses the existing `Account` / `AccountKind`. EVM: non-empty code → `contract`, otherwise `externally-owned`;
 * `exists` is a **heuristic** (non-empty code, or balance > 0, or nonce > 0) and does not claim precision.
 */
export interface AccountCodeCapability {
  getAccount(ctx: AdapterContext, account: AccountRef): Promise<Account>;
}

/**
 * Event log query (ADR-034, BEX on-chain reconciliation).
 *
 * **Different** semantics from `contract.read` (`eth_call`): logs are fetched by **block range** here.
 * A bounded range is a hard constraint: `fromBlock`/`toBlock` are required, and a span exceeding the Adapter-declared
 * `constraints.maxBlockRange` fails closed (no silent truncation).
 */
export interface ContractLogsRequest {
  readonly chain?: ChainId;
  /** Contract address; omitted = any contract (caution: a bounded range is still required). */
  readonly address?: string;
  /** Aligned with `eth_getLogs` topics: null = wildcard, array = OR. */
  readonly topics?: readonly (string | readonly string[] | null)[];
  readonly fromBlock: BlockRef;
  readonly toBlock: BlockRef;
  /** Maximum number of results per call; implementations may tighten further. */
  readonly limit?: number;
}

export interface ContractLogsCapability {
  logs(ctx: AdapterContext, req: ContractLogsRequest): Promise<readonly ChainLog[]>;
}

export interface ConsistencyHint {
  mode: 'best-effort' | 'at-block' | 'finalized';
  blockRef?: BlockRef;
}

/** Capability → interface mapping notes for Core routing (type level). */
export interface AdapterCapabilityMap {
  'account.balance': BalanceCapability;
  'block.read': BlockCapability;
  'transaction.read': TransactionQueryCapability;
  'transaction.build': BuildCapability;
  'transaction.simulate': SimulationCapability;
  'transaction.broadcast': BroadcastCapability;
  'event.subscribe': EventCapability;
  'account.code': AccountCodeCapability;
  'contract.read': ContractReadCapability;
  'contract.logs': ContractLogsCapability;
  'transaction.confirm.native': NativeConfirmCapability;
}

export type AdapterCapabilityId = keyof AdapterCapabilityMap;

/** Compile-time guarantee that CapabilityId and the interface mapping agree. */
export type _AssertCapabilityParity = CapabilityId extends AdapterCapabilityId
  ? AdapterCapabilityId extends CapabilityId
    ? true
    : never
  : never;
