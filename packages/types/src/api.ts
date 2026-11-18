/**
 * HTTP-layer DTOs (see docs/api/openapi.yaml, ADR-009).
 *
 * JSON fields are always camelCase; amounts and numbers are always decimal strings.
 *
 * Response envelope rule (audit fix A-16): **every** success response must carry `requestId`,
 * so responses can be correlated with requests across logs and traces. Older versions only attached
 * `requestId` to the balance / block / transaction response types; list responses lacked it, leaving troubleshooting unable to link a response to its request.
 */
import type { ChainId, Cursor, DecimalUint, Iso8601, RequestId, TransactionId } from './primitives.js';
import type { Chain } from './chain.js';
import type { CapabilityId } from './capability.js';
import type { Balance } from './asset.js';
import type { Block, FinalityLevel } from './block.js';
import type {
  ChainLog,
  ConfirmationResult,
  SimulationResult,
  SignedTransaction,
  Transaction,
  TransactionStatus,
  UnsignedTransaction,
} from './transaction.js';
import type { DfrError, DfrErrorCode, ErrorCategory } from './errors.js';

export interface Page<T> {
  items: readonly T[];
  /** Opaque cursor; clients must not parse it. */
  nextCursor?: Cursor;
  hasMore: boolean;
}

/** RFC 9457 Problem Details + DFR extension fields. */
export interface DfrErrorResponse {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  dfr_code: DfrErrorCode;
  category: ErrorCategory;
  retryable: boolean;
  safe_to_retry: boolean;
  request_id: string;
  chain?: string;
  provider?: string;
  details?: Record<string, unknown>;
  chain_error?: { code?: string; message?: string };
}

export interface ListChainsResponse {
  items: readonly Chain[];
  requestId: RequestId;
}

export interface GetBalanceResponse {
  balance: Balance;
  requestId: RequestId;
  observedAt: Iso8601;
}

export interface GetBlockResponse {
  block: Block;
  requestId: RequestId;
}

/** Response of `POST /v1/logs` (ADR-034 + cursor pagination). */
export interface LogsPageResponse {
  readonly logs: readonly ChainLog[];
  /** True when `nextCursor` is present and more logs exist within the pinned range. */
  readonly hasMore: boolean;
  /** Opaque, stateless continuation. Do not construct or parse it; send it back unchanged. */
  readonly nextCursor?: string;
  readonly requestId: RequestId;
}

export interface GetTransactionResponse {
  transaction: Transaction;
  requestId: RequestId;
}

/**
 * M1 write-endpoint request body (see docs/architecture/m1-api-contract.md section 2).
 */
export interface ConfirmTransactionRequest {
  /** Together with the txHash in the path, locates the transaction; chain appears only once, in the request body. */
  chain: ChainId;
  /** Minimum acceptable finality; when omitted, the Registry policy for that chain decides. */
  minFinality?: FinalityLevel;
  /** Maximum wait in milliseconds; when omitted, the default applies, with the upper bound enforced by the Gateway. */
  timeoutMs?: number;
}

export interface BroadcastTransactionRequest {
  /** The internal execution identifier txn_<ULID> returned by build, used to locate the saved unsigned transaction. */
  transactionId: TransactionId;
  signedTransaction: SignedTransaction;
  /** Default false; replay only when explicitly true for the dropped state. */
  rebroadcast?: boolean;
}

/**
 * M1 write-endpoint success response envelope (see docs/architecture/m1-api-contract.md section 1).
 *
 * Rule: write endpoints must **not** return a bare domain object directly. Every success response must carry `requestId`,
 * and expose the DFR internal execution identifier via `transactionId` (build/simulate/broadcast);
 * confirm is located by the path hash, so the envelope does not repeat transactionId.
 */
export interface BuildTransactionResponse {
  /** DFR internal execution identifier txn_<ULID>, separate from the on-chain txHash. */
  transactionId: TransactionId;
  unsignedTransaction: UnsignedTransaction;
  requestId: RequestId;
}

/**
 * Success response for `POST /v1/transactions/preflight` (ADR-037 option B).
 *
 * `unsignedTransaction` is a **preview**: it is built on a read-only pending nonce, with no lease protection,
 * so it **must not be used for signing or broadcast**. A real submission must go through build → simulate → sign → broadcast.
 *
 * `observedNonce` is the pending nonce **not** occupied by this preflight, for display only.
 */
export interface PreflightTransactionResponse {
  unsignedTransaction: UnsignedTransaction;
  /** Read-only simulation result; a revert is expressed as `success=false`, not thrown (same as simulate). */
  simulation: SimulationResult;
  observedNonce?: DecimalUint;
  requestId: RequestId;
}

/**
 * Success response for `POST /v1/transactions/{transactionId}/abandon` (ADR-037 option A).
 *
 * `leaseReleased` says whether **this** call actually released the nonce lease; it is `false` on an idempotent replay.
 */
export interface AbandonTransactionResponse {
  transactionId: TransactionId;
  status: 'abandoned';
  leaseReleased: boolean;
  nonce?: DecimalUint;
  requestId: RequestId;
}

export interface SimulateTransactionResponse {
  transactionId: TransactionId;
  simulation: SimulationResult;
  requestId: RequestId;
}

/**
 * HTTP request body for simulate (DFR-M1-B08; see m1-api-contract section 2).
 *
 * Must carry the `transactionId` and `UnsignedTransaction` returned by build: the server uses them to locate
 * the saved record and run a byte-for-byte binding check. It does **not** accept "bringing another payload that disagrees with the record".
 */
export interface SimulateTransactionRequest {
  transactionId: TransactionId;
  unsignedTransaction: UnsignedTransaction;
}

export interface BroadcastTransactionResponse {
  transactionId: TransactionId;
  broadcast: BroadcastTransactionOutcome;
  requestId: RequestId;
}

/**
 * Broadcast result inside the broadcast success envelope (DFR-M1-E03 contract fix).
 *
 * Why not `BroadcastResult`: `BroadcastResult` is the return type of the **Adapter capability**
 * (carrying `ref` and `providerId`). The HTTP response exposes the **TransactionEngine's public result**,
 * which deliberately does not return `providerId` (Provider identity is an internal implementation detail), and puts `txHash` directly at the top level
 * — the confirm endpoint's path parameter is `txHash`, so the caller can continue confirming from the response without unwrapping another `ref`.
 *
 * This type must match `BroadcastTransactionResult` in `@dfr/transaction`; the Gateway handler
 * annotates the response body with this type, so a mismatch fails `pnpm typecheck` directly (see handlers/write.ts).
 * Before the fix, OpenAPI/SDK declared `BroadcastResult`, which had drifted from the implementation with no test coverage (found in E03).
 */
export interface BroadcastTransactionOutcome {
  transactionId: TransactionId;
  status: TransactionStatus;
  /** On-chain transaction hash; falls back to the signed expectedHash even when the broadcast receipt is abnormal. */
  txHash: string;
  accepted: boolean;
  /** Only true on an explicit rebroadcast (dropped→broadcast back edge). */
  rebroadcast?: boolean;
  observedAt: Iso8601;
}

export interface ConfirmTransactionResponse {
  confirmation: ConfirmationResult;
  requestId: RequestId;
}

/** Internal error wrapper; the HTTP layer converts it into a DfrErrorResponse. */
export interface DfrErrorEnvelope {
  error: DfrError;
  status: number;
  instance?: string;
}

/* ------------------------------ Usage ------------------------------ */

/** Rate-limit / usage buckets. Mirrors the Gateway's route classes. */
export type UsageRouteClass = 'read' | 'write' | 'stream';

export interface UsageRateLimit {
  /** Bucket capacity (burst). */
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface UsageLimits {
  /** The effective token buckets of this deployment. */
  readonly rateLimits: Readonly<Record<UsageRouteClass, UsageRateLimit>>;
  /** The authenticated Key's scope (never includes secret material). */
  readonly scope: {
    readonly chains: readonly ChainId[] | '*';
    readonly capabilities: readonly CapabilityId[] | '*';
    readonly allowWrite: boolean;
  };
}

/**
 * Response of `GET /v1/usage` (developer-product task 03).
 *
 * Semantics that are deliberately explicit:
 * - Counts are **per Gateway process** and reset on restart; this is not a billing ledger;
 * - Only authenticated, route-matched API calls are counted;
 * - The `/v1/usage` call itself is excluded, so polling does not inflate the numbers;
 * - Operational endpoints (`/healthz`, `/readyz`, `/metrics`) are never counted.
 */
export interface UsageResponse {
  readonly projectId: string;
  readonly period: { readonly start: Iso8601; readonly end: Iso8601 };
  readonly requests: {
    readonly total: number;
    readonly byRouteClass: Partial<Record<UsageRouteClass, number>>;
    readonly byStatusClass: Partial<Record<'success' | 'clientError' | 'serverError', number>>;
    /** Bounded route handler ids, never raw paths. */
    readonly byRoute: Readonly<Record<string, number>>;
    /** Chains observed; labels collapse to `other` past the meter's bound. */
    readonly byChain: Readonly<Record<string, number>>;
    readonly byCapability: Readonly<Record<string, number>>;
    readonly byErrorCode: Readonly<Record<string, number>>;
  };
  /** Last authenticated API call, absent when the project has no traffic yet. */
  readonly lastRequestAt?: Iso8601;
  readonly limits: UsageLimits;
  readonly requestId: RequestId;
}
