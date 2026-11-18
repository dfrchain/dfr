/**
 * DFR Core (M0: Query Engine + Capability Router).
 *
 * Responsibilities:
 * - Assemble the Chain Registry, Adapters, and Provider Manager;
 * - do Capability routing before calling an Adapter (undeclared → DFR_UNSUPPORTED_CAPABILITY);
 * - at startup, validate `registry ⊆ adapter` for the enabled chains (fail-closed);
 * - keep Core free of any chain-specific branches (chain-specific logic lives only in Adapters).
 */
import {
  ERROR_METADATA,
  createDfrError,
  isDfrError,
  isKnownErrorCode,
  newRequestId,
  toDfrError,
  type ErrorMetadata,
} from '@dfr/errors';
import {
  ProviderManager,
  type ProviderCallRecord,
  type ProviderObservabilitySnapshot,
} from '@dfr/provider';
import { projectChain, type ChainRegistry } from '@dfr/registry';
import { evaluateFinality } from '@dfr/transaction';
import type {
  AccountRef,
  AdapterContext,
  AssetRef,
  Balance,
  BalanceCapability,
  Block,
  BroadcastCapability,
  BroadcastObservation,
  BroadcastObservationReadMethod,
  BroadcastObservationRequest,
  ChainConfirmationObservation,
  ConfirmationObservationReadMethod,
  ConfirmationResult,
  BroadcastOptions,
  BroadcastResult,
  BuildCapability,
  BlockCapability,
  BlockRef,
  CapabilityId,
  Chain,
  ChainAdapter,
  ChainId,
  ChainInfo,
  ConsistencyHint,
  ContractLogsCapability,
  ContractLogsRequest,
  ContractReadCapability,
  ContractReadRequest,
  ContractReadResult,
  Account,
  AccountCodeCapability,
  ChainLog,
  DecimalUint,
  FinalityLevel,
  FinalityPolicy,
  Milestone,
  PendingNonceReadMethod,
  ProviderQuotaStore,
  SequencingTokenReadMethod,
  Receipt,
  RequestId,
  SequencingToken,
  SequencingTokenExpiryMethod,
  EnsureSequencingTokenMethod,
  SignedTransaction,
  SimulationCapability,
  SimulationOptions,
  SimulationResult,
  Transaction,
  TransactionQueryCapability,
  TransactionRef,
  TransactionRequest,
  UnsignedTransaction,
} from '@dfr/types';
import {
  InMemoryTransactionObservationStore,
  type TransactionObservationStore,
} from './stores.js';
import type {
  IdempotencyStore,
  NonceStore,
  SequencingStore,
  TrackerLeaseStore,
  TransactionStore,
} from '@dfr/transaction';

/** An Adapter registration: Core uses it to create an Adapter instance for the chain. */
export interface AdapterRegistration {
  id: string;
  /** The semver implementation version. */
  version: string;
  create(chain: Chain): ChainAdapter;
}

export interface DfrCoreOptions {
  registry: ChainRegistry;
  adapters: readonly AdapterRegistration[];
  /** The currently enabled milestone; only chains with milestone <= this value are usable internally. Default M0. */
  milestone?: Milestone;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * A weighted-selection randomness source (an injection point; defaults to `Math.random`).
   *
   * Why it is needed: Provider selection does **weighted random** selection between the top 2 equally scored candidates (provider-spec chapter 8).
   * That makes failover behaviors like "after the primary Provider fails, switch to the backup" non-deterministically reproducible in tests —
   * the random pick may hit the backup first, so the primary Provider is never called at all, and assertions pass or fail intermittently.
   * Injecting a fixed value (e.g. `() => 0`) stably picks the highest-scored candidate first. Same style as the existing `now` injection.
   */
  random?: () => number;
  onProviderCall?: (record: ProviderCallRecord) => void;
  /**
   * Adapter-call observation outlet (the DFR-M1-E02 observation supplement).
   *
   * Core is the only layer that knows "which Adapter call belongs to which request", so `adapter.call` records are
   * produced in Core (observability-spec chapter 4 span hierarchy). Like `onProviderCall`,
   * the callback must **never** throw in a way that affects the business path; the composition root wires it to structured logging.
   */
  onAdapterCall?: (record: AdapterCallRecord) => void;
  /**
   * Core-orchestration operation observation outlet (observability-spec §5.2).
   *
   * Emitted together with `onAdapterCall` at the single point in `callAdapter` — the same lock, the same timing,
   * so the two durations are comparable (a Core operation takes ≥ its Adapter call).
   */
  onCoreOperation?: (record: CoreOperationRecord) => void;
  /**
   * The counting outlet for `registry declared it but the Adapter did not implement it` capabilities (§5.2's
   * `dfr_core_capability_unsupported_total`). It should normally be 0.
   */
  onCapabilityUnsupported?: (input: {
    readonly chain: ChainId;
    readonly capability: string;
    /**
     * The two sources of "capability unavailable", mapped to two different counters in §5.2 and §5.3:
     * - `capability_not_declared`: the capability is absent from the Adapter's `capabilities()`
     *   → `dfr_core_capability_unsupported_total`;
     * - `method_missing`: the Adapter **declared** the capability but has no matching method
     *   → `dfr_adapter_registry_mismatch_total` (spec §8 is explicit: this means startup validation was bypassed, and it should be 0).
     */
    readonly kind: 'capability_not_declared' | 'method_missing';
  }) => void;
  /**
   * M0 read-only observation cache (not the M1 engine Store).
   *
   * Before DFR-M1-A06 this option was named `transactionStore`, but `TransactionStore` is now
   * `@dfr/transaction`'s M1 engine port (`create/get/transition/listRecoverable`).
   * The two mean different things (observation cache vs. engine record), so it was renamed to remove the ambiguity
   * and stop M1 wiring from mistakenly writing on-chain observations into the transaction execution table. The M1 engine Store is wired up by the composition root.
   */
  transactionObservationStore?: TransactionObservationStore;
  /** The M1 transaction data-plane port; M1+ must provide it in full. */
  transactionStores?: TransactionStores;
  /**
   * E5: the Provider daily-quota persistent Store.
   *
   * Injected by the composition root; without it, the Provider Manager keeps using in-process counting.
   * Core only passes the port through; it knows no SQL or database implementation.
   */
  providerQuotaStore?: ProviderQuotaStore;
}

export interface TransactionStores {
  readonly transaction: TransactionStore;
  readonly idempotency: IdempotencyStore;
  readonly nonce: NonceStore;
  /** M3-B03 (ADR-033): Solana's blockhash ordering lease; EVM deployments may leave it unwired. */
  readonly sequencing?: SequencingStore;
  readonly tracker: TrackerLeaseStore;
}

export interface CallContext {
  requestId: RequestId;
  traceId?: string;
  spanId?: string;
  signal?: AbortSignal;
}

const MILESTONE_ORDER: readonly Milestone[] = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];

function defaultFinality(policy: FinalityPolicy): FinalityLevel {
  switch (policy.kind) {
    case 'none': return 'submitted';
    case 'confirmations': return 'confirmed';
    case 'checkpoint': return 'finalized';
    case 'commitment': {
      const strongest = policy.levels.at(-1);
      if (strongest === 'finalized') return 'finalized';
      if (strongest === 'confirmed') return 'confirmed';
      return 'included';
    }
  }
}

interface ChainRuntime {
  chain: Chain;
  adapter: ChainAdapter;
  /**
   * The Adapter's **actual implementation version** (from `AdapterRegistration.version`, e.g. `0.1.0`).
   *
   * Deliberately not `chain.adapter.version`: that is the Registry-declared **semver range** (e.g. `^0.1.0`),
   * and using it as a metric label would be both inaccurate (not a concrete version) and folded into `other` by the label allowlist
   * (it contains a `^` character). Observation wants "which version is actually running".
   */
  adapterVersion: string;
  /** Lazy construction: chains without configured endpoints do not block the whole process from starting. */
  manager?: ProviderManager;
}

/**
 * One Adapter call's observation record (the DFR-M1-E02 observation supplement).
 *
 * Authoritative source: docs/architecture/observability-spec-v0.1.md, chapter 3 correlation fields and chapter 4 span hierarchy
 * (`core.operation` → `adapter.call` → `provider.request`).
 *
 * Deliberately **excludes**: call parameters, return values, payloads, and address lists. Adapter parameters may contain calldata and
 * unsigned payloads; they can be both large and sensitive, so they do not belong in log fields. For a deeper dive, correlate the
 * redacted Gateway logs and Provider call logs with `requestId`/`traceId`.
 */
export interface AdapterCallRecord {
  readonly requestId: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  /** The Adapter identifier, e.g. evm. */
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly chain: ChainId;
  /** The Adapter method name, e.g. getBalance / build / broadcast. */
  readonly method: string;
  /**
   * Read/write classification (the observability-spec §5.3 `method_class` label).
   *
   * The rule: **only `broadcast` is an on-chain write**. `build` / `simulate` do not change on-chain state,
   * so they are `read` — counting them as writes would inflate write-path metrics and make the "write operation" signal meaningless.
   */
  readonly methodClass: 'read' | 'write';
  readonly status: 'success' | 'error';
  /** The stable, normalized DFR error code. */
  readonly errorCode?: string;
  readonly latencyMs: number;
}

/**
 * One Core orchestration operation's observation event (observability-spec §5.2).
 *
 * Kept separate from `AdapterCallRecord`: a Core "operation" is a caller-facing semantic unit,
 * and operations that never touch an Adapter (e.g. a pure cache hit) may appear in the future. The two are 1:1 today but are not merged,
 * so a fake adapter record never has to be invented for the cache path later.
 */
export interface CoreOperationRecord {
  readonly requestId: RequestId;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly operation: string;
  readonly chain: ChainId;
  readonly status: 'success' | 'error';
  readonly errorCode?: string;
  /** The error classification (from the error-spec metadata); only present on error. */
  readonly category?: string;
  readonly latencyMs: number;
}

/** Per-chain readiness detail (DFR-M1-E02). */
export interface ChainReadiness {
  readonly chain: string;
  readonly providers: number;
  readonly available: number;
}

/** The Core readiness report; one of the inputs to the Gateway `/readyz`. */
export interface CoreReadiness {
  readonly ready: boolean;
  readonly chains: readonly ChainReadiness[];
}

export class DfrCore {
  private readonly options: DfrCoreOptions;
  private readonly runtimes = new Map<string, ChainRuntime>();
  private readonly registry: ChainRegistry;
  /** The TTL cache and single-flight handle for active readiness probing (see `probeReadiness`). */
  private readinessProbeCache: { readonly at: number; readonly result: CoreReadiness } | undefined;
  private readinessProbeInFlight: Promise<CoreReadiness> | undefined;

  readonly transactionObservationStore: TransactionObservationStore;
  readonly transactionStores?: TransactionStores;

  constructor(options: DfrCoreOptions) {
    this.options = options;
    this.registry = options.registry;
    this.transactionObservationStore =
      options.transactionObservationStore ?? new InMemoryTransactionObservationStore();

    const upTo = options.milestone ?? 'M0';
    const maxIndex = MILESTONE_ORDER.indexOf(upTo);
    if (maxIndex >= MILESTONE_ORDER.indexOf('M1')) {
      const stores = options.transactionStores;
      if (
        stores === undefined ||
        stores.transaction === undefined ||
        stores.idempotency === undefined ||
        stores.nonce === undefined ||
        stores.tracker === undefined
      ) {
        throw createDfrError('DFR_CONFIGURATION_ERROR', {
          requestId: newRequestId(),
          message: 'M1 requires complete persistent transaction stores',
        });
      }
      this.transactionStores = stores;
    }

    for (const entry of this.registry.listEntries()) {
      if (MILESTONE_ORDER.indexOf(entry.milestone) > maxIndex) continue;
      const registration = options.adapters.find((a) => a.id === entry.adapter.id);
      if (registration === undefined) {
        throw createDfrError('DFR_CONFIGURATION_ERROR', {
          requestId: newRequestId(),
          message: `Chain ${entry.id} references an unregistered Adapter "${entry.adapter.id}"`,
          chain: entry.id,
        });
      }
      const chain = projectChain(entry);
      const adapter = registration.create(chain);
      this.registry.assertAdapterCapabilities(entry.id, adapter.capabilities().capabilities);
      this.runtimes.set(entry.id, { chain, adapter, adapterVersion: registration.version });
    }
  }

  /** The chains available internally under the current milestone (a domain model, without milestone). */
  listChains(): readonly Chain[] {
    return [...this.runtimes.values()].map((r) => r.chain);
  }

  hasChain(chainId: string): boolean {
    return this.runtimes.has(chainId);
  }

  /* ------------------------------ Queries ------------------------------ */

  async getChainInfo(chainId: string, ctx: CallContext): Promise<ChainInfo> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'block.read', ctx);
    const adapterCtx = this.adapterContext(runtime, ctx);
    return await this.callAdapter(runtime, ctx, 'getInfo', () => runtime.adapter.getInfo(adapterCtx));
  }

  async getBalance(
    request: {
      chain: ChainId;
      account: AccountRef;
      asset?: AssetRef;
      consistency?: ConsistencyHint;
    },
    ctx: CallContext,
  ): Promise<Balance> {
    const runtime = this.runtime(request.chain, ctx);
    this.requireCapability(runtime, 'account.balance', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BalanceCapability>;
    if (typeof adapter.getBalance !== 'function') {
      throw this.unsupported('account.balance', runtime, ctx);
    }
    const adapterCtx = this.adapterContext(runtime, ctx);
    try {
      return await this.callAdapter(runtime, ctx, 'getBalance', () =>
        adapter.getBalance!(adapterCtx, {
          account: request.account,
          ...(request.asset !== undefined ? { asset: request.asset } : {}),
          ...(request.consistency !== undefined ? { consistency: request.consistency } : {}),
        }),
      );
    } catch (err) {
      throw this.normalize(err, ctx, request.chain);
    }
  }

  async getBlock(chainId: ChainId, ref: BlockRef, ctx: CallContext): Promise<Block | null> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'block.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BlockCapability>;
    if (typeof adapter.getBlock !== 'function') {
      throw this.unsupported('block.read', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'getBlock', () =>
      adapter.getBlock!(this.adapterContext(runtime, ctx), ref),
    );
  }

  async getTransaction(
    chainId: ChainId,
    ref: TransactionRef,
    ctx: CallContext,
  ): Promise<Transaction | null> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<TransactionQueryCapability>;
    if (typeof adapter.getTransaction !== 'function') {
      throw this.unsupported('transaction.read', runtime, ctx);
    }
    const tx = await this.callAdapter(runtime, ctx, 'getTransaction', () =>
      adapter.getTransaction!(this.adapterContext(runtime, ctx), ref),
    );
    if (tx !== null) await this.transactionObservationStore.put(chainId, tx);
    return tx;
  }

  /** A single confirmation observation + Registry strategy decision; polling, leases, and background work are Transaction's job. */
  async observeConfirmation(
    chainId: ChainId,
    txHash: string,
    minFinality: FinalityLevel | undefined,
    ctx: CallContext,
  ): Promise<ConfirmationResult> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<ConfirmationObservationReadMethod>;
    if (typeof adapter.observeConfirmation !== 'function') {
      throw this.unsupported('transaction.read', runtime, ctx);
    }
    try {
      const observation: ChainConfirmationObservation | null = await this.callAdapter(
        runtime,
        ctx,
        'observeConfirmation',
        () => adapter.observeConfirmation!(this.adapterContext(runtime, ctx), { txHash }),
      );
      if (observation === null) {
        throw createDfrError('DFR_TRANSACTION_NOT_FOUND', {
          requestId: ctx.requestId,
          message: 'Transaction not found on-chain',
          chain: chainId,
        });
      }
      const requiredFinality = minFinality ?? defaultFinality(runtime.chain.finality);
      const evaluation = evaluateFinality({
        policy: runtime.chain.finality,
        finalityStatus: runtime.chain.finalityStatus,
        required: requiredFinality,
        observed: observation.finality,
        ...(observation.confirmations !== undefined
          ? { confirmations: observation.confirmations }
          : {}),
      });
      // An unverified Registry policy must never let a raw adapter `finalized`
      // observation advance the DFR lifecycle to finalized. Keep the observed
      // finality fact, but cap the lifecycle status at confirmed.
      const lifecycleStatus = observation.status === 'finalized' &&
        runtime.chain.finalityStatus !== 'verified'
        ? 'confirmed'
        : observation.status;
      return {
        ref: { kind: 'hash', hash: txHash },
        status: lifecycleStatus,
        finality: evaluation.observed,
        requiredFinality,
        reached: evaluation.reached,
        ...(observation.blockRef !== undefined ? { blockRef: observation.blockRef } : {}),
        ...(observation.canonicalBlockHash !== undefined
          ? { canonicalBlockHash: observation.canonicalBlockHash }
          : {}),
        ...(observation.confirmations !== undefined
          ? { confirmations: observation.confirmations }
          : {}),
      };
    } catch (err) {
      throw this.normalize(err, ctx, chainId);
    }
  }

  async getReceipt(
    chainId: ChainId,
    ref: TransactionRef,
    ctx: CallContext,
  ): Promise<Receipt | null> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<TransactionQueryCapability>;
    if (typeof adapter.getReceipt !== 'function') return null;
    return await this.callAdapter(runtime, ctx, 'getReceipt', () =>
      adapter.getReceipt!(this.adapterContext(runtime, ctx), ref),
    );
  }

  /**
   * Read-only contract call (ADR-035, `eth_call`). Read-only; ABI encoding/decoding lives in the Adapter.
   */
  async readContract(
    chainId: ChainId,
    req: ContractReadRequest,
    ctx: CallContext,
  ): Promise<ContractReadResult> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'contract.read', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<ContractReadCapability>;
    if (typeof adapter.readContract !== 'function') {
      throw this.unsupported('contract.read', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'readContract', () =>
      adapter.readContract!(this.adapterContext(runtime, ctx), { ...req, chain: chainId }),
    );
  }

  /**
   * Account existence / contract check (ADR-036, `eth_getCode`). Read-only.
   */
  async getAccount(chainId: ChainId, account: AccountRef, ctx: CallContext): Promise<Account> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'account.code', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<AccountCodeCapability>;
    if (typeof adapter.getAccount !== 'function') {
      throw this.unsupported('account.code', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'getAccount', () =>
      adapter.getAccount!(this.adapterContext(runtime, ctx), account),
    );
  }

  /**
   * Event log query (ADR-034, M4). Capability routing + Adapter call, read-only.
   *
   * The bounded range is guaranteed by the Adapter (`maxBlockRange`); Core only does the capability gate, the method-existence check, and
   * error normalization. When the Adapter does not implement the capability, it fails closed with `DFR_UNSUPPORTED_CAPABILITY`.
   */
  async getLogs(
    chainId: ChainId,
    req: ContractLogsRequest,
    ctx: CallContext,
  ): Promise<readonly ChainLog[]> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'contract.logs', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<ContractLogsCapability>;
    if (typeof adapter.logs !== 'function') {
      throw this.unsupported('contract.logs', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'logs', () =>
      adapter.logs!(this.adapterContext(runtime, ctx), { ...req, chain: chainId }),
    );
  }

  /* ------------------------------ M1 write path ------------------------------ */

  /**
   * Build an unsigned transaction (DFR-M1-B07): Capability routing + Adapter call, no persistence, no signing.
   *
   * Core only does routing and error normalization; nonce allocation, idempotency, and the state machine belong to the Transaction Engine.
   * This method does **not** read or allocate a nonce — that is the `TransactionEngine`'s job; it hands the engine-allocated
   * explicit nonce to this method (so the Adapter never queries a nonce again).
   */
  async buildTransaction(
    chainId: ChainId,
    request: TransactionRequest,
    ctx: CallContext,
  ): Promise<UnsignedTransaction> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.build', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BuildCapability>;
    if (typeof adapter.build !== 'function') {
      throw this.unsupported('transaction.build', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'build', () =>
      adapter.build!(this.adapterContext(runtime, ctx), request),
    );
  }

  /**
   * Simulate a transaction (used by DFR-M1-B08; the port path).
   *
   * A revert is expressed by the Adapter as `SimulationResult.success=false`; this method does not turn it into an exception
   * (error-spec chapter 5: do not wrap an expected revert as a 5xx).
   */
  async simulateTransaction(
    chainId: ChainId,
    transaction: TransactionRequest | UnsignedTransaction,
    ctx: CallContext,
    options?: SimulationOptions,
  ): Promise<SimulationResult> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.simulate', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<SimulationCapability>;
    if (typeof adapter.simulate !== 'function') {
      throw this.unsupported('transaction.simulate', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'simulate', () =>
      adapter.simulate!(this.adapterContext(runtime, ctx), transaction, options),
    );
  }

  /**
   * Broadcast a signed transaction (DFR-M1-C03a; the port path).
   *
   * Core only does Capability routing and error normalization: chain semantics (signed-payload parsing, binding checks,
   * a single `eth_sendRawTransaction`) all live in the Adapter. The record ground truths in `options`
   * (`expectedFrom` / `expectedUnsignedPayload`) are supplied by the Engine and carried verbatim by Core;
   * Core does not interpret them.
   */
  async broadcastTransaction(
    chainId: ChainId,
    signed: SignedTransaction,
    ctx: CallContext,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult> {
    const runtime = this.runtime(chainId, ctx);
    this.requireCapability(runtime, 'transaction.broadcast', ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BroadcastCapability>;
    if (typeof adapter.broadcast !== 'function') {
      throw this.unsupported('transaction.broadcast', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'broadcast', () =>
      adapter.broadcast!(this.adapterContext(runtime, ctx), signed, options),
    );
  }

  /**
   * Read the on-chain pending nonce (the DFR-M1-B07 port path, not a Capability).
   *
   * When the Adapter does not implement the method, it fails closed with `DFR_UNSUPPORTED_CAPABILITY` instead of silently
   * returning `0` — otherwise "cannot read the nonce" would become "build a transaction with nonce 0".
   */
  async getPendingNonce(
    chainId: ChainId,
    account: AccountRef,
    ctx: CallContext,
  ): Promise<DecimalUint> {
    const runtime = this.runtime(chainId, ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<PendingNonceReadMethod>;
    if (typeof adapter.getPendingNonce !== 'function') {
      throw this.unsupported('transaction.build', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'getPendingNonce', () =>
      adapter.getPendingNonce!(this.adapterContext(runtime, ctx), account),
    );
  }

  /**
   * Fetch this chain's current **ordering precondition** (ADR-033, an internal coordination entry point, not a Capability).
   *
   * Same as `getPendingNonce`: do not consult Registry capabilities; route only by whether the Adapter method exists;
   * when missing, fail closed with `DFR_UNSUPPORTED_CAPABILITY` (instead of guessing a token).
   */
  async getSequencingToken(
    chainId: ChainId,
    account: AccountRef,
    ctx: CallContext,
  ): Promise<SequencingToken> {
    const runtime = this.runtime(chainId, ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<SequencingTokenReadMethod>;
    if (typeof adapter.getSequencingToken !== 'function') {
      throw this.unsupported('transaction.build', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'getSequencingToken', () =>
      adapter.getSequencingToken!(this.adapterContext(runtime, ctx), account),
    );
  }

  /**
   * Inject the ordering precondition allocated by the engine into the request (ADR-033).
   *
   * Solana's `build` must use this blockhash (or the lease and the payload disagree); EVM uses
   * `req.nonce`, and the Adapter implements this method too, to keep one engine path. Missing means fail-closed.
   */
  withSequencingToken(
    chainId: ChainId,
    request: TransactionRequest,
    token: SequencingToken,
  ): TransactionRequest {
    const runtime = this.runtime(chainId, {
      requestId: 'req_sequencing_inject' as never,
    });
    const adapter = runtime.adapter as ChainAdapter & Partial<EnsureSequencingTokenMethod>;
    if (typeof adapter.withSequencingToken !== 'function') {
      throw this.unsupported('transaction.build', runtime, {
        requestId: 'req_sequencing_inject' as never,
      });
    }
    return adapter.withSequencingToken(request, token);
  }

  /**
   * Observe the on-chain situation after a broadcast (DFR-M1-C03b, an internal coordination entry point, not a Capability).
   *
   * Same as `getPendingNonce`: do not consult Registry capabilities (this is not a public API),
   * only route by whether the Adapter method exists; when missing, fail closed with
   * `DFR_UNSUPPORTED_CAPABILITY`, leaving the engine at `unknown`.
   */
  async observeBroadcast(
    chainId: ChainId,
    req: BroadcastObservationRequest,
    ctx: CallContext,
  ): Promise<BroadcastObservation> {
    const runtime = this.runtime(chainId, ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<BroadcastObservationReadMethod>;
    if (typeof adapter.observeBroadcast !== 'function') {
      throw this.unsupported('transaction.read', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'observeBroadcast', () =>
      adapter.observeBroadcast!(this.adapterContext(runtime, ctx), req),
    );
  }

  /**
   * Judge whether an **ordering precondition** (blockhash / nonce) is expired under the current chain state
   * (DFR-M3-A01, ADR-032).
   *
   * Same as `getPendingNonce`: do not consult Registry capabilities (this is not a public API); route only by
   * whether the Adapter method exists. **Only a nonce is treated as never expiring when the method is missing** (EVM semantics).
   * For a blockhash, it must fail closed: "cannot query the chain height" must not be mistaken for "not expired yet".
   * Expiry semantics and the actual chain-height decision are still owned by the Adapter (roadmap M3, first red line).
   */
  async isSequencingExpired(
    chainId: ChainId,
    token: SequencingToken,
    ctx: CallContext,
  ): Promise<boolean> {
    const runtime = this.runtime(chainId, ctx);
    const adapter = runtime.adapter as ChainAdapter & Partial<SequencingTokenExpiryMethod>;
    if (typeof adapter.isSequencingExpired !== 'function') {
      if (token.kind === 'nonce') return false;
      // Solana blockhash validity is height-dependent. Adapter absence is
      // unknown validity, never affirmative evidence that the hash is live.
      throw this.unsupported('transaction.build', runtime, ctx);
    }
    return await this.callAdapter(runtime, ctx, 'isSequencingExpired', () =>
      adapter.isSequencingExpired!(this.adapterContext(runtime, ctx), token),
    );
  }

  /**
   * Start the Provider health sweep.
   *
   * Semantics (explicit in M0): try to construct a Manager for every enabled chain; **chains with unconfigured endpoints are skipped**,
   * without blocking process startup. Such chains fail closed with `DFR_CONFIGURATION_ERROR` when they first receive a request.
   *
   * The result is exposed via the return value, so startup logs can honestly report "which chains have a health sweep and which do not",
   * instead of letting ops believe everything is under monitoring.
   */
  startHealthChecks(): { started: string[]; skipped: string[] } {
    const started: string[] = [];
    const skipped: string[] = [];
    for (const [id, runtime] of this.runtimes) {
      try {
        this.managerFor(runtime, { requestId: newRequestId() });
        runtime.manager?.startHealthChecks();
        started.push(id);
      } catch {
        skipped.push(id);
      }
    }
    return { started, skipped };
  }

  stopHealthChecks(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.manager?.stopHealthChecks();
    }
  }

  /** Provider health snapshot (for the ops sweep). */
  providerHealth(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, runtime] of this.runtimes) {
      out[id] = runtime.manager?.healthSnapshot() ?? [];
    }
    return out;
  }

  /**
   * Provider observation snapshot (the gauge data source of observability-spec §5.4; read-only, no network).
   *
   * Returns `chainId → per-Provider snapshot`; chains without configured endpoints return an empty array
   * (consistent with `readiness()`'s "0 providers" wording — no fabricated gauge).
   */
  providerObservability(): Record<string, readonly ProviderObservabilitySnapshot[]> {
    const out: Record<string, readonly ProviderObservabilitySnapshot[]> = {};
    for (const [id, runtime] of this.runtimes) {
      const manager = this.managerIfConfigured(runtime);
      out[id] = manager?.observabilitySnapshot() ?? [];
    }
    return out;
  }

  /** E5: asynchronous Provider observation (quota usage comes from the persistent Store). */
  async providerObservabilityAsync(): Promise<Record<string, readonly ProviderObservabilitySnapshot[]>> {
    const out: Record<string, readonly ProviderObservabilitySnapshot[]> = {};
    for (const [id, runtime] of this.runtimes) {
      const manager = this.managerIfConfigured(runtime);
      out[id] = manager !== undefined ? await manager.observabilitySnapshotAsync() : [];
    }
    return out;
  }

  /**
   * Ops readiness report (DFR-M1-E02, observability-spec chapter 9).
   *
   * Semantics deliberately kept externally verifiable, without inventing new states:
   * - `providers`: the number of Providers wired up for the chain (0 = endpoints/credentials failed to resolve);
   * - `available`: of those, the number whose **read circuit breaker is closed** (an open Provider takes no traffic);
   * - `ready`: at least one chain is enabled, and at least one chain has an available Provider.
   *
   * This does not judge "never observed" (health status = unknown) as unavailable: a cold-start Provider
   * looks like that before its first probe, and judging it unavailable would leave a freshly started instance never ready.
   * That tradeoff is written in the probe section of docs/runbooks/m1-local.md.
   */
  readiness(): CoreReadiness {
    const chains: ChainReadiness[] = [];
    for (const [id, runtime] of this.runtimes) {
      const manager = this.managerIfConfigured(runtime);
      if (manager === undefined) {
        chains.push({ chain: id, providers: 0, available: 0 });
        continue;
      }
      const snapshot = manager.healthSnapshot();
      const available = snapshot.filter(
        (entry) => manager.circuitState(entry.providerId, 'read') !== 'open',
      ).length;
      chains.push({ chain: id, providers: snapshot.length, available });
    }
    const ready = chains.length > 0 && chains.some((entry) => entry.available > 0);
    return { ready, chains };
  }

  /**
   * Actively probe readiness (the DFR-M1-E02 observation supplement; opt-in).
   *
   * Difference from the synchronous `readiness()`: `readiness()` only reads the **existing** circuit-breaker/health state, so a freshly started instance
   * that has not run any probe yet counts an `unknown` Provider as available — it may "falsely report ready" at cold start.
   * This method sends one low-weight probe (e.g. `eth_chainId`) to **each** Provider of each chain on the spot,
   * so `available` means "just now actually answered".
   *
   * Cost controls (all three required):
   * - **TTL cache**: results are reused within `cacheMs` (default 5s), so an orchestration system polling every second does not hit RPC each time;
   * - **single-flight**: concurrent calls share one probe Promise, so no probe storm is created;
   * - **short timeout**: `timeoutMs` (default 2s) bounds the worst-case latency of the readiness path.
   *
   * Probes go through `ProviderManager.probe`, which calls `provider.request` directly, **bypassing the circuit breaker**,
   * so a "probe failure" never opens the circuit breaker (probes must not rewrite circuit-breaker state).
   */
  async probeReadiness(options: { timeoutMs?: number; cacheMs?: number } = {}): Promise<CoreReadiness> {
    const cacheMs = options.cacheMs ?? 5_000;
    const timeoutMs = options.timeoutMs ?? 2_000;
    const now = (this.options.now ?? Date.now)();
    const cached = this.readinessProbeCache;
    if (cached !== undefined && cacheMs > 0 && now - cached.at < cacheMs) return cached.result;
    if (this.readinessProbeInFlight !== undefined) return await this.readinessProbeInFlight;

    const inFlight = this.runReadinessProbe(timeoutMs, now).finally(() => {
      this.readinessProbeInFlight = undefined;
    });
    this.readinessProbeInFlight = inFlight;
    return await inFlight;
  }

  private async runReadinessProbe(timeoutMs: number, now: number): Promise<CoreReadiness> {
    const chains: ChainReadiness[] = [];
    for (const [id, runtime] of this.runtimes) {
      const manager = this.managerIfConfigured(runtime);
      if (manager === undefined) {
        chains.push({ chain: id, providers: 0, available: 0 });
        continue;
      }
      const providerIds = manager.healthSnapshot().map((entry) => entry.providerId);
      let available = 0;
      for (const providerId of providerIds) {
        // Serial probing: the Provider count is a single digit, so serial probing avoids an instantaneous concurrency spike on upstream endpoints.
        if (await manager.probe(providerId, timeoutMs)) available += 1;
      }
      chains.push({ chain: id, providers: providerIds.length, available });
    }
    const result: CoreReadiness = {
      ready: chains.length > 0 && chains.some((entry) => entry.available > 0),
      chains,
    };
    this.readinessProbeCache = { at: now, result };
    return result;
  }

  /** Lazily construct the ProviderManager; an endpoint/credential resolution failure counts the chain as unavailable, instead of letting the probe throw. */
  private managerIfConfigured(runtime: ChainRuntime): ChainRuntime['manager'] {
    if (runtime.manager !== undefined) return runtime.manager;
    try {
      return this.managerFor(runtime, { requestId: newRequestId() });
    } catch {
      return undefined;
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private runtime(chainId: string, ctx: CallContext): ChainRuntime {
    const runtime = this.runtimes.get(chainId);
    if (runtime === undefined) {
      throw createDfrError('DFR_NOT_FOUND', {
        requestId: ctx.requestId,
        message: `Unknown or disabled chain "${chainId}"`,
      });
    }
    return runtime;
  }

  /**
   * The unified Adapter call wrapper (the DFR-M1-E02 observation supplement).
   *
   * It does three things, in a fixed order:
   * 1. Time and call the Adapter;
   * 2. on success → emit an `adapter.call`(success) record;
   * 3. on failure → **normalize** the error first (`normalize`), emit the record with the normalized stable error code,
   *    then throw the normalized error.
   *
   * Why normalize before recording: the raw exception text thrown by `Provider`/`viem` may contain endpoints or internal addresses,
   * while `errorCode` is a stable enum. Logs record only the code, not the original text.
   */
  private async callAdapter<T>(
    runtime: ChainRuntime,
    ctx: CallContext,
    method: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      const elapsed = Date.now() - started;
      this.emitAdapterCall(runtime, ctx, method, 'success', undefined, elapsed);
      this.emitCoreOperation(runtime, ctx, method, 'success', undefined, elapsed);
      return result;
    } catch (err) {
      const normalized = this.normalize(err, ctx, runtime.chain.id as ChainId);
      const elapsed = Date.now() - started;
      const code = isDfrError(normalized) ? normalized.code : 'DFR_INTERNAL_ERROR';
      this.emitAdapterCall(runtime, ctx, method, 'error', code, elapsed);
      this.emitCoreOperation(runtime, ctx, method, 'error', code, elapsed);
      throw normalized;
    }
  }

  /**
   * Emit one Core operation record (observability-spec §5.2).
   *
   * Same convention as `emitAdapterCall`: an outlet that throws is swallowed; an observation failure must not change the business result.
   */
  private emitCapabilityUnsupported(
    chain: ChainId,
    capability: string,
    kind: 'capability_not_declared' | 'method_missing',
  ): void {
    const sink = this.options.onCapabilityUnsupported;
    if (sink === undefined) return;
    try {
      sink({ chain, capability, kind });
    } catch {
      // Observation is best-effort.
    }
  }

  private emitCoreOperation(
    runtime: ChainRuntime,
    ctx: CallContext,
    operation: string,
    status: 'success' | 'error',
    errorCode: string | undefined,
    latencyMs: number,
  ): void {
    const onCoreOperation = this.options.onCoreOperation;
    if (onCoreOperation === undefined) return;
    // First take out the possibly-undefined derived values, avoiding narrowing loss under exactOptionalPropertyTypes.
    const category = categoryOf(errorCode);
    try {
      onCoreOperation({
        requestId: ctx.requestId,
        ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
        ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
        operation,
        chain: runtime.chain.id as ChainId,
        status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        // The error classification comes from the error-spec metadata; unknown codes carry no category (never guess).
        ...(category !== undefined ? { category } : {}),
        latencyMs: Math.max(0, latencyMs),
      });
    } catch {
      // Observation is best-effort.
    }
  }

  private emitAdapterCall(
    runtime: ChainRuntime,
    ctx: CallContext,
    method: string,
    status: 'success' | 'error',
    errorCode: string | undefined,
    latencyMs: number,
  ): void {
    const onAdapterCall = this.options.onAdapterCall;
    if (onAdapterCall === undefined) return;
    try {
      onAdapterCall({
        requestId: ctx.requestId,
        ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
        ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
        adapter: runtime.chain.adapter.id,
        // The actual implementation version, not the Registry's semver range (see ChainRuntime.adapterVersion).
        adapterVersion: runtime.adapterVersion,
        chain: runtime.chain.id,
        method,
        methodClass: adapterMethodClass(method),
        status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        latencyMs: Math.max(0, latencyMs),
      });
    } catch {
      // Observation is best-effort: a log-outlet failure must not change the business result.
    }
  }

  private requireCapability(
    runtime: ChainRuntime,
    capability: CapabilityId,
    ctx: CallContext,
  ): void {
    const declared = runtime.adapter.capabilities().capabilities;
    // See ADR-034: Provider routing filters by the **Registry-declared** capabilities, while the Adapter's `capabilities()` is
    // the implementation truth. The two may disagree for capabilities like `contract.logs`/`contract.read` that the Registry may not have enabled —
    // if only the Adapter were consulted, an undeclared chain would reach Provider selection and report the misleading
    // `DFR_CHAIN_UNAVAILABLE`(503). So this also requires the **Registry** to declare the capability:
    // undeclared means fail-closed with `DFR_UNSUPPORTED_CAPABILITY`(422).
    const registryDeclares = runtime.chain.capabilities.includes(capability);
    if (!declared.includes(capability) || !registryDeclares) {
      // A capability being unsupported is a **configuration/contract** problem, not runtime jitter: count it separately,
      // so §5.2's `capability_unsupported` pinpoints it directly (0 is the healthy value).
      this.emitCapabilityUnsupported(runtime.chain.id as ChainId, capability, 'capability_not_declared');
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: `Chain ${runtime.chain.id} does not support capability ${capability}`,
        chain: runtime.chain.id,
        details: { capability },
      });
    }
  }

  private unsupported(
    capability: CapabilityId,
    runtime: ChainRuntime,
    ctx: CallContext,
  ): Error {
    // Reaching this point means the Registry declared the capability but the Adapter has no matching method —
    // exactly what spec §8 calls "startup validation was bypassed"; it must be counted separately (normally 0).
    this.emitCapabilityUnsupported(runtime.chain.id as ChainId, capability, 'method_missing');
    return createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
      requestId: ctx.requestId,
      message: `Chain ${runtime.chain.id} declares ${capability} but has no matching method`,
      chain: runtime.chain.id,
      details: { capability },
    });
  }

  private adapterContext(runtime: ChainRuntime, ctx: CallContext): AdapterContext {
    const manager = this.managerFor(runtime, ctx);
    const adapterCtx: AdapterContext = {
      chain: runtime.chain.id,
      network: runtime.chain.network,
      providers: manager,
      signal: ctx.signal ?? new AbortController().signal,
      requestId: ctx.requestId,
    };
    if (ctx.traceId !== undefined) adapterCtx.traceId = ctx.traceId;
    if (ctx.spanId !== undefined) adapterCtx.spanId = ctx.spanId;
    return adapterCtx;
  }

  private managerFor(runtime: ChainRuntime, ctx: CallContext): ProviderManager {
    if (runtime.manager !== undefined) return runtime.manager;
    const descriptors = this.registry.listProviders(runtime.chain.id);
    if (descriptors.length === 0) {
      throw createDfrError('DFR_CHAIN_UNAVAILABLE', {
        requestId: ctx.requestId,
        message: `Chain ${runtime.chain.id} has no Providers configured`,
        chain: runtime.chain.id,
      });
    }
    const options: ConstructorParameters<typeof ProviderManager>[0] = {
      chain: runtime.chain.id,
      descriptors,
      resolveEndpoint: (d) => this.registry.resolveEndpoint(d),
      resolveCredential: (d) => this.registry.resolveCredential(d),
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.options.random !== undefined ? { random: this.options.random } : {}),
      ...(this.options.onProviderCall !== undefined ? { onCall: this.options.onProviderCall } : {}),
      ...(this.options.providerQuotaStore !== undefined
        ? { quotaStore: this.options.providerQuotaStore }
        : {}),
    };
    const manager = new ProviderManager(options);
    runtime.manager = manager;
    return manager;
  }

  private normalize(err: unknown, ctx: CallContext, chainId: string): Error {
    if (err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
      return err;
    }
    return toDfrError(err, { requestId: ctx.requestId, chain: chainId as ChainId });
  }

}

/** Get an error code's classification (error-spec metadata); unknown codes return undefined — never guess. */
function categoryOf(errorCode: string | undefined): ErrorMetadata['category'] | undefined {
  if (errorCode === undefined) return undefined;
  if (!isKnownErrorCode(errorCode)) return undefined;
  return ERROR_METADATA[errorCode].category;
}

/**
 * The Adapter methods' read/write classification (the observability-spec §5.3 `method_class`).
 *
 * Only `broadcast` changes on-chain state. `build` / `simulate` are construction or read-only probing,
 * and counting them as writes would inflate write-path metrics and make the "write operation" signal meaningless.
 */
function adapterMethodClass(method: string): 'read' | 'write' {
  return method === 'broadcast' ? 'write' : 'read';
}
