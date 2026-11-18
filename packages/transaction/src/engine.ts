/**
 * TransactionEngine — build-phase orchestration (DFR-M1-B04).
 *
 * Authoritative sources: docs/architecture/development-plan.md sections 4.3/4.4,
 * docs/architecture/transaction-lifecycle.md section 8,
 * docs/architecture/m1-api-contract.md section 2.
 *
 * Responsibilities (orchestration only — no chain semantics, no database drivers):
 *
 * ```text
 * Idempotent begin ─► read on-chain pending nonce ─► NonceStore.reserve ─► chain build (explicit nonce)
 *                                                   │
 *                                   failure ───────────┴─► safely release the unsigned lease → rethrow the original error
 *                                   success ─► TransactionStore.create(status='built')
 *                                        ─► idempotent complete (persist transactionId)
 * ```
 *
 * Dependency direction (AGENTS.md section 3): this package only depends on `@dfr/types` and `@dfr/errors`.
 * Chain access therefore arrives through the **port** `TransactionChainPort`, implemented by the composition root
 * (Gateway main) with a concrete Adapter; this package does not import Adapter / Provider / Core / Storage.
 *
 * M1 boundaries:
 * - nonces are always allocated by the server and persisted as a lease; a request carrying its own `nonce` is rejected outright (fail-closed),
 *   so callers cannot bypass the lease and double-spend the same nonce. The Adapter's "explicit nonce" exists for this engine;
 * - `signedPayload` does not belong to this phase, and the record has no such field;
 * - build has no on-chain side effects, so the idempotency key is optional (gateway-spec section 7.1).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDfrError, isDfrError, newRequestId } from '@dfr/errors';
import type {
  AccountRef,
  BroadcastOptions,
  BroadcastResult,
  ChainId,
  ConfirmationResult,
  DecimalUint,
  FinalityLevel,
  Iso8601,
  RequestId,
  SignedTransaction,
  SimulationResult,
  SequencingToken,
  TransactionId,
  TransactionRequest,
  TransactionStatus,
  UnsignedTransaction,
} from '@dfr/types';
import { ConfirmationTracker } from './tracker.js';
import type { ConfirmationTrackResult } from './tracker.js';
import type { TransactionMetricsSink, TransactionStage } from './metrics.js';
import {
  observeStores,
  tagStoreName,
  withStoreCallContext,
  type StoreCallSink,
} from './store-call.js';
import { classifyBroadcastFailure, resolveUnknownOutcome } from './broadcast-outcome.js';
import type { ChainBroadcastObservation } from './broadcast-outcome.js';
import { transition, type TransactionEvent } from './state-machine.js';
import type {
  IdempotencyScope,
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLeaseStore,
  TransactionRecord,
  TransactionStore,
  TransitionPatch,
} from './stores.js';

/* ================================================================== */
 /* Port: chain access                                                       */
/* ================================================================== */

export interface GetPendingNonceInput {
  readonly chain: ChainId;
  readonly account: AccountRef;
  /**
    * The request ID tying errors to the audit trail (passed through by the engine since DFR-M1-B07).
    * Port implementations must carry it into `AdapterContext.requestId`; never hide the call source behind a random value.
   */
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

export interface ChainBuildInput {
  /**
    * Carries the ordering precondition the engine **allocated and persisted as a lease** (ADR-033): the EVM path injects `nonce`,
    * the Solana path injects `recentBlockhash`. Adapters must use it verbatim and never query one themselves,
    * or the lease and the payload will disagree.
   */
  readonly request: TransactionRequest;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

export interface ChainSimulateInput {
  readonly transactionId: TransactionId;
  readonly unsigned: UnsignedTransaction;
  /**
    * The sender in the record.
   *
    * `UnsignedTransaction` itself **contains no** sender (see the B03 delivery report), while EVM
    * `eth_call` needs `from` to cover balance / allowance / nonce checks. The engine knows this fact,
    * so it passes it explicitly to the port; how exactly it is used is up to the implementer (composition root + Adapter).
   */
  readonly from: AccountRef;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

/**
 * The chain-access port (implemented by the composition root).
 *
 * It exposes only the two actions the build phase needs: reading the pending nonce and constructing the unsigned payload.
 * Both calls must land on the **same** Provider handle on the same chain; that constraint is guaranteed by the implementer (Adapter).
 */
/**
 * Broadcast port input (DFR-M1-C03a).
 *
 * `expected` is the **record's ground truth**: `SignedTransaction` contains no sender, and the unsigned payload
 * the client sends back is only an echo. The Adapter must compare it item by item against the signed payload (`bindSignedTransaction`),
 * otherwise "same transactionId, different account/parameters" cannot be detected.
 */
export interface ChainBroadcastInput {
  readonly signed: SignedTransaction;
  readonly expected: {
    readonly from: AccountRef;
    readonly unsignedPayload: string;
  };
  readonly options?: BroadcastOptions;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

/** B43: verify a PERSISTED sequencing reference's validity before any send.
 * The adapter owns block-height semantics; Transaction only routes this port.
 * Caller must supply the Store's original token, never a client echo.
 */
export interface ChainSequencingExpiryInput {
  readonly chain: ChainId;
  readonly token: SequencingToken;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

export interface TransactionChainPort {
   /** EVM nonce path (preferred when present, preserving M1 behavior). */
  getPendingNonce?(input: GetPendingNonceInput): Promise<DecimalUint>;
  /**
    * Chain-agnostic ordering precondition (ADR-033): EVM returns a nonce, Solana returns a blockhash.
    * The engine picks by "which path this chain uses": `getPendingNonce` if present, otherwise this method.
   */
  getSequencingToken?(input: GetPendingNonceInput): Promise<SequencingToken>;
  /** Mandatory pre-broadcast validity check for Store-persisted blockhash tokens. */
  isSequencingExpired?(input: ChainSequencingExpiryInput): Promise<boolean>;
  /**
    * Inject the ordering precondition allocated by the engine into the request (ADR-033). Required on the sequencing path:
    * Solana's build must use the blockhash the Store has already leased, or the lease and the payload will disagree.
   */
  withSequencingToken?(request: TransactionRequest, token: SequencingToken): TransactionRequest;
  build(input: ChainBuildInput): Promise<UnsignedTransaction>;
   /** Read-only simulation (no side effects). A revert is expressed as `SimulationResult.success=false`, not thrown. */
  simulate(input: ChainSimulateInput): Promise<SimulationResult>;
  /**
    * Single broadcast (DFR-M1-C03a).
   *
    * Optional: a deployment without a broadcast implementation fails closed at runtime (`DFR_UNSUPPORTED_CAPABILITY`),
    * instead of silently skipping. The implementer (composition root) is responsible for wiring it to the Adapter's
    * `broadcast()` and the signature-binding check.
   */
  broadcast?(input: ChainBroadcastInput): Promise<BroadcastResult>;

  /**
    * Observe where a transaction really stands on-chain (DFR-M1-C03b, ADR-019).
   *
    * Called only when a broadcast result is indeterminate. **Optional**: without it the engine stays `unknown`
    * (fail-closed: it neither pretends dropped nor pretends failed).
   *
    * The implementer (composition root + Adapter) queries by expectedHash and, when nothing is found,
    * compares the account's on-chain nonce to distinguish `replaced` from `absent`.
   */
  observe?(input: ChainObserveInput): Promise<ChainBroadcastObservation>;

   /** A single read-only confirmation observation; state decisions come from Core/Registry, waiting and leases are Transaction's job. */
  confirm?(input: ChainConfirmInput): Promise<ConfirmationResult>;
}

export interface ChainConfirmInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly minFinality?: FinalityLevel;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
  readonly background?: boolean;
}

/** Observation input: all from the record (expectedHash / from / nonce), never from caller claims. */
export interface ChainObserveInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly from: AccountRef;
  readonly nonce: DecimalUint;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal: AbortSignal;
}

/* ================================================================== */
 /* Dependencies and result types                                             */
/* ================================================================== */

export interface TransactionEngineStores {
  readonly transaction: TransactionStore;
  readonly idempotency: IdempotencyStore;
  readonly nonce: NonceStore;
   /** M3-B03: Solana's blockhash ordering lease; required on the sequencing path. */
  readonly sequencing?: SequencingStore;
   /** D02 tracker lease; confirm must fail closed when it is missing. */
  readonly tracker?: TrackerLeaseStore;
}

export interface ConfirmTransactionInput {
  readonly chain: ChainId;
  readonly txHash: string;
  readonly minFinality?: FinalityLevel;
  readonly timeoutMs?: number;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
}

export interface TransactionEngineDeps {
  readonly stores: TransactionEngineStores;
  readonly chain: TransactionChainPort;
   /** Injected clock (test determinism); defaults to `() => new Date().toISOString()`. */
  readonly now?: () => Iso8601;
   /** Injected transaction ID generator; defaults to `txn_<32 hex>`. */
  readonly newTransactionId?: () => TransactionId;
   /** Idempotent execution-right owner token generator; defaults to a random 16-byte hex. */
  readonly newOwnerToken?: () => string;
  /**
    * Request fingerprint. Defaults to `fingerprintBuildRequest`.
   *
    * m1-api-contract section 4 requires "exactly one canonicalization implementation": the Gateway must
    * reuse this function (or inject the same implementation), never write a second copy.
   */
  readonly fingerprint?: (request: TransactionRequest) => string;
   /** Idempotent in-flight lease duration; defaults to 30s. */
  readonly idempotencyLeaseTtlMs?: number;
   /** Nonce lease duration; defaults to 5 minutes. */
  readonly nonceLeaseTtlMs?: number;
   /** Clock injection point for the confirmation wait; production uses Date.now/setTimeout. */
  readonly confirmationClock?: () => number;
  readonly confirmationSleep?: (ms: number) => Promise<void>;
  readonly metrics?: TransactionMetricsSink;
  /**
    * Store-call observation outlet (observability-spec chapter 4, `store.read` / `store.write`).
    * Like metrics, an optional sink; zero overhead when not injected. Observation failures never affect the business path.
   */
  readonly onStoreCall?: StoreCallSink;
  /**
    * State-transition event outlet (transaction-lifecycle chapter 6: "every state change must emit an event").
   *
    * Same convention as `onStoreCall`: an optional sink, zero overhead when not injected, and **thrown errors are swallowed** —
    * a failed event delivery must never change the business outcome (consistent with "observation failures must not affect the observed path").
   *
    * Why a callback instead of letting the engine depend on `@dfr/events`: module boundaries require this package to depend only on leaf utility packages
    * (types/errors/metrics). The engine knows nothing about the bus; the composition root wires it to the bus
    * and allocates the cursor (a cursor belongs to the **subscription scope** — a bus-side concept).
   */
  readonly onTransition?: TransitionEventSink;
  /**
    * How long `unknown` must stay silent before it may be judged `dropped` (ADR-023). Defaults to 30 minutes.
   *
    * Only "observed `absent` **and** silent longer than this duration" counts as dropped; either condition alone is not enough.
   */
  readonly dropTimeoutMs?: number;
  /**
    * Clock (milliseconds) for the timeout decision. Defaults to `Date.now`.
   *
    * Kept separate from `now` (which timestamps record writes): tests need "record time fixed, current time advancable" to
    * verify timeout semantics; in production both are real clocks.
   */
  readonly dropClock?: () => number;
}

/**
 * One committed state transition (engine → sink).
 *
 * Emitted only after the Store confirms the write ("publish only after the transaction commits"), so subscribers always see
 * persisted facts — never "the event says it changed but the database didn't".
 */
export interface TransitionEventRecord {
  readonly transactionId: TransactionId;
  readonly chain: ChainId;
  readonly fromStatus: TransactionStatus;
  readonly toStatus: TransactionStatus;
  readonly stateVersion: DecimalUint;
  readonly requestId: RequestId;
  readonly txHash?: string;
}

export type TransitionEventSink = (record: TransitionEventRecord) => void;

/**
 * Preflight request (ADR-037, option B).
 *
 * Difference from `build`: **no nonce taken, no store write, no persistent side effects at all**.
 * It answers "can this transaction roughly go through, and how much gas will it need?" — while the current `simulate` requires a
 * `transactionId` first (i.e. it requires a build), forcing callers to use `build` for preflight,
 * burning one on-chain nonce per preflight; repeated preflights leave permanent gaps (ADR-037 background).
 */
/**
 * Explicitly void an **unbroadcast** transaction (ADR-037, option A).
 *
 * Why: build immediately occupies an on-chain nonce; if the caller decides not to submit the transaction,
 * there must be a correct cleanup action, or the nonce stays occupied forever and a permanent gap forms on-chain.
 */
export interface AbandonTransactionInput {
  readonly transactionId: TransactionId;
  /** Gateway identity, if provided, must own this persisted transaction. */
  readonly requesterProjectId?: string;
  /** Chain scope granted to the invoking API Key (not a client body claim). */
  readonly authorizedChains?: readonly ChainId[] | '*';
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface AbandonTransactionResult {
  readonly transactionId: TransactionId;
  readonly status: 'abandoned';
   /** Whether the nonce lease was actually released this time (false on idempotent replay). */
  readonly leaseReleased: boolean;
  readonly nonce?: DecimalUint;
}

export interface PreflightTransactionInput {
  readonly request: TransactionRequest;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
  /**
    * Freshness cap (milliseconds) for the preflight result. Omit to use the port default.
   *
    * Same **read-only** semantics as `simulate`: `eth_call`/`eth_estimateGas` run against the pending block,
    * and the result is not a promise — on-chain state may change before the next call.
   */
  readonly estimateTimeoutMs?: number;
}

export interface PreflightTransactionResult {
  /**
    * The unsigned payload that was constructed.
   *
    * **Preview only**: it was constructed on a **read-only** pending nonce with no lease protection,
    * so it **must not be used for signing or broadcast** (concurrent builds may get the same nonce).
    * To actually submit, go through `build` → `simulate` → sign → `broadcast`.
   *
    * `undefined` means **it reverted during the gas-estimation phase** (there is no passable payload to preview).
    * This is the honest answer: it does not fabricate a payload that is doomed to fail and has incomplete fields.
   */
  readonly unsignedTransaction?: UnsignedTransaction;
   /** Read-only simulation result; a revert is expressed as `success=false`, never thrown (same as simulate). */
  readonly simulation: SimulationResult;
   /** The pending nonce this preflight **did not** occupy, shown for display only; callers must not sign from it. */
  readonly observedNonce?: DecimalUint;
  readonly requestId: RequestId;
}

export interface BuildTransactionInput {
  readonly request: TransactionRequest;
   /** Optional: build has no side effects (gateway-spec section 7.1). */
  readonly idempotencyKey?: string;
   /** M1 fixes this to `default`; a multi-tenant control plane belongs to M5. */
  readonly projectId?: string;
   /** Used to tie errors to the audit trail; auto-generated when omitted. */
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
}

export interface BuiltTransactionResult {
  readonly transactionId: TransactionId;
   /** The record's **current** lifecycle state; `built` on the first build, possibly a later state on replay. */
  readonly status: TransactionStatus;
   /** The EVM ordering precondition; undefined for Solana (which uses `sequencingToken`). */
  readonly nonce?: DecimalUint;
   /** Chain-agnostic ordering precondition (ADR-033): EVM={kind:nonce}, Solana={kind:blockhash}. */
  readonly sequencingToken?: SequencingToken;
  readonly unsignedTransaction: UnsignedTransaction;
   /** true = an idempotent record was hit; nothing re-executed, no new nonce consumed. */
  readonly replayed: boolean;
  /**
    * false = this result will not be replayed: no idempotency key was supplied, or this call lost the idempotent write right.
    * Callers use this to decide "whether it is safe to retry the same request".
   */
  readonly replayable: boolean;
}

export interface SimulateTransactionInput {
  readonly transactionId: TransactionId;
  /**
    * The unsigned payload returned by build.
   *
    * M1 does not accept "bringing a different payload": it must match the persisted record byte for byte, otherwise it is rejected
    * (m1-api-contract section 2: "unsigned payloads inconsistent with the saved build fingerprint are not accepted").
   */
  readonly unsignedTransaction: UnsignedTransaction;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
}

export interface SimulatedTransactionResult {
  readonly transactionId: TransactionId;
   /** The record's **current** lifecycle state: `simulated` (success), or the caller catches a `reverted` error. */
  readonly status: TransactionStatus;
  readonly simulation: SimulationResult;
}

/* ================================================================== */
 /* Normalized fingerprint                                                 */
/* ================================================================== */

/** Encode canonical JSON directly: object reconstruction reorders integer-like keys. */
function canonicalize(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry) ?? 'null').join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => {
        const encoded = canonicalize(entry);
        return encoded === undefined ? null : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter((entry): entry is string => entry !== null);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The canonical fingerprint of a `TransactionRequest` (SHA-256, hex).
 *
 * Excludes header / requestId / traceId: changing User-Agent must not count as a conflict
 * (gateway-spec section 7.2). Amounts are still decimal strings, so the fingerprint is stable.
 */
export function fingerprintBuildRequest(request: TransactionRequest): string {
  const encoded = canonicalize(request);
  if (encoded === undefined) throw new TypeError('Cannot fingerprint non-JSON input');
  return createHash('sha256').update(encoded).digest('hex');
}

/* ================================================================== */
 /* Engine                                                               */
/* ================================================================== */

const DEFAULT_IDEMPOTENCY_LEASE_TTL_MS = 30_000;
const DEFAULT_NONCE_LEASE_TTL_MS = 5 * 60_000;
/** ADR-023: only judge `dropped` after unknown has stayed silent longer than this (and the observation is absent). */
const DEFAULT_DROP_TIMEOUT_MS = 30 * 60_000;

/** CAS retry cap for state transitions: a conflict means a concurrent writer exists; re-read and re-derive. */
const MAX_TRANSITION_ATTEMPTS = 3;

function traceContext(input: { readonly traceId?: string; readonly spanId?: string }): {
  traceId?: string;
  spanId?: string;
} {
  return {
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
  };
}

/** States that allow simulate: only before signing (transaction-lifecycle section 4.2). */
const SIMULATABLE_STATUSES: readonly TransactionStatus[] = ['built', 'simulated'];

type ScopedTransactionRequest = {
  /** Trusted gateway scope, never derived from client payload. */
  readonly requesterProjectId?: string;
  readonly authorizedChains?: readonly ChainId[] | '*';
};

export interface BroadcastTransactionInput extends ScopedTransactionRequest {
  readonly transactionId: TransactionId;
  /**
    * The signature result sent back by the client.
   *
    * `signed.unsigned.payload` is only an echo: the engine compares it against the **record's** unsigned payload,
    * rejects on any mismatch, and never lets "the client says it matches" pass.
   */
  readonly signed: SignedTransaction;
   /** `rebroadcast` is controlled by the state machine and the HTTP layer; the engine only passes it through. */
  readonly options?: BroadcastOptions;
  readonly requestId?: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly signal?: AbortSignal;
}

export interface BroadcastTransactionResult {
  readonly transactionId: TransactionId;
   /** The record state after a successful broadcast, fixed to `broadcast`. */
  readonly status: TransactionStatus;
  readonly txHash: string;
  readonly accepted: boolean;
  readonly rebroadcast?: boolean;
  readonly observedAt: Iso8601;
}

/* ================================================================== */
 /* Engine                                                               */
/* ================================================================== */

export class TransactionEngine {
  private readonly deps: TransactionEngineDeps;
  private readonly fingerprint: (request: TransactionRequest) => string;
  private readonly confirmationTracker?: ConfirmationTracker;

   /** The Store port wrapped for observation; all internal calls go through here (see store-call.ts). */
  private readonly stores: TransactionEngineStores;

  constructor(deps: TransactionEngineDeps) {
    this.deps = deps;
     // Port-layer wrapping: a single implementation, so structurally no call site can be missed.
    const sink = deps.onStoreCall;
    const tagged: TransactionEngineStores = {
      transaction: tagStoreName(deps.stores.transaction, 'transaction'),
      idempotency: tagStoreName(deps.stores.idempotency, 'idempotency'),
      nonce: tagStoreName(deps.stores.nonce, 'nonce'),
      ...(deps.stores.sequencing !== undefined
        ? { sequencing: tagStoreName(deps.stores.sequencing, 'sequencing') }
        : {}),
      ...(deps.stores.tracker !== undefined
        ? { tracker: tagStoreName(deps.stores.tracker, 'tracker') }
        : {}),
    };
    this.stores = {
      transaction: observeStores(tagged.transaction, sink),
      idempotency: observeStores(tagged.idempotency, sink),
      nonce: observeStores(tagged.nonce, sink),
      ...(tagged.sequencing !== undefined
        ? { sequencing: observeStores(tagged.sequencing, sink) }
        : {}),
      ...(tagged.tracker !== undefined ? { tracker: observeStores(tagged.tracker, sink) } : {}),
    };
    this.fingerprint = deps.fingerprint ?? fingerprintBuildRequest;
    if (this.stores.tracker !== undefined && deps.chain.confirm !== undefined) {
      this.confirmationTracker = new ConfirmationTracker({
         // Pass in the **wrapped** port: Store calls on the confirm path are observed the same way.
        leases: this.stores.tracker,
        transactions: this.stores.transaction,
        observe: async (input) => {
          const confirmation = await deps.chain.confirm!({
            chain: input.chain,
            txHash: input.txHash,
            ...(input.required !== undefined ? { minFinality: input.required } : {}),
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
            ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
            ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
            ...(input.signal !== undefined ? { signal: input.signal } : { signal: new AbortController().signal }),
          });
          return {
            observed: confirmation.finality,
            reached: confirmation.reached,
            confirmation,
          };
        },
        ownerToken: () => this.newOwnerToken(),
        ...(deps.confirmationClock !== undefined ? { now: deps.confirmationClock } : {}),
        ...(deps.confirmationSleep !== undefined ? { sleep: deps.confirmationSleep } : {}),
      });
    }
  }

   /** Build an unsigned transaction and persist it as `built` (B04). No signing, no broadcast. */
  async build(input: BuildTransactionInput): Promise<BuiltTransactionResult> {
     // Set up the in-process request context: Store calls within it automatically carry requestId/trace/span.
    return this.measure(input.request.chain, 'build', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.buildInternal(input),
      ),
    );
  }

  /**
    * Explicitly void an unbroadcast transaction (ADR-037, option A). **Idempotent**: calling again after `abandoned` returns 200.
   *
    * Safe order (B37): **first CAS-transition to the terminal state on state+version, then release the lease**.
    * If a concurrent signer wins the CAS, a manual void must not release a nonce that may still land on-chain;
    * if the later release fails temporarily, the lease stays reserved, but B34's TTL cleanup only reclaims
    * abandoned transactions without expected_hash/tx_hash, so a signed nonce is never released by mistake.
   */
  async abandon(input: AbandonTransactionInput): Promise<AbandonTransactionResult> {
    const requestId = input.requestId ?? newRequestId();
    const record = await this.stores.transaction.get(input.transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_TRANSACTION_NOT_FOUND',
        requestId,
        undefined,
         `Unknown transaction ${input.transactionId}`,
        { transactionId: input.transactionId },
      );
    }

    // AUTH-03: DELETE carries only transactionId. Resolve the authoritative
    // chain and project from the persisted record before any release, idempotent
    // response, or state transition. Never trust a caller-supplied chain here.
    if (
      (input.requesterProjectId !== undefined && record.projectId !== input.requesterProjectId) ||
      (input.authorizedChains !== undefined && input.authorizedChains !== '*' &&
       !input.authorizedChains.includes(record.chain))
    ) {
      throw this.fail(
        'DFR_PROJECT_SCOPE_DENIED',
        requestId,
        undefined,
         'No permission to access this transaction',
      );
    }

     // Idempotent: if already voided, return directly — no repeated release, no repeated transition.
    if (record.status === 'abandoned') {
      return {
        transactionId: record.transactionId,
        status: 'abandoned',
        leaseReleased: false,
        ...(record.nonce !== undefined ? { nonce: record.nonce } : {}),
      };
    }

    if (record.status !== 'built' && record.status !== 'simulated') {
      throw this.fail(
        'DFR_TRANSACTION_REJECTED',
        requestId,
        record.chain,
         `Transaction is in state ${record.status}, which does not allow voiding (only built / simulated)`,
        { reason: 'not_abandonable', fields: ['status'], status: record.status },
      );
    }

    // 1) CAS first: a different worker may have signed after our initial
    // read. Never release its live nonce on a stale built/simulated snapshot.
    // Retry-on-conflict is handled by applyTransition: once already signed,
    // abandoned is not an allowed edge and the request fails closed.
    const applied = await this.applyTransition(record, 'abandon', requestId);

    // 2) Post-CAS cleanup is best effort; terminal abandoned is durable.
    // B34 TTL orphan cleanup reclaims only hash-free abandoned transactions.
    let leaseReleased = false;
    if (record.nonce !== undefined) {
      try {
        const released = await this.stores.nonce.releaseIfSafe({
          chain: record.chain,
          account: record.from,
          nonce: record.nonce,
          transactionId: record.transactionId,
        });
        leaseReleased = released.kind === 'released';
      } catch {
         // A failed release must not hide the main flow: the record must still reach the terminal state; the lease is cleaned up by the patrol/restart fallback.
        leaseReleased = false;
      }
    } else if (record.sequencingRef !== undefined && this.stores.sequencing !== undefined) {
      try {
        const released = await this.stores.sequencing.releaseIfSafe({
          chain: record.chain,
          account: record.from,
          transactionId: record.transactionId,
          tokenValue: record.sequencingRef.value,
        });
        leaseReleased = released.kind === 'released';
      } catch {
        leaseReleased = false;
      }
    }

    return {
      transactionId: applied.transactionId,
      status: 'abandoned',
      leaseReleased,
      ...(record.nonce !== undefined ? { nonce: record.nonce } : {}),
    };
  }

  /**
    * Preflight: read-only answer to "can this transaction go through" (ADR-037, option B). **No nonce taken, nothing persisted.**
   *
    * The key differences from `build` (and the reason it exists):
    *   - **no** `nonce.reserve`, **no** `transaction.create`, **no** writes to the idempotency table;
    *   - the pending nonce is read **read-only**, only to construct the preview payload and simulate the `from` check;
    *   - so it is safe to call repeatedly — exactly what callers used to do with `build`.
   *
    * `simulate` requires a `transactionId` first, and `transactionId` only comes from `build`;
    * before preflight existed, "preflight" could only be done via build, burning one nonce per call (the cause ADR-037 measured).
   */
  async preflight(input: PreflightTransactionInput): Promise<PreflightTransactionResult> {
    return this.measure(input.request.chain, 'preflight', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.preflightInternal(input),
      ),
    );
  }

  private async preflightInternal(input: PreflightTransactionInput): Promise<PreflightTransactionResult> {
    const { request } = input;
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const signal = input.signal ?? new AbortController().signal;

    if (request.nonce !== undefined) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        request.chain,
         'preflight does not accept a caller-supplied nonce; it reads the pending nonce read-only for the preview',
        { fields: ['nonce'] },
      );
    }

    const port = this.deps.chain;

     // Only read the ordering precondition. **Never reuse build's reserve path** — that is exactly the side effect this method removes.
    let pendingToken: SequencingToken;
    if (typeof port.getSequencingToken === 'function') {
      pendingToken = await port.getSequencingToken({
        chain: request.chain,
        account: request.from,
        requestId,
        ...trace,
        signal,
      });
    } else if (typeof port.getPendingNonce === 'function') {
      pendingToken = {
        kind: 'nonce',
        value: await port.getPendingNonce({
          chain: request.chain,
          account: request.from,
          requestId,
          ...trace,
          signal,
        }),
      };
    } else {
      throw this.fail(
        'DFR_UNSUPPORTED_CAPABILITY',
        requestId,
        request.chain,
         'This chain has neither an ordering-precondition read nor a nonce read, so preflight is impossible',
        { capability: 'transaction.build', reason: 'method_missing' },
      );
    }

    let adapterRequest: TransactionRequest;
    let observedNonce: DecimalUint | undefined;
    if (pendingToken.kind === 'nonce') {
      observedNonce = pendingToken.value;
      adapterRequest = { ...request, nonce: pendingToken.value };
    } else {
       // Solana: injecting the blockhash only makes the payload constructible; no lease is persisted, so it is unrelated to build's strict consistency requirement.
      adapterRequest =
        typeof port.withSequencingToken === 'function'
          ? port.withSequencingToken(request, pendingToken)
          : { ...request, recentBlockhash: pendingToken.value };
    }

    let unsigned: UnsignedTransaction;
    try {
      unsigned = await port.build({ request: adapterRequest, requestId, ...trace, signal });
    } catch (err) {
       // ⚠️ This is a **real** semantic point (caught in the 2026-10-07 live-chain integration test):
       // `build` derives gas with `eth_estimateGas`, and a transaction doomed to revert reverts **during the estimation phase**,
       // so build throws `DFR_TRANSACTION_REVERTED` —
       // and preflight never reaches simulate; the caller gets a 422 instead of "failure information".
      //
       // But the value of preflight is **precisely** to return failures as information (otherwise callers go back to "trying with build",
       // which is exactly the cause ADR-037 eliminates). So here an "expected execution revert" is converted into
       // a `simulation.success=false` 200 response, consistent with this method's documentation.
      //
       // Only **execution reverts** are swallowed here: provider unavailable, insufficient balance, config errors, and the like are still rethrown —
       // error-spec chapter 5.2: when the classification is uncertain, never downgrade and never guess.
      if (!(isDfrError(err) && err.code === 'DFR_TRANSACTION_REVERTED')) throw err;
      return {
         // Explicitly **do not return** an unsignedTransaction (there is no passable payload to preview when it reverts).
        simulation: {
          success: false,
          ...(typeof err.details?.['revertReason'] === 'string'
            ? { revertReason: err.details['revertReason'] }
            : {}),
           warnings: ['preflight reverted during the gas-estimation phase; no preview payload was generated'],
        },
        ...(observedNonce !== undefined ? { observedNonce } : {}),
        requestId,
      };
    }

     // Read-only simulation. A revert is expressed as success=false (same as simulate), not converted into an exception.
    const simulation = await port.simulate({
      transactionId: `txn_preflight` as TransactionId,
      unsigned,
      from: request.from,
      requestId,
      ...trace,
      signal,
    });

    return {
      unsignedTransaction: unsigned,
      simulation,
      ...(observedNonce !== undefined ? { observedNonce } : {}),
      requestId,
    };
  }

  private async buildInternal(input: BuildTransactionInput): Promise<BuiltTransactionResult> {
    const { request } = input;
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const projectId = input.projectId ?? 'default';
    const signal = input.signal ?? new AbortController().signal;

    if (request.nonce !== undefined) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        request.chain,
         'In M1, nonces are allocated by the server and persisted as a lease; requests must not carry their own nonce',
        { fields: ['nonce'] },
      );
    }

    const fingerprint = this.fingerprint(request);
    const scope: IdempotencyScope | undefined =
      input.idempotencyKey === undefined
        ? undefined
        : { projectId, chain: request.chain, key: input.idempotencyKey };

    let ownerToken: string | undefined;
    if (scope !== undefined) {
      ownerToken = this.newOwnerToken();
      const began = await this.stores.idempotency.begin({
        scope,
        fingerprint,
        ownerToken,
        leaseTtlMs: this.deps.idempotencyLeaseTtlMs ?? DEFAULT_IDEMPOTENCY_LEASE_TTL_MS,
      });
      if (began.kind === 'conflict') {
        throw this.fail(
          'DFR_IDEMPOTENCY_CONFLICT',
          requestId,
          request.chain,
           'The same idempotency key was already used for a different request body',
          { idempotencyKey: scope.key },
        );
      }
      if (began.kind === 'in_flight') {
         // Concurrent duplicate requests: do not execute twice, or two nonces / two transactions would be created.
        throw this.fail(
          'DFR_IDEMPOTENCY_CONFLICT',
          requestId,
          request.chain,
           'A request with the same idempotency key is currently being processed',
          { idempotencyKey: scope.key, retryAfterMs: began.retryAfterMs },
        );
      }
      if (began.kind === 'replayed') {
        return await this.replay(began.record.transactionId, requestId, request.chain);
      }
    }

    const transactionId = this.newTransactionId();
    const leaseTtlMs = this.deps.nonceLeaseTtlMs ?? DEFAULT_NONCE_LEASE_TTL_MS;
    const port = this.deps.chain;

     // Ordering precondition (ADR-033). **Dispatch to the matching Store by the token's kind**, not by chain family —
     // so the engine never knows "which chain belongs to which family"; chain differences only pass through the Adapter.
    //
     // Entry points for fetching the token, in priority order:
     //   1. `getSequencingToken` (chain-agnostic; EVM returns a nonce / Solana returns a blockhash);
     //   2. fall back to `getPendingNonce` (the M1 EVM port only implements this one; backward compatible).
    let pendingToken: SequencingToken;
    if (typeof port.getSequencingToken === 'function') {
      pendingToken = await port.getSequencingToken({
        chain: request.chain,
        account: request.from,
        requestId,
        ...trace,
        signal,
      });
    } else if (typeof port.getPendingNonce === 'function') {
      pendingToken = {
        kind: 'nonce',
        value: await port.getPendingNonce({
          chain: request.chain,
          account: request.from,
          requestId,
          ...trace,
          signal,
        }),
      };
    } else {
      throw this.fail(
        'DFR_UNSUPPORTED_CAPABILITY',
        requestId,
        request.chain,
         'This chain has neither an ordering-precondition read nor a nonce read, so no ordering precondition can be allocated',
        { capability: 'transaction.build', reason: 'method_missing' },
      );
    }

    let nonce: DecimalUint | undefined;
    let sequencingToken: SequencingToken | undefined;
     // The request to pass to the Adapter: the nonce path injects a nonce, the sequencing path injects a blockhash.
    let adapterRequest: TransactionRequest;
    let reservedKind: 'reserved' | 'reused';

    if (pendingToken.kind === 'nonce') {
       // EVM path: exactly as in M1 (NonceStore + explicit nonce).
      const reserved = await this.stores.nonce.reserve({
        chain: request.chain,
        account: request.from,
        transactionId,
        chainPendingNonce: pendingToken.value,
        leaseTtlMs,
      });
      if (reserved.kind === 'conflict') {
        throw this.fail(
          'DFR_NONCE_CONFLICT',
          requestId,
          request.chain,
           `nonce ${reserved.lease.nonce} is already occupied by another transaction`,
          { nonce: reserved.lease.nonce },
        );
      }
      nonce = reserved.lease.nonce;
      reservedKind = reserved.kind;
      sequencingToken = { kind: 'nonce', value: nonce };
      adapterRequest = { ...request, nonce };
    } else {
       // Solana path: SequencingStore + a fixed blockhash. Any missing wiring fails closed.
      if (this.stores.sequencing === undefined) {
        throw this.fail(
          'DFR_CONFIGURATION_ERROR',
          requestId,
          request.chain,
           'This chain returns a blockhash ordering precondition but has no SequencingStore wired up',
          { capability: 'transaction.build' },
        );
      }
      if (typeof port.withSequencingToken !== 'function') {
        throw this.fail(
          'DFR_UNSUPPORTED_CAPABILITY',
          requestId,
          request.chain,
           'This chain has no ordering-precondition injection method; the lease and the payload cannot be kept consistent',
          { capability: 'transaction.build', reason: 'method_missing' },
        );
      }
      const reserved = await this.stores.sequencing.reserve({
        chain: request.chain,
        account: request.from,
        transactionId,
        token: pendingToken,
        leaseTtlMs,
      });
      sequencingToken = reserved.lease.token;
      reservedKind = reserved.kind;
       // Inject the **same** precondition the Store already leased, keeping "lease ↔ payload" consistent (ADR-033).
      adapterRequest = port.withSequencingToken(request, sequencingToken);
    }

    let unsigned: UnsignedTransaction;
    try {
      unsigned = await port.build({ request: adapterRequest, requestId, ...trace, signal });
    } catch (err) {
       // An unsigned, unbroadcast lease must be released, or it leaves a permanent gap (m1-storage-model §3.4).
       // A failed release must not hide the original error: the caller needs to see why build failed.
       // Carry the transactionId (ADR-030's proof of ownership): the nonce may have been reclaimed and bound to a new transaction,
       // and releasing without it could release someone else's lease.
      if (reservedKind === 'reserved') {
        await this.releaseQuietly(
          request.chain,
          request.from,
          transactionId,
          nonce,
          sequencingToken,
        );
      }
      throw err;
    }

    const built = transition({ from: null, event: 'build' });
    if (!built.ok) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        request.chain,
         'build edge does not exist (state machine disagrees with the spec)',
      );
    }
    const now = this.now();
    const created = await this.stores.transaction.create({
      record: {
        transactionId,
        projectId,
        chain: request.chain,
        requestFingerprint: fingerprint,
        status: built.status,
        stateVersion: '0' as DecimalUint,
        from: request.from,
        ...(request.to !== undefined ? { to: request.to } : {}),
        ...(nonce !== undefined ? { nonce } : {}),
        ...(sequencingToken !== undefined ? { sequencingRef: sequencingToken } : {}),
        unsignedPayload: unsigned.payload,
        payloadEncoding: unsigned.meta.encoding ?? 'hex',
        createdAt: now,
        updatedAt: now,
      },
      ...(scope !== undefined && ownerToken !== undefined
        ? { idempotencyClaim: { scope, ownerToken } }
        : {}),
    });
    if (created.kind === 'already_exists') {
       // A newly generated transactionId colliding with an existing record can only mean the ID generator is broken.
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        request.chain,
         `transactionId ${transactionId} already exists`,
      );
    }

    let replayable = scope !== undefined;
    if (scope !== undefined && ownerToken !== undefined) {
      const completed = await this.stores.idempotency.complete({
        scope,
        ownerToken,
        statusCode: 201,
        transactionId,
        responseBody: {
          transactionId,
          ...(nonce !== undefined ? { nonce } : {}),
        },
      });
       // Losing the write right means a concurrent executor took over: this result is still real (the record is persisted),
       // but it cannot be guaranteed to be replayable; mark it explicitly as non-replayable per gateway-spec section 7.2.
      if (completed.kind !== 'completed') replayable = false;
    }

    return {
      transactionId,
      status: created.record.status,
      ...(nonce !== undefined ? { nonce } : {}),
      ...(sequencingToken !== undefined ? { sequencingToken } : {}),
      unsignedTransaction: unsigned,
      replayed: false,
      replayable,
    };
  }

   /** Bounded synchronous wait; after a timeout, start a background read-only confirmation loop that does not depend on the HTTP AbortSignal. */
  async confirm(input: ConfirmTransactionInput): Promise<ConfirmationResult> {
    return this.measure(input.chain, 'confirm', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.confirmInternal(input),
      ),
    );
  }

  private async confirmInternal(input: ConfirmTransactionInput): Promise<ConfirmationResult> {
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const timeoutMs = input.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
       throw this.fail('DFR_VALIDATION_FAILED', requestId, input.chain, 'timeoutMs must be within 1000..600000');
    }
    if (this.confirmationTracker === undefined) {
       throw this.fail('DFR_UNSUPPORTED_CAPABILITY', requestId, input.chain, 'No confirmation-observation port or tracker lease store is wired up');
    }
    const signal = input.signal ?? new AbortController().signal;
    const tracked: ConfirmationTrackResult = await this.confirmationTracker.trackUntil({
      chain: input.chain,
      txHash: input.txHash,
      ...(input.minFinality !== undefined ? { required: input.minFinality } : {}),
    requestId,
    ...trace,
    timeoutMs,
      signal,
    });
    const confirmation = tracked.owner && tracked.confirmation !== undefined
      ? tracked.confirmation
      : {
          ref: { kind: 'hash' as const, hash: input.txHash },
          status: 'pending' as const,
          finality: 'unknown' as const,
          ...(input.minFinality !== undefined ? { requiredFinality: input.minFinality } : {}),
          reached: false,
        };
    if (!confirmation.reached && !signal.aborted) {
      this.confirmationTracker.continueInBackground({
        chain: input.chain,
        txHash: input.txHash,
        ...(input.minFinality !== undefined ? { required: input.minFinality } : {}),
      });
    }
    return confirmation;
  }

  /** Gateway graceful shutdown hook for process-local background loops. */
  close(): void {
    this.confirmationTracker?.stopBackground();
  }

  /* ---------------------------- broadcast ---------------------------- */

  /**
    * Broadcast an already-simulated transaction (DFR-M1-C03a, **only the decidable paths**).
   *
    * Order (aligned with transaction-lifecycle §4.4):
   *
   * ```text
    * Fetch the record ─► state check (must be simulated) ─► client echo vs. record payload ─► port existence
    *        ─► record sign transition (signed, writes expectedHash only) ─► single broadcast
    *             ├─ accepted ─► broadcast.accepted transition (writes txHash) ─► return
    *             └─ other ─────► state **stays signed**, rethrow verbatim
   * ```
   *
    * Three deliberate choices:
   *
    * 1. **Failures do not change state**: `signed` is the only honest landing spot for "may already be sent".
    *    A timeout is neither success nor failure (the `unknown` edge is not yet defined, see ADR-019 / C03b),
    *    so this method never writes `failed` / `unknown`; it only rethrows the original error.
    * 2. **No retries**: the broadcast's `non-idempotent-write` is declared by the Adapter and refused by the Provider layer;
    *    the engine adds no loop here either, or it would bypass those two protections.
    * 3. **Only public fields are persisted**: `expectedHash` and `txHash` are hashes, not the signature text;
    *    `signedPayload` never enters the record.
   */
  async broadcast(input: BroadcastTransactionInput): Promise<BroadcastTransactionResult> {
    return this.measure(input.signed.chain, 'broadcast', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.broadcastInternal(input),
      ),
    );
  }

  private async broadcastInternal(input: BroadcastTransactionInput): Promise<BroadcastTransactionResult> {
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const signal = input.signal ?? new AbortController().signal;
    const { signed } = input;

    const record = await this.stores.transaction.get(input.transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_TRANSACTION_NOT_FOUND',
        requestId,
        signed.chain,
         `Unknown transaction ${input.transactionId}`,
        { transactionId: input.transactionId },
      );
    }
    this.assertCallerTransactionScope(record, input, requestId);
    if (record.chain !== signed.chain) {
      throw this.fail(
        'DFR_CHAIN_MISMATCH',
        requestId,
        signed.chain,
         `Signed payload chain ${signed.chain} does not match record ${record.chain}`,
        { fields: ['chain'] },
      );
    }

     // Rebroadcast (TODO-012) and first broadcast are two different state paths:
     //   first: simulated --sign--> signed --broadcast.accepted--> broadcast
     //   rebroadcast: dropped --rebroadcast--> broadcast (requires explicit rebroadcast: true)
     // The state machine forbids any implicit second broadcast other than `dropped → broadcast`, so this must branch explicitly,
     // otherwise a `dropped` record would be rejected in `assertBroadcastable` (exactly the problem the pre-review found).
    const rebroadcast = input.options?.rebroadcast === true;
    if (rebroadcast) {
      if (record.status !== 'dropped') {
        throw this.fail(
          'DFR_TRANSACTION_REJECTED',
          requestId,
          record.chain,
           `Only transactions in dropped state can be rebroadcast (currently ${record.status})`,
          { reason: 'rebroadcast_not_allowed', fields: ['rebroadcast'], status: record.status },
        );
      }
       // A rebroadcast must use the **already signed** transaction in the record: expectedHash is the record's ground truth,
       // and a client-supplied different hash must not be accepted as "rebroadcasting another transaction".
      if (record.expectedHash === undefined || record.expectedHash !== signed.expectedHash) {
        throw this.fail(
          'DFR_TRANSACTION_REJECTED',
          requestId,
          record.chain,
           'Rebroadcast expectedHash does not match the record; broadcast refused',
          { reason: 'expected_hash_mismatch', fields: ['signedTransaction.expectedHash'] },
        );
      }
    } else {
      this.assertBroadcastable(record, requestId);
    }

       // The unsigned payload the client sends back is only an echo; the record is the ground truth; a mismatch means the client changed the parameters.
    if (record.unsignedPayload !== signed.unsigned.payload) {
      throw this.fail(
        'DFR_TRANSACTION_REJECTED',
        requestId,
        record.chain,
         'The unsigned payload in the sign request does not match the record; broadcast refused',
        { reason: 'unsigned_payload_mismatch', fields: ['unsignedTransaction.payload'] },
      );
    }

    if (typeof this.deps.chain.broadcast !== 'function') {
       // fail-closed: refuse rather than silently skipping the binding check and broadcasting.
      throw this.fail(
        'DFR_UNSUPPORTED_CAPABILITY',
        requestId,
        record.chain,
         'No broadcast implementation is wired up in this deployment',
        { capability: 'transaction.broadcast' },
      );
    }

     // Persist signed first (only expectedHash, no signature text), then broadcast:
     // broadcast is irreversible, so the "already signed" fact must be queryable first.
    const signStarted = performance.now();
    const signedRecord = rebroadcast
      ? await this.applyTransition(
          record,
          'rebroadcast',
          requestId,
          { expectedHash: signed.expectedHash },
          { rebroadcast: true },
        )
      : await this.applyTransition(record, 'sign', requestId, {
          expectedHash: signed.expectedHash,
        });
     // This measures the duration of the one "persist the signature" state transition (DB write + CAS),
     // not the client's own signing time — signing happens outside DFR.
    this.deps.metrics?.recordStage({
      chain: record.chain,
      stage: 'sign',
      status: 'success',
      durationSeconds: Math.max(0, (performance.now() - signStarted) / 1000),
    });

    // B45 / ADR-032: a Solana blockhash is *consumed* once a signed
    // transaction has been durably recorded, not after the RPC accepts it.
    // Otherwise a TTL orphan sweep can expire a still-reserved lease during
    // network submission (or a crash), erasing that signed transaction's
    // sequencing ownership. Fail closed before any external broadcast.
    if (signedRecord.sequencingRef?.kind === 'blockhash') {
      if (this.stores.sequencing === undefined) {
        throw this.fail(
          'DFR_CONFIGURATION_ERROR', requestId, record.chain,
           'A signed blockhash transaction is missing its SequencingStore; broadcast refused',
          { capability: 'transaction.broadcast' },
        );
      }
      const consumed = await this.stores.sequencing.markConsumed({
        chain: signedRecord.chain,
        account: signedRecord.from,
        transactionId: signedRecord.transactionId,
        tokenValue: signedRecord.sequencingRef.value,
      });
      if (consumed.kind !== 'updated' || consumed.lease.status !== 'consumed') {
        throw this.fail(
          'DFR_TRANSACTION_REJECTED', requestId, record.chain,
           'The signing lease for a signed transaction does not exist or has expired; broadcast refused',
          { reason: 'sequencing_lease_inactive' },
        );
      }
    }

    const expected = {
      from: record.from,
      unsignedPayload: record.unsignedPayload as string,
    };
    let broadcast: BroadcastResult;
    try {
      // B43: the signing client can take longer than a blockhash's validity
      // window. Check the durable Store sequencing token (not the client echo)
      // immediately before the non-idempotent network send. EVM nonce is
      // deliberately excluded: it has no block-height expiration semantics.
      if (signedRecord.sequencingRef?.kind === 'blockhash') {
        if (typeof this.deps.chain.isSequencingExpired !== 'function') {
          throw this.fail(
            'DFR_UNSUPPORTED_CAPABILITY', requestId, record.chain,
             'Solana blockhash validity chain-height check is not configured for signed broadcast; refusing to send',
            { capability: 'transaction.broadcast', reason: 'blockhash_expiry_missing' },
          );
        }
        const expired = await this.deps.chain.isSequencingExpired({
          chain: record.chain,
          token: signedRecord.sequencingRef,
          requestId,
          ...trace,
          signal,
        });
        if (expired) {
          throw this.fail(
            'DFR_BLOCKHASH_EXPIRED', requestId, record.chain,
             'The blockhash used by this signed Solana transaction has expired; rebuild and sign externally',
            { reason: 'blockhash_expired_before_broadcast' },
          );
        }
      }
      broadcast = await this.deps.chain.broadcast({
        signed,
        expected,
        ...(input.options !== undefined ? { options: input.options } : {}),
        requestId,
        ...trace,
        signal,
      });
    } catch (err) {
      if (rebroadcast) {
        // TX-04: after dropped→broadcast, an RPC error is not proof the
        // retransmission was rejected: the *original* signed tx may already
        // be mined and the new send may have reached the peer. Mark unknown
        // for read-only recovery; never auto-retry, release nonce or mark failed.
        // Isolate any storage/observation error so the original network
        // exception remains visible to the caller.
        try {
          const unknown = await this.applyTransition(
            signedRecord, 'rebroadcast.indeterminate', requestId,
          );
          await this.tryResolveUnknown(unknown, requestId, signal, trace);
        } catch {
          // A concurrent observer may already have advanced the record. CAS
          // prevents overwriting it. A failed DB write is not an accepted send.
        }
        throw err;
      }
       // A broadcast failure must be classified; it cannot simply stay signed: ADR-019 requires
       //   a provably non-self-healing rejection → failed (terminal state)
       //   everything else (timeout / unavailable / circuit breaker / nonce conflict / unclassifiable) → unknown → resolve by observation
      try {
        await this.handleBroadcastFailure(signedRecord, err, requestId, signal, trace);
      } catch {
        // TX-02: do not replace the transport error with a secondary Store/
        // observation failure. The durable signed record and expectedHash
        // are picked up by restart recovery. Never replay the payload here.
      }
      throw err;
    }

    const txHash = broadcast.ref.kind === 'hash' ? broadcast.ref.hash : null;
     // First broadcast: signed → broadcast (also writing txHash).
     // Rebroadcast: the `rebroadcast` edge **already** landed the state on `broadcast`, so taking `broadcast.accepted`
     // again would be `broadcast → broadcast` (no such edge). txHash was already persisted on the first broadcast; no need to rewrite it.
    const advanced = rebroadcast
      ? signedRecord
      : await this.applyTransition(
          signedRecord,
          'broadcast.accepted',
          requestId,
          txHash !== null ? { txHash } : undefined,
        );

    const result: BroadcastTransactionResult = {
      transactionId: advanced.transactionId,
      status: advanced.status,
      txHash: txHash ?? signed.expectedHash,
      accepted: broadcast.accepted,
      observedAt: broadcast.observedAt,
    };
     // Whether this is a rebroadcast is decided by the **engine** (it knows whether this request asked for one),
     // not by the Adapter echoing it in its result — any Adapter that forgets to echo would break the contract.
     // Compatibility with an Adapter echo is kept, but the engine's decision takes precedence.
    return rebroadcast || broadcast.rebroadcast === true
      ? { ...result, rebroadcast: true }
      : result;
  }

  /**
    * State attribution after a broadcast failure (ADR-019).
   *
    * This method **never throws**: the original error must be rethrown verbatim to the caller (the single error-construction point),
    * and this only writes the state to the honest landing spot. Any internal failure (observation unavailable, Store conflict)
    * must neither swallow the original error nor push the transaction into a terminal state.
   */
  private async handleBroadcastFailure(
    signedRecord: TransactionRecord,
    error: unknown,
    requestId: RequestId,
    signal: AbortSignal,
    trace: { traceId?: string; spanId?: string } = {},
  ): Promise<void> {
    // TX-02: only a signed Solana transaction with an on-record blockhash
    // sequencing token may rely on the adapter's DFR_BLOCKHASH_EXPIRED proof.
    // A generic EVM/provider rejection (even one mislabelled with that code)
    // is NOT network-wide evidence of non-propagation, so stay unknown.
    if (classifyBroadcastFailure(error) === 'rejected' && signedRecord.sequencingRef?.kind === 'blockhash') {
      await this.applyTransition(signedRecord, 'broadcast.rejected', requestId, {
        errorCode: isDfrError(error) ? error.code : 'DFR_INTERNAL_ERROR',
      });
      return;
    }

     // Indeterminate: first land on unknown (the only inbound edge), then try to resolve it with one on-chain observation.
    const unknown = await this.applyTransition(
      signedRecord,
      'broadcast.indeterminate',
      requestId,
    );
    await this.tryResolveUnknown(unknown, requestId, signal, trace);
  }

  /**
    * Resolve `unknown` with one on-chain observation (ADR-019, section 4).
   *
    * If the observation is inconclusive, observation is unavailable, or the deployment has no `observe` wired up, **stay `unknown`**:
    * "not found right now" is not "dropped" (mempool propagation is asynchronous); `dropped` is left to M1-D03's
    * `dropTimeoutMs` window decision.
   */
  private async tryResolveUnknown(
    unknown: TransactionRecord,
    requestId: RequestId,
    signal: AbortSignal,
    trace: { traceId?: string; spanId?: string } = {},
    /**
      * Whether "observed `absent` and already timed out" may be judged `dropped` (ADR-023).
     *
      * Only a **re-observation by recovery/patrol** may set this true. An observation inside the same broadcast request must stay conservative
      * (ADR-019, line 142: "an absent observation within the same request does not resolve to dropped", because mempool
      * propagation is asynchronous — not finding it now may just mean it has not propagated yet).
     */
    allowDropTimeout = false,
  ): Promise<TransactionRecord | null> {
     // Only applies to unknown / dropped (ADR-023): other states are filtered by the caller before this point.
    if (unknown.status !== 'unknown' && unknown.status !== 'dropped') return null;
    if (typeof this.deps.chain.observe !== 'function' || unknown.nonce === undefined) {
      return null;
    }

    let observation: ChainBroadcastObservation;
    try {
       // Must call through this.deps.chain.observe(...): pulling the method out and calling it loses its receiver,
       // and `this` inside the port implementation (observation records, connection handles) would become undefined.
      observation = await this.deps.chain.observe({
        chain: unknown.chain,
        txHash: unknown.expectedHash ?? '',
        from: unknown.from,
        nonce: unknown.nonce,
        requestId,
        ...trace,
        signal,
      });
    } catch {
       // An observation failure must not change the classification (still unknown), nor overwrite the original broadcast error.
      return null;
    }

    const event = resolveUnknownOutcome(observation);
    if (event === null) {
       // `absent` (or unclassifiable): only judge `dropped` when **in unknown and past dropTimeoutMs**.
       // Both ADR-023 conditions are indispensable — judging dropped from a single "not found" would make callers think they can rebroadcast.
      if (
        allowDropTimeout &&
        observation.kind === 'absent' &&
        unknown.status === 'unknown' &&
        this.dropTimeoutExceeded(unknown)
      ) {
        return await this.applyTransition(unknown, 'dropped', requestId);
      }
      return null;
    }

    const patch =
      observation.kind === 'included' && observation.txHash !== undefined
        ? {
            txHash: observation.txHash,
            ...(observation.blockRef !== undefined ? { blockRef: observation.blockRef } : {}),
            ...(observation.canonicalBlockHash !== undefined
              ? { canonicalBlockHash: observation.canonicalBlockHash }
              : {}),
          }
        : undefined;
    return await this.applyTransition(unknown, event, requestId, patch);
  }

  /**
    * Explicitly resolve one `unknown` or `dropped` transaction (for the M1-D03 recovery scan and ops troubleshooting).
   *
    * - `unknown`: observe → advance to the observation's landing spot; if the observation is `absent` and `dropTimeoutMs` has passed,
    *   then move to `dropped` (ADR-023);
    * - `dropped`: only **convergence correction** (included / pending / replaced); when the observation is `absent`,
    *   stay as-is — `dropped` is a judgment, not a fact; without this rule it would be permanently misreported.
   *
    * Idempotent: other states return the current record directly, without error and without advancing.
   */
  async resolveIndeterminate(input: {
    readonly transactionId: TransactionId;
    readonly requestId?: RequestId;
    readonly signal?: AbortSignal;
  }): Promise<TransactionRecord | null> {
    const requestId = input.requestId ?? newRequestId();
    const signal = input.signal ?? new AbortController().signal;
    const record = await this.stores.transaction.get(input.transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_TRANSACTION_NOT_FOUND',
        requestId,
        undefined,
         `Unknown transaction ${input.transactionId}`,
        { transactionId: input.transactionId },
      );
    }
     // unknown: observe + timeout decision; dropped: convergence correction only (ADR-023).
     // This is a "re-observation", so judging dropped on timeout is allowed here.
    if (record.status !== 'unknown' && record.status !== 'dropped') return record;
    const resolved = await this.tryResolveUnknown(record, requestId, signal, {}, true);
    return resolved ?? record;
  }

  /**
    * Has the silence already exceeded `dropTimeoutMs` (ADR-023)?
   *
    * Measured from `updatedAt`: `transition()` writes it when entering `unknown`, so it marks
    * "the moment it entered unknown". The store clock and the process clock may drift slightly (Postgres uses
    * `clock_timestamp()`), which does not affect a decision at the 30-minute scale.
   */
  private dropTimeoutExceeded(record: TransactionRecord): boolean {
    const timeout = this.deps.dropTimeoutMs ?? DEFAULT_DROP_TIMEOUT_MS;
    const since = Date.parse(record.updatedAt);
    if (!Number.isFinite(since)) return false;
    const now = this.deps.dropClock?.() ?? Date.now();
    return now - since >= timeout;
  }

   /** Only `simulated` may enter broadcast; the failure reason uses a stable reason (without leaking internal state-machine vocabulary). */
  private assertBroadcastable(record: TransactionRecord, requestId: RequestId): void {
    if (record.status === 'simulated') return;
    const reason =
      record.status === 'built'
        ? 'simulation_required'
        : record.status === 'reverted'
          ? 'simulation_failed'
          : 'invalid_status';
    throw this.fail(
      'DFR_TRANSACTION_REJECTED',
      requestId,
      record.chain,
       `Transaction is in state ${record.status}; broadcast is not allowed`,
      { reason, fields: ['status'], status: record.status },
    );
  }

   /* ------------------------------ internals ------------------------------ */

  /**
    * Simulate an already-built transaction (DFR-M1-B05).
   *
    * Order (every step that fails must not advance the state):
   *
   * ```text
    * Fetch the record ─► binding check (chain / payload / nonce) ─► state check (built | simulated)
    *        ─► read-only simulation
    *             ├─ success ─► built becomes simulated / simulated only updates the observation
    *             └─ failure ─► move to reverted (terminal state, broadcast unreachable) → throw DFR_TRANSACTION_REVERTED
   * ```
   *
    * Two deliberate choices:
    * - **Failures throw instead of returning a result**: there is exactly one construction point for on-chain revert errors (gateway-spec section 8,
    *   "each error is constructed exactly once, in the layer it belongs to"). The HTTP layer only maps the status code (422) and needs no re-classification;
    * - **Failures are persisted before being thrown**: the state must first be written as `reverted` to guarantee the "broadcast is blocked" safety property,
    *   so no broadcastable transaction is left behind even if the caller ignores the error.
   */
  async simulate(input: SimulateTransactionInput & ScopedTransactionRequest): Promise<SimulatedTransactionResult> {
    return this.measure(input.unsignedTransaction.chain, 'simulate', () =>
      withStoreCallContext(
        {
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
        },
        () => this.simulateInternal(input),
      ),
    );
  }

  private async simulateInternal(input: SimulateTransactionInput & ScopedTransactionRequest): Promise<SimulatedTransactionResult> {
    const requestId = input.requestId ?? newRequestId();
    const trace = traceContext(input);
    const signal = input.signal ?? new AbortController().signal;
    const record = await this.stores.transaction.get(input.transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_TRANSACTION_NOT_FOUND',
        requestId,
        input.unsignedTransaction.chain,
         `Unknown transaction ${input.transactionId}`,
        { transactionId: input.transactionId },
      );
    }

    this.assertCallerTransactionScope(record, input, requestId);
    this.assertSimulationBinding(record, input.unsignedTransaction, requestId);

    if (!SIMULATABLE_STATUSES.includes(record.status)) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        record.chain,
         `Transaction is in state ${record.status}; simulation is not allowed (only ${SIMULATABLE_STATUSES.join(' / ')})`,
        { fields: ['status'], status: record.status, allowed: [...SIMULATABLE_STATUSES] },
      );
    }

    const simulation = await this.deps.chain.simulate({
      transactionId: record.transactionId,
      unsigned: input.unsignedTransaction,
      from: record.from,
      requestId,
      ...trace,
      signal,
    });

    if (simulation.success) {
      if (record.status === 'simulated') {
         // Repeated calls: the result is returned as a new observation without advancing the state (m1-api-contract section 2).
        return { transactionId: record.transactionId, status: 'simulated', simulation };
      }
      const applied = await this.applyTransition(record, 'simulate.succeeded', requestId);
      return { transactionId: applied.transactionId, status: applied.status, simulation };
    }

     // Simulation failure: the terminal state reverted must be persisted first, then the error is thrown.
     // State selection (no state-machine change, just reusing existing edges):
     //   built → simulate.failed (the edge explicitly defined in spec section 3.1)
     //   simulated → execution.failed (the `*` row in the table, the only edge from simulated to reverted)
    const event: TransactionEvent = record.status === 'built' ? 'simulate.failed' : 'execution.failed';
    const reverted = await this.applyTransition(record, event, requestId, {
      errorCode: 'DFR_TRANSACTION_REVERTED',
    });

    // TX-01: a failed simulation is terminal and has never been signed or sent.
    // Release only unsigned EVM nonce leases, with ownership checked in the Store.
    // An unexpected Store failure must not mask the original simulation revert.
    if (reverted.nonce !== undefined && reverted.expectedHash === undefined && reverted.txHash === undefined) {
      try {
        await this.stores.nonce.releaseIfSafe({
          chain: reverted.chain,
          account: reverted.from,
          nonce: reverted.nonce,
          transactionId: reverted.transactionId,
        });
      } catch {
        // Safe retry/reconciliation is required if the lease release fails.
      }
    }

     const revertReason = simulation.revertReason ?? 'Simulation failed, but the node returned no reason';
    throw createDfrError('DFR_TRANSACTION_REVERTED', {
      requestId,
      chain: record.chain,
       message: 'Simulation failed: the transaction execution reverted; broadcast has been blocked',
      details: {
        transactionId: record.transactionId,
        revertReason,
        ...(simulation.estimatedCost !== undefined
          ? { estimatedCost: simulation.estimatedCost }
          : {}),
      },
    });
  }

   /* ---------------------------- internal helpers ---------------------------- */

  /**
   * A transactionId identifies persisted state but grants no authorization.
   * Enforce the authenticated project/chain before any RPC or state update.
   */
  private assertCallerTransactionScope(
    record: TransactionRecord,
    input: ScopedTransactionRequest,
    requestId: RequestId,
  ): void {
    if (
      (input.requesterProjectId !== undefined && record.projectId !== input.requesterProjectId) ||
      (input.authorizedChains !== undefined && input.authorizedChains !== '*' &&
       !input.authorizedChains.includes(record.chain))
    ) {
       throw this.fail('DFR_PROJECT_SCOPE_DENIED', requestId, undefined, 'No permission to access this transaction');
    }
  }

  /**
    * Binding check: the payload simulate receives must be exactly the one build persisted.
   *
    * Three comparisons, one by one: chain, payload bytes, and the nonce the payload declares vs. the leased nonce.
    * Any mismatch fails closed, and it all happens **before the chain is called** — giving "probing with someone else's payload"
    * no RPC observation surface at all.
   */
  private assertSimulationBinding(
    record: TransactionRecord,
    unsigned: UnsignedTransaction,
    requestId: RequestId,
  ): void {
    if (unsigned.chain !== record.chain) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        record.chain,
         `Payload chain ${unsigned.chain} does not match record ${record.chain}`,
        { fields: ['unsignedTransaction.chain'] },
      );
    }
    if (record.unsignedPayload === undefined) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        record.chain,
         `Transaction ${record.transactionId} has no persisted unsigned payload; the binding cannot be verified`,
      );
    }
    if (unsigned.payload !== record.unsignedPayload) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        record.chain,
         'The payload does not match the build result: only the unsigned payload returned by build is accepted',
        { fields: ['unsignedTransaction.payload'] },
      );
    }
    if (record.nonce !== undefined && unsigned.meta.requiresNonce !== record.nonce) {
      throw this.fail(
        'DFR_VALIDATION_FAILED',
        requestId,
        record.chain,
         'The nonce declared by the payload does not match the allocated lease',
        { fields: ['unsignedTransaction.meta.requiresNonce'] },
      );
    }
  }

  /**
    * State transition with CAS: on conflict, re-read the record and re-derive the target state.
   *
    * No last-write-wins (development-plan section 4.2): every write carries the
    * `expectedStatus` + `expectedVersion` it read; the Store uses them as conditions.
   */
  private async applyTransition(
    record: TransactionRecord,
    event: TransactionEvent,
    requestId: RequestId,
    patch?: TransitionPatch,
    /**
      * Extra state-machine input. Currently only `rebroadcast`:
      * the `dropped → broadcast` edge requires an explicit `rebroadcast: true`,
      * otherwise `transition()` rejects with `REBROADCAST_FLAG_REQUIRED`.
     */
    transitionOptions?: { readonly rebroadcast?: boolean },
  ): Promise<TransactionRecord> {
    let current = record;
    for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt += 1) {
      const moved = transition({
        from: current.status,
        event,
        ...(transitionOptions?.rebroadcast !== undefined
          ? { rebroadcast: transitionOptions.rebroadcast }
          : {}),
      });
      if (!moved.ok) {
         // The only reachable path is "a concurrent executor changed the state"; handle it as a caller-visible conflict, not a 500.
        throw this.fail(
          'DFR_VALIDATION_FAILED',
          requestId,
          current.chain,
           `Transaction state ${current.status} does not accept event ${event} (${moved.reason})`,
          { fields: ['status'], status: current.status, transitionReason: moved.reason },
        );
      }

      const result = await this.stores.transaction.transition({
        transactionId: current.transactionId,
        expectedStatus: current.status,
        expectedVersion: current.stateVersion,
        toStatus: moved.status,
        reason: event,
        requestId,
        ...(patch !== undefined ? { patch } : {}),
      });
      if (result.kind === 'applied') {
         // Publish only after the transaction commits: subscribers only ever see persisted facts.
         // Sink errors are swallowed — a failed event delivery must not change the business outcome.
        try {
          this.deps.onTransition?.({
            transactionId: result.record.transactionId,
            chain: result.record.chain,
            fromStatus: current.status,
            toStatus: result.record.status,
            stateVersion: result.record.stateVersion,
            requestId,
            ...(result.record.txHash !== undefined ? { txHash: result.record.txHash } : {}),
          });
        } catch {
           // Event delivery is best-effort: a sink exception must never change the business outcome "the state has transitioned".
        }
        return result.record;
      }
      if (result.kind === 'not_found') {
        throw this.fail(
          'DFR_INTERNAL_ERROR',
          requestId,
          current.chain,
           `Transaction ${current.transactionId} no longer exists at transition time`,
        );
      }
       // version_conflict / status_conflict: retry with the latest record returned by the Store.
      current = result.current;
    }
    throw this.fail(
      'DFR_INTERNAL_ERROR',
      requestId,
      record.chain,
       `State transition hit ${MAX_TRANSITION_ATTEMPTS} consecutive conflicts and could not be written`,
      { transactionId: record.transactionId },
    );
  }

  private async measure<T>(chain: ChainId, stage: TransactionStage, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let status: 'success' | 'error' | 'timeout' | 'pending' = 'success';
    let errorCode: string | undefined;
    try {
      const result = await operation();
      if (stage === 'confirm') {
        const confirmation = result as ConfirmationResult;
        if (!confirmation.reached) status = 'pending';
        else if (confirmation.requiredFinality !== undefined) {
          const durationSeconds = Math.max(0, (performance.now() - started) / 1000);
          this.deps.metrics?.recordFinality({ chain, level: confirmation.requiredFinality, durationSeconds });
          if (confirmation.requiredFinality === 'finalized') {
            this.deps.metrics?.recordStage({ chain, stage: 'finalize', status: 'success', durationSeconds });
          }
        }
      }
      return result;
    } catch (error) {
      errorCode = isDfrError(error) ? error.code : 'DFR_INTERNAL_ERROR';
      status = errorCode === 'DFR_PROVIDER_TIMEOUT' ? 'timeout' : 'error';
      throw error;
    } finally {
    this.deps.metrics?.recordStage({
        chain,
        stage,
        status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        durationSeconds: Math.max(0, (performance.now() - started) / 1000),
      });
    }
  }

   /** Idempotent-record hit: rebuild the result from the persisted record without re-executing and without consuming a new nonce. */
  private async replay(
    transactionId: TransactionId | undefined,
    requestId: RequestId,
    chain: ChainId,
  ): Promise<BuiltTransactionResult> {
    if (transactionId === undefined) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        chain,
         'Idempotent record is marked complete but has no transactionId',
      );
    }
    const record = await this.stores.transaction.get(transactionId);
    if (record === null) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        chain,
         `Transaction ${transactionId} referenced by the idempotent record does not exist`,
      );
    }
     // Replay needs the ordering precondition (EVM=nonce, Solana=blockhash) and the unsigned payload in the record.
    const sequencingToken = record.sequencingRef ?? (record.nonce !== undefined
      ? { kind: 'nonce' as const, value: record.nonce }
      : undefined);
    if (sequencingToken === undefined || record.unsignedPayload === undefined) {
      throw this.fail(
        'DFR_INTERNAL_ERROR',
        requestId,
        chain,
         `Transaction ${transactionId} is missing its ordering precondition or unsigned payload; build cannot be replayed`,
      );
    }
    return {
      transactionId: record.transactionId,
      status: record.status,
      ...(record.nonce !== undefined ? { nonce: record.nonce } : {}),
      sequencingToken,
      unsignedTransaction: {
        schemaVersion: '1',
        chain: record.chain,
        payload: record.unsignedPayload,
        meta: {
          encoding: record.payloadEncoding ?? 'hex',
          ...(record.nonce !== undefined ? { requiresNonce: record.nonce } : {}),
          ...(sequencingToken.kind === 'blockhash'
            ? { recentBlockhash: sequencingToken.value }
            : {}),
        },
      },
      replayed: true,
      replayable: true,
    };
  }

  /**
    * Release the unsigned nonce lease (compensating action).
   *
    * All three failures must be swallowed: `not_found` (the lease already expired and was cleaned up), `forbidden`
    * (the same nonce is already signed/broadcast — it must **never** be released), and Store errors of its own. A release is compensation;
    * it cannot change the fact that "this build failed".
   */
  private async releaseQuietly(
    chain: ChainId,
    account: AccountRef,
    transactionId: TransactionId,
    nonce: DecimalUint | undefined,
    sequencingToken: SequencingToken | undefined,
  ): Promise<void> {
    try {
      if (nonce !== undefined) {
         // transactionId is ADR-030's proof of ownership: a nonce gap can be reclaimed and reused,
         // and without it, a late release could land on someone else's new lease.
        await this.stores.nonce.releaseIfSafe({ chain, account, nonce, transactionId });
        return;
      }
      if (sequencingToken !== undefined && this.stores.sequencing !== undefined) {
        await this.stores.sequencing.releaseIfSafe({
          chain,
          account,
          transactionId,
          tokenValue: sequencingToken.value,
        });
      }
    } catch {
       // Deliberately ignored: see the method comment.
    }
  }

  private now(): Iso8601 {
    return this.deps.now?.() ?? (new Date().toISOString() as Iso8601);
  }

  private newTransactionId(): TransactionId {
    return (
      this.deps.newTransactionId?.() ?? (`txn_${randomBytes(16).toString('hex')}` as TransactionId)
    );
  }

  private newOwnerToken(): string {
    return this.deps.newOwnerToken?.() ?? randomBytes(16).toString('hex');
  }

  private fail(
    code: Parameters<typeof createDfrError>[0],
    requestId: RequestId,
     /** Omit when the record does not exist, since the chain is unknowable then */
    chain: ChainId | undefined,
    message: string,
    details?: Record<string, unknown>,
  ): Error {
    return createDfrError(code, {
      requestId,
      ...(chain !== undefined ? { chain } : {}),
      message,
      ...(details !== undefined ? { details } : {}),
    });
  }
}
