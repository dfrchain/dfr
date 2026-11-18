/** The Gateway process's single outer composition root (ADR-017). */
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { EvmAdapter } from '@dfr/adapter-evm';
import { SolanaAdapter } from '@dfr/adapter-solana';
import { DfrCore, type TransactionStores } from '@dfr/core';
import { ChainRegistry } from '@dfr/registry';
import { createPostgresTransactionRuntime } from '@dfr/storage-postgres';
import {
  RecoveryCoordinator,
  RecoveryScheduler,
  ReorgReconciler,
  ReorgScheduler,
  TransactionEngine,
  TransactionMetrics,
  observeStores,
  tagStoreName,
} from '@dfr/transaction';
import { CAPABILITY_IDS, type CapabilityId, type ChainId, type EventType, type Milestone, type ProviderQuotaStore } from '@dfr/types';
import type { StaticApiKeyConfig } from './auth.js';
import { createGatewayServer } from './server.js';
import { createCoreTransactionChainPort } from './transaction-port.js';
import { createProviderCallLogger } from './provider-call-log.js';
import { createAdapterCallLogger } from './adapter-call-log.js';
import { createStoreCallLogger } from './store-call-log.js';
import { createCoreOperationLogger } from './core-operation-log.js';
import { GatewayMetrics } from './gateway-metrics.js';
import { GatewayIdempotencyCoordinator } from './idempotency.js';
import { SseTicketStore } from './sse-ticket.js';
import { EventBus } from '@dfr/events';
import { AdapterMetrics, CoreMetrics, ProviderMetrics } from './layer-metrics.js';
import { createSpanEmitters } from './span-emitter.js';

export interface GatewayPersistence {
  readonly stores: TransactionStores;
  /** E5: durable pre-claim port for the Provider daily quota; when unavailable, the Provider path fails closed. */
  readonly providerQuotaStore?: ProviderQuotaStore;
  /** Dependency readiness probe (DFR-M1-E02): lets `/readyz` judge whether the transaction store is still reachable. */
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

export interface GatewayRuntime {
  readonly milestone: Milestone;
  readonly allowWrite: boolean;
  readonly persistence?: GatewayPersistence;
}

export type GatewayPersistenceFactory = (databaseUrl: string) => Promise<GatewayPersistence>;

/**
 * Transaction state → `tx.*` event type (the mapping table in transaction-lifecycle chapter 6).
 *
 * Why it lives in the composition root: `@dfr/transaction` does not depend on `@dfr/events`
 * (module boundaries only allow leaf utility packages), and event types belong to the **outward-facing** event contract,
 * so the outer layer translates "state facts" into "event types".
 *
 * `unknown` has no corresponding event (the spec's event table has no `tx.unknown`): it only means
 * "the broadcast outcome is uncertain", not a state change that can be promised externally.
 */
export function statusToEventType(status: string): EventType | undefined {
  switch (status) {
    case 'built': return 'tx.built';
    case 'simulated': return 'tx.simulated';
    case 'signed': return 'tx.signed';
    case 'broadcast': return 'tx.broadcast';
    case 'pending': return 'tx.pending';
    case 'included': return 'tx.included';
    case 'confirmed': return 'tx.confirmed';
    case 'finalized': return 'tx.finalized';
    case 'failed': return 'tx.failed';
    case 'reverted': return 'tx.reverted';
    case 'dropped': return 'tx.dropped';
    case 'replaced': return 'tx.replaced';
    default: return undefined;
  }
}

/** B30 / NEW-01: the production composition root must use configured API-key
 *  scopes, not hardcode wildcard chains/capabilities. Unknown values abort
 *  startup rather than silently widening authorization.
 */
export function gatewayApiKeyScopeFromEnv(
  env: NodeJS.ProcessEnv,
  registry: Pick<ChainRegistry, 'hasChain'>,
  allowWrite: boolean,
): StaticApiKeyConfig['scope'] {
  const parseList = (name: string): string[] | '*' => {
    const raw = env[name];
    if (raw === undefined) return '*'; // Historical unscoped deployments remain explicit wildcard.
    if (raw === '*') return '*';
    const entries = raw.split(',').map((value) => value.trim());
    if (entries.some((value) => value === '' || value === '*') || new Set(entries).size !== entries.length) {
      throw new GatewayStartupError(`${name} must contain unique non-empty entries or exactly '*'`);
    }
    return entries;
  };
  // A write-enabled Gateway must opt into its authorization boundary. Wildcards
  // remain supported only when an operator deliberately spells them out.
  // In particular, an omitted env var must not silently grant write access
  // across all chains and capabilities in production.
  if (allowWrite && (env['DFR_M0_SCOPE_CHAINS'] === undefined || env['DFR_M0_SCOPE_CAPABILITIES'] === undefined)) {
    throw new GatewayStartupError('DFR_M0_SCOPE_CHAINS and DFR_M0_SCOPE_CAPABILITIES are required for write-enabled Gateway');
  }
  const chains = parseList('DFR_M0_SCOPE_CHAINS');
  if (chains !== '*' && chains.some((chain) => !registry.hasChain(chain))) {
    throw new GatewayStartupError('DFR_M0_SCOPE_CHAINS references an unknown registry chain');
  }
  const capabilities = parseList('DFR_M0_SCOPE_CAPABILITIES');
  if (capabilities !== '*' && capabilities.some((capability) => !CAPABILITY_IDS.includes(capability as CapabilityId))) {
    throw new GatewayStartupError('DFR_M0_SCOPE_CAPABILITIES contains an unsupported capability');
  }
  const ips = env['DFR_M0_IP_ALLOWLIST'];
  let ipAllowlist: string[] | undefined;
  if (ips !== undefined) {
    ipAllowlist = ips.split(',').map((value) => value.trim());
    if (ipAllowlist.some((ip) => isIP(ip) === 0) || new Set(ipAllowlist).size !== ipAllowlist.length) {
      throw new GatewayStartupError('DFR_M0_IP_ALLOWLIST must contain unique IP addresses');
    }
  }
  return {
    chains: chains === '*' ? '*' : chains as ChainId[],
    capabilities: capabilities === '*' ? '*' : capabilities as CapabilityId[],
    allowWrite,
    ...(ipAllowlist === undefined ? {} : { ipAllowlist }),
  };
}

/** Trusted-proxy address list (ADR-029): comma-separated; empty means no forwarded headers are trusted. */
export function trustedProxiesFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env['DFR_TRUSTED_PROXIES'];
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
}

export class GatewayStartupError extends Error {
  override readonly name = 'GatewayStartupError';
}

const defaultPersistenceFactory: GatewayPersistenceFactory = async (databaseUrl) => {
  const runtime = await createPostgresTransactionRuntime({
    databaseUrl,
    onPoolError: () => {
      // Fixed message: pg's raw error may contain a connection string; only report "idle connection lost" here.
      process.stderr.write(
        `${JSON.stringify({ level: 'error', msg: 'transaction database connection lost' })}\n`,
      );
    },
  });
  return {
    stores: runtime.stores,
    providerQuotaStore: runtime.stores.providerQuota,
    healthCheck: () => runtime.healthCheck(),
    close: () => runtime.close(),
  };
};

/** Complete DB readiness before opening the write scope; errors do not propagate driver exceptions or the DSN. */
export async function resolveGatewayRuntime(
  env: NodeJS.ProcessEnv,
  createPersistence: GatewayPersistenceFactory = defaultPersistenceFactory,
): Promise<GatewayRuntime> {
  const writeFlag = optionalEnv(env, 'DFR_M1_ALLOW_WRITE');
  if (writeFlag !== undefined && writeFlag !== 'true' && writeFlag !== 'false') {
    throw new GatewayStartupError('DFR_M1_ALLOW_WRITE must be exactly true or false');
  }
  // ADR-038: the runtime milestone is decided by an explicit deployment switch; when unset, historical behavior is kept (the write switch decides M0/M1).
  // It only affects which chains Core loads, not write permissions; write permissions are still decided only by DFR_M1_ALLOW_WRITE + Key scope.
  const requestedMilestone = parseDeployMilestone(env);
  const writeEnabled = writeFlag === 'true';
  if (!writeEnabled) {
    // fail-closed: a milestone requiring the transaction engine may not be declared when the write path is not open.
    if (requestedMilestone !== undefined && milestoneRank(requestedMilestone) > milestoneRank('M0')) {
      throw new GatewayStartupError(
        'DFR_DEPLOY_MILESTONE above M0 requires DFR_M1_ALLOW_WRITE=true',
      );
    }
    return { milestone: 'M0', allowWrite: false };
  }

  const databaseUrl = optionalEnv(env, 'DFR_TRANSACTION_DATABASE_URL');
  if (databaseUrl === undefined) {
    throw new GatewayStartupError(
      'DFR_TRANSACTION_DATABASE_URL is required when DFR_M1_ALLOW_WRITE=true',
    );
  }

  try {
    const persistence = await createPersistence(databaseUrl);
    assertCompleteStores(persistence.stores);
    return { milestone: requestedMilestone ?? 'M1', allowWrite: true, persistence };
  } catch {
    throw new GatewayStartupError('M1 transaction database is unavailable');
  }
}

const MILESTONE_ORDER: readonly Milestone[] = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];

function milestoneRank(milestone: Milestone): number {
  return MILESTONE_ORDER.indexOf(milestone);
}

/** Parse `DFR_DEPLOY_MILESTONE` (ADR-038): illegal values fail closed, never silently degrade. */
function parseDeployMilestone(env: NodeJS.ProcessEnv): Milestone | undefined {
  const raw = optionalEnv(env, 'DFR_DEPLOY_MILESTONE');
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!MILESTONE_ORDER.includes(value as Milestone)) {
    throw new GatewayStartupError('DFR_DEPLOY_MILESTONE must be one of M0..M7');
  }
  return value as Milestone;
}

function assertCompleteStores(stores: TransactionStores): void {
  if (
    stores.transaction === undefined ||
    stores.idempotency === undefined ||
    stores.nonce === undefined ||
    stores.tracker === undefined
  ) {
    throw new GatewayStartupError('M1 persistent transaction stores are incomplete');
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env, name);
  if (value === undefined) {
    throw new GatewayStartupError(`Missing required environment variable ${name}`);
  }
  return value;
}

/** keyId must be exactly 8 [A-Za-z0-9] characters (matching the Key-parsing regex in `auth.ts`). */
function assertApiKeyId(value: string, name: string): void {
  if (!/^[A-Za-z0-9]{8}$/u.test(value)) {
    throw new GatewayStartupError(`${name} must be exactly 8 alphanumeric characters`);
  }
}

/** hash must be 64 hex characters with no prefix, matching the output shape of `hashSecret`. */
function assertApiKeyHash(value: string, name: string): void {
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new GatewayStartupError(`${name} must be 64 hexadecimal characters without 0x prefix`);
  }
}

/**
 * Read a boolean environment variable (accepts only exact `true` / `false`; fail-closed).
 *
 * Same convention as `DFR_M1_ALLOW_WRITE`: a misspelled value must not be treated as "unset" and silently degraded —
 * that would make operators think a switch is in effect when it is not.
 */
function optionalBoolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return fallback;
  if (raw !== 'true' && raw !== 'false') {
    throw new GatewayStartupError(`${name} must be exactly true or false`);
  }
  return raw === 'true';
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Read an integer environment variable (DFR-M1-E02/D04 scheduling).
 *
 * fail-closed: a non-integer or out-of-range value throws `GatewayStartupError` directly instead of silently taking a default —
 * if a mistyped sweep interval were silently swallowed, operators would think the sweep is running while it actually uses a different value.
 */
function optionalIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  bounds: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  const raw = optionalEnv(env, name);
  if (raw === undefined) return bounds.fallback;
  if (!/^[0-9]+$/u.test(raw)) {
    throw new GatewayStartupError(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw new GatewayStartupError(`${name} must be an integer in ${bounds.min}..${bounds.max}`);
  }
  return value;
}

export async function startGateway(
  env: NodeJS.ProcessEnv = process.env,
  createPersistence: GatewayPersistenceFactory = defaultPersistenceFactory,
): Promise<{
  close(): Promise<void>;
  /** Actually bound port; when `DFR_GATEWAY_PORT=0` it is the kernel-assigned ephemeral port, for health checks and tests. */
  port: number;
}> {
  const runtime = await resolveGatewayRuntime(env, createPersistence);
  let core: DfrCore | undefined;
  try {
    const registryFile = optionalEnv(env, 'DFR_REGISTRY_FILE');
    const registry = ChainRegistry.load(
      registryFile !== undefined ? { file: registryFile, env } : { env },
    );
    // E6 (M5 production hardening): export the four layers of observability records as **real spans** (independent spanIds + parent references).
    // opt-in: off by default means behavior is unchanged (existing deployments without a Trace backend should not see stdout double).
    const spanEmitters = optionalBoolEnv(env, 'DFR_OTLP_SPANS', false) ? createSpanEmitters() : undefined;
    core = new DfrCore({
      registry,
      adapters: [
        { id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) },
        // M2-A03: Solana Adapter (read-only: account.balance / block.read).
        // Capabilities the registry does not declare are guaranteed fail-closed jointly by startup validation (registry ⊆ adapter) and Core's capability gate.
        { id: 'solana', version: '0.1.0', create: (chain) => new SolanaAdapter({ chain }) },
      ],
      milestone: runtime.milestone,
      // Provider call structured logging (observability-spec sections 3/7).
      // Fields pass through provider-call-log.ts's allowlist filter — the records never contained endpoints/credentials anyway,
      // and the allowlist prevents future fields from silently entering logs.
      onProviderCall: (record) => {
        // One record feeds two consumers: the redacted log + the §5.4 counters.
        createProviderCallLogger((line) => process.stdout.write(line))(record);
        providerMetrics.recordCall(record);
        spanEmitters?.providerRequest?.(record);
      },
      // Adapter call logging (observability-spec chapter 4 span layer adapter.call).
      onAdapterCall: (record) => {
        createAdapterCallLogger((line) => process.stdout.write(line))(record);
        adapterMetrics.recordCall(record);
        spanEmitters?.adapterCall?.(record);
      },
      onCoreOperation: (record) => {
        // Feeds two consumers: the §4 core.operation log + the §5.2 Core metrics.
        createCoreOperationLogger((line) => process.stdout.write(line))(record);
        coreMetrics.recordOperation(record);
        spanEmitters?.coreOperation?.(record);
      },
      onCapabilityUnsupported: (input) => {
        // The two sources map to two different counters (see Core's onCapabilityUnsupported docs).
        if (input.kind === 'method_missing') adapterMetrics.recordRegistryMismatch(input.chain);
        else coreMetrics.recordCapabilityUnsupported({ chain: input.chain, capability: input.capability });
      },
      ...(runtime.persistence !== undefined
        ? { transactionStores: runtime.persistence.stores }
        : {}),
      ...(runtime.persistence?.providerQuotaStore !== undefined
        ? { providerQuotaStore: runtime.persistence.providerQuotaStore }
        : {}),
    });

    const previousHash = optionalEnv(env, 'DFR_M0_API_KEY_HASH_PREVIOUS');
    const previousKeyId = optionalEnv(env, 'DFR_M0_API_KEY_ID_PREVIOUS');
    // The configuration reference promises "configuring only half of a paired variable → configuration error". This check was missing before:
    // operators thought the rotation window was in effect, while only the current Key actually worked and old clients got a straight 401.
    // The error contains only variable names, no Key values.
    if ((previousHash === undefined) !== (previousKeyId === undefined)) {
      throw new GatewayStartupError(
        'DFR_M0_API_KEY_ID_PREVIOUS and DFR_M0_API_KEY_HASH_PREVIOUS must be configured together',
      );
    }
    // The configuration reference promises: an illegal keyId / hash format → configuration error. This check was missing before,
    // so an operator could mistype a length, a non-hex value, or a 0x prefix and still start, only discovering it when requests got 401.
    const currentKeyId = requireEnv(env, 'DFR_M0_API_KEY_ID');
    const currentHash = requireEnv(env, 'DFR_M0_API_KEY_HASH');
    assertApiKeyId(currentKeyId, 'DFR_M0_API_KEY_ID');
    assertApiKeyHash(currentHash, 'DFR_M0_API_KEY_HASH');
    if (previousKeyId !== undefined) {
      assertApiKeyId(previousKeyId, 'DFR_M0_API_KEY_ID_PREVIOUS');
      assertApiKeyHash(previousHash as string, 'DFR_M0_API_KEY_HASH_PREVIOUS');
    }
    const auth: StaticApiKeyConfig = {
      keyId: currentKeyId,
      currentHash,
      ...(previousHash !== undefined ? { previousHash } : {}),
      ...(previousKeyId !== undefined ? { previousKeyId } : {}),
      pepper: env['DFR_M0_API_KEY_PEPPER'] ?? '',
      projectId: env['DFR_M0_PROJECT_ID'] ?? 'default',
      scope: gatewayApiKeyScopeFromEnv(env, registry, runtime.allowWrite),
    };
    // M1 write path: the transaction engine is only assembled when the deployment switch is on and persistence is ready (fail-closed).
    // The engine's chain access is injected via `TransactionChainPort` (AGENTS.md section 3 dependency direction).
    const persistence = runtime.persistence;
    // In-process low-cardinality transaction metrics: both the `/metrics` data source and the sink for engine stages / leases / reorgs.
    // They reset on process restart — M1 does not accept metrics as durable facts (durable facts are transaction records and events).
    const metrics = new TransactionMetrics();
    // Store call observability (observability-spec chapter 4 store.read / store.write).
    // The same outlet feeds logs and spans (isomorphic to the Core/Adapter/Provider layers).
    const storeCallLogger = createStoreCallLogger((line) => process.stdout.write(line));
    const onStoreCall: (record: Parameters<typeof storeCallLogger>[0]) => void = (record) => {
      storeCallLogger(record);
      spanEmitters?.storeCall?.(record);
    };
    // Gateway HTTP metrics (§5.1): request volume / latency / auth failures / rate limiting / idempotency / in-flight.
    const gatewayMetrics = new GatewayMetrics();
    // §5.2 / §5.3 / §5.4: Core / Adapter / Provider metrics.
    const coreMetrics = new CoreMetrics();
    const adapterMetrics = new AdapterMetrics();
    const providerMetrics = new ProviderMetrics();
    // Gateway-level idempotency (TODO-013): only assembled when a durable Store exists.
    // Not assembled without a Store → broadcast has no replay guarantee (explicit behavior, not silent degradation).
    const idempotencyCoordinator =
      persistence !== undefined
        ? new GatewayIdempotencyCoordinator(persistence.stores.idempotency)
        : undefined;
    // D04 sweep cadence (optional environment variables; defaults 5 minutes / 100 rows per round).
    const reorgIntervalMs = optionalIntEnv(env, 'DFR_REORG_SWEEP_INTERVAL_MS', {
      min: 1_000,
      max: 24 * 60 * 60_000,
      fallback: 5 * 60_000,
    });
    const reorgBatchLimit = optionalIntEnv(env, 'DFR_REORG_SWEEP_BATCH', {
      min: 1,
      max: 500,
      fallback: 100,
    });
    // D03 recovery sweep cadence (optional environment variables; default 10 minutes).
    // `DFR_RECOVERY_BATCH_SIZE` was previously only registered in configuration-reference as "reserved,
    // not read by code"; here it is actually wired up (startup recovery and periodic recovery share the same cap).
    const recoveryIntervalMs = optionalIntEnv(env, 'DFR_RECOVERY_SWEEP_INTERVAL_MS', {
      min: 1_000,
      max: 24 * 60 * 60_000,
      fallback: 10 * 60_000,
    });
    const recoveryBatchLimit = optionalIntEnv(env, 'DFR_RECOVERY_BATCH_SIZE', {
      min: 1,
      max: 500,
      fallback: 100,
    });

    // ADR-037 option C: built/simulated records that have not advanced for this long are auto-voided (milliseconds).
    // Default 30 minutes; explicitly setting 0 **disables** the sweep (not "void immediately").
    const abandonBuiltAfterRaw = optionalIntEnv(env, 'DFR_ABANDON_BUILT_AFTER_MS', {
      min: 0,
      max: 7 * 24 * 60 * 60_000,
      fallback: 30 * 60_000,
    });
    // Zero is the explicit off switch; short positive intervals are unsafe
    // and must fail at startup rather than crashing a later recovery sweep.
    if (abandonBuiltAfterRaw !== 0 && abandonBuiltAfterRaw < 60_000) {
      throw new GatewayStartupError('DFR_ABANDON_BUILT_AFTER_MS must be 0 or 60000..604800000');
    }
    const abandonBuiltAfterMs = abandonBuiltAfterRaw === 0 ? undefined : abandonBuiltAfterRaw;
    // ADR-023: unknown silently times out as dropped, plus a bounded observation grace window for dropped.
    const dropTimeoutMs = optionalIntEnv(env, 'DFR_DROP_TIMEOUT_MS', {
      min: 60_000,
      max: 86_400_000,
      fallback: 30 * 60_000,
    });
    const droppedGraceMs = optionalIntEnv(env, 'DFR_DROPPED_GRACE_MS', {
      min: 3_600_000,
      max: 604_800_000,
      fallback: 6 * 60 * 60_000,
    });
    // Readiness active probing (opt-in, off by default): once enabled, /readyz probes a Provider on the spot.
    const readyActiveProbe = optionalBoolEnv(env, 'DFR_READY_ACTIVE_PROBE', false);
    const readyProbeTimeoutMs = optionalIntEnv(env, 'DFR_READY_PROBE_TIMEOUT_MS', {
      min: 1,
      max: 5_000,
      fallback: 2_000,
    });
    const readyProbeCacheMs = optionalIntEnv(env, 'DFR_READY_PROBE_CACHE_MS', {
      min: 0,
      max: 300_000,
      fallback: 5_000,
    });
    // Background sweeps (reorg/recovery) use the Store ports directly, not through the engine's wrapper; they are wrapped separately here
    // so their store calls also produce observability records (background paths have no request context, so records carry no request_id).
    const observedStores =
      persistence !== undefined
        ? {
            transaction: observeStores(
              tagStoreName(persistence.stores.transaction, 'transaction'),
              onStoreCall,
            ),
            idempotency: observeStores(
              tagStoreName(persistence.stores.idempotency, 'idempotency'),
              onStoreCall,
            ),
            nonce: observeStores(tagStoreName(persistence.stores.nonce, 'nonce'), onStoreCall),
            ...(persistence.stores.sequencing !== undefined
              ? {
                  sequencing: observeStores(
                    tagStoreName(persistence.stores.sequencing, 'sequencing'),
                    onStoreCall,
                  ),
                }
              : {}),
            tracker: observeStores(tagStoreName(persistence.stores.tracker, 'tracker'), onStoreCall),
          }
        : undefined;

    // In-process event bus (M2-C01/C03). **A single instance**: both the data source for SSE subscriptions
    // and the publish target for transaction state events (tx.*) and background sweeps (chain.reorg).
    // Cursors are only valid in this process (ADR-006). It must be constructed before the engine — the engine's onTransition uses it.
    const eventBus = new EventBus();

    const transactions =
      runtime.allowWrite && persistence !== undefined
        ? new TransactionEngine({
            stores: {
              transaction: persistence.stores.transaction,
              idempotency: persistence.stores.idempotency,
              nonce: persistence.stores.nonce,
              // M3-B03 (ADR-033): Solana blockhash sequencing leases. EVM records never write this table;
              // the engine dispatches by token.kind, so assembling it here as well does not affect EVM behavior.
              ...(persistence.stores.sequencing !== undefined
                ? { sequencing: persistence.stores.sequencing }
                : {}),
              tracker: persistence.stores.tracker,
            },
            chain: createCoreTransactionChainPort(core),
            metrics,
            onStoreCall,
            // unknown is only judged dropped after silently exceeding this duration with an absent observation (ADR-023).
            dropTimeoutMs,
            // State-event outlet: map committed transitions to `tx.*` and publish them to the bus.
            // The mapping is decided by statusToEventType; unknown states are silently skipped (better to send fewer than to send the wrong type).
            onTransition: (record) => {
              const type = statusToEventType(record.toStatus);
              if (type === undefined) return;
              try {
                eventBus.publish({
                  type,
                  chain: record.chain,
                  txRef: { kind: 'hash', hash: record.txHash ?? record.transactionId },
                  payload: { status: record.toStatus },
                });
              } catch {
                // Event delivery failures must not affect state transitions (the engine side has a layer of protection too).
              }
            },
          })
        : undefined;

    // D04 standing reorg sweep (closes a release blocker: ReorgReconciler previously had only components, no scheduling).
    // Only assembled in M1 (with a durable Store); M0 read-only deployments have no included records and need no sweep.
    //
    // Cursor ownership is at the **process level**: the reconciler must reuse the same instance across sweep rounds.
    // `ReorgReconciler.cursor` is an instance field; if a new one were created each round, the cursor would restart from 1 every round,
    // violating ADR-006's monotonic-increase promise for `ChainEvent.cursor` (downstream replay by cursor would duplicate).
    const reorgReconciler =
      runtime.allowWrite && persistence !== undefined
        ? new ReorgReconciler({
            transactions: observedStores!.transaction,
            leases: observedStores!.tracker,
            metrics,
            // Read-only observation: read the current canonical block hash by the height-style blockRef in the record.
            canonicalBlockHash: async ({ chain, blockRef }) => {
              const block = await core!.getBlock(chain as never, blockRef, {
                requestId: randomUUID() as never,
                signal: new AbortController().signal,
              });
              return block?.hash ?? null;
            },
            // Event sink: **dual write** — structured log (visible to operations) + in-process bus (reachable by SSE subscribers).
            //
            // Order: log first, then bus. Logs are written locally and synchronously; bus delivery may trigger subscriber callbacks.
            // Neither should fail the sweep, so bus publishing is wrapped in try (publish exceptions must not interrupt the sweep).
            publish: (event) => {
              process.stdout.write(
                `${JSON.stringify({
                  level: 'warn',
                  msg: 'chain.reorg',
                  eventId: event.eventId,
                  cursor: event.cursor,
                  chain: event.chain,
                  oldBlockHash: event.payload.oldBlockRef.kind === 'hash' ? event.payload.oldBlockRef.hash : undefined,
                  newBlockHash: event.payload.newBlockRef.kind === 'hash' ? event.payload.newBlockRef.hash : undefined,
                  affectedTransactions: event.payload.affectedTransactions,
                })}\n`,
              );
              try {
                // ReorgReconciler allocates its own cursor (monotonic in-process). The bus **re-allocates**
                // its own scoped cursor — the two serve different purposes: the former is the sweep's view, the latter the subscription's view.
                eventBus.publish({
                  type: 'chain.reorg',
                  chain: event.chain,
                  payload: event.payload,
                  ...(event.blockRef !== undefined ? { blockRef: event.blockRef } : {}),
                });
              } catch {
                // Event delivery failures must not affect the reorg rollback business outcome.
              }
            },
            ownerToken: randomUUID,
          })
        : undefined;

    const reorgScheduler =
      reorgReconciler !== undefined
        ? new ReorgScheduler({
            reconcile: async ({ limit }) => await reorgReconciler.run({ limit }),
            intervalMs: reorgIntervalMs,
            batchLimit: reorgBatchLimit,
            onError: () => {
              // Fixed message: sweep failures may come from RPC / the database, and raw exception text may contain internal addresses.
              process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'reorg sweep failed' })}\n`);
            },
          })
        : undefined;

    // D03 recovery: run one round at startup, and assemble the periodic sweep.
    // Recovery previously ran only at startup, so long-lived instances never reclaimed expired idempotency records or orphaned nonce leases
    // (the residual gap recorded in TODO-009). Both share the same bounded `run({ limit })`.
    const recoveryScheduler =
      transactions !== undefined && persistence !== undefined
        ? new RecoveryScheduler({
            recover: async ({ limit }) => {
              const coordinator = new RecoveryCoordinator({
                transactions: observedStores!.transaction,
                idempotency: observedStores!.idempotency,
                nonce: observedStores!.nonce,
                ...(observedStores!.sequencing !== undefined
                  ? { sequencing: observedStores!.sequencing }
                  : {}),
                trackerLeases: observedStores!.tracker,
                resolveUnknown: async (transactionId) => {
                  await transactions.resolveIndeterminate({ transactionId });
                },
                ownerToken: randomUUID,
                // dropped keeps being observed only within that grace window (ADR-023).
                droppedGraceMs,
                // ADR-037 option C: **fallback** auto-voiding of built/simulated records that have not advanced for a long time.
                // Option A's explicit abandon only works when the caller remembers; crashes / interruptions / forgetfulness self-heal here.
                ...(abandonBuiltAfterMs !== undefined ? { abandonBuiltAfterMs } : {}),
              });
              // First resolve unknown (including timeout-judged dropped), then apply convergence correction to dropped rows inside the window,
              // and finally void built/simulated records that have not advanced for a long time (ADR-037 option C).
              const recovered = await coordinator.run({ limit });
              // TX-02: process crashes after persisting 'signed' must not strand
              // a transaction indefinitely. No raw signed payload is persisted:
              // do NOT retry broadcast or release its nonce; move stale EVM
              // records into the existing read-only unknown recovery path.
              const signedRecovered = await coordinator.recoverStaleSigned({
                limit,
                staleAfterMs: 5 * 60_000,
              });
              const corrected = await coordinator.reconcileDropped({ limit });
              const abandoned = await coordinator.abandonStaleUnbroadcast({ limit });
              return recovered + signedRecovered + corrected + abandoned;
            },
            intervalMs: recoveryIntervalMs,
            batchLimit: recoveryBatchLimit,
            onError: () => {
              // Fixed message: recovery failures may come from the database, and raw exception text may contain a DSN.
              process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'recovery sweep failed' })}\n`);
            },
          })
        : undefined;

    if (recoveryScheduler !== undefined) {
      // Startup round: complete one recovery pass before listening, so "can accept traffic" means "the recovery scan has run".
      await recoveryScheduler.tick();
    }

    // Consistent with other integer configs: illegal values fail closed before listening, naming the variable.
    // Previously a direct `Number(...)` exposed the error as Node's internal `NaN`, which operators could not locate.
    // 0 is allowed (kernel-assigned ephemeral port, common in containers/tests); anything else must be a decimal integer in 1..65535.
    const port = optionalIntEnv(env, 'DFR_GATEWAY_PORT', {
      min: 0,
      max: 65535,
      fallback: 8787,
    });
    const server = createGatewayServer({
      core,
      auth,
      // Whether the write path is exposed is decided by the composition root (M0 defaults to false, fail-closed).
      allowWrite: runtime.allowWrite,
      ...(transactions !== undefined ? { transactions } : {}),
      transactionMetrics: metrics,
      gatewayMetrics,
      ...(idempotencyCoordinator !== undefined ? { idempotency: idempotencyCoordinator } : {}),
      // SSE single-use tickets (M2-C02): stored in-process, never persisted or written to disk; reclaimed when the TTL expires.
      sseTickets: new SseTicketStore(),
      // Reuses the single instance above: SSE subscribers can therefore receive events published by background sweeps.
      eventBus,
      // ADR-029 point 5: an empty trusted-proxy list → X-Forwarded-For is not trusted.
      trustedProxies: trustedProxiesFromEnv(env),
      coreMetrics,
      adapterMetrics,
      providerMetrics,
      // In M1 with a transaction store, /readyz must reflect whether the database is still reachable;
      // probe failures only affect readiness, not liveness (/healthz stays 200).
      ...(persistence !== undefined ? { readyCheck: () => persistence.healthCheck() } : {}),
      ...(readyActiveProbe
        ? {
            readyProbe: () =>
              core!.probeReadiness({
                timeoutMs: readyProbeTimeoutMs,
                cacheMs: readyProbeCacheMs,
              }),
          }
        : {}),
      logger: {
        info: (fields) => process.stdout.write(`${JSON.stringify({ level: 'info', ...fields })}\n`),
        warn: (fields) => process.stderr.write(`${JSON.stringify({ level: 'warn', ...fields })}\n`),
        error: (fields) => process.stderr.write(`${JSON.stringify({ level: 'error', ...fields })}\n`),
      },
    });
    const health = core.startHealthChecks();

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, resolve);
    });
    const bound = server.address();
    const boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
    reorgScheduler?.start();
    recoveryScheduler?.start();

    // §5.4 gauges are "current state" and only need low-frequency sweep refreshes (not per-request writes).
    // Reusing the recovery sweep's cadence would lag gauges at 10-minute granularity; an independent timer (default 15s)
    // keeps gauges fresh enough at negligible cost (a read-only memory snapshot, no network).
    const refreshProviderGauges = (): void => {
      // `core` is assigned inside the try block; this point is after a successful listen, so it necessarily exists.
      const liveCore = core;
      if (liveCore === undefined) return;
      try {
        // E5: use an async snapshot so quota_used_ratio reads the durable Store (accurate across instances / restarts);
        // other gauges are still refreshed by the same snapshot, avoiding two different yardsticks.
        void liveCore.providerObservabilityAsync().then((snapshots) => {
          providerMetrics.refreshGauges(snapshots);
        }).catch(() => {
          // Observability is best-effort: a temporarily unavailable Store must not affect service.
        });
      } catch {
        // Observability is best-effort: a failed refresh must not affect service.
      }
    };
    const providerGaugeTimer = setInterval(refreshProviderGauges, 15_000);
    providerGaugeTimer.unref?.();
    // Refresh once immediately, so gauges are not empty during the first 15s after startup.
    refreshProviderGauges();

    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        msg: 'dfr gateway listening',
        // It must be the **actually bound** port: when `DFR_GATEWAY_PORT=0` (common in containers/tests),
        // the requested port is always 0, and echoing it in logs would leave operators/probes unable to find the real port.
        port: boundPort,
        milestone: runtime.milestone,
        chains: core.listChains().map((chain) => chain.id),
        healthChecksStarted: health.started,
        healthChecksSkipped: health.skipped,
        keyFingerprint: createHash('sha256').update(auth.currentHash).digest('hex').slice(0, 8),
      })}\n`,
    );

    let closed = false;
    return {
      port: boundPort,
      close: async () => {
        if (closed) return;
        closed = true;
        // Stop background sweeps first, to avoid starting another database query while the connection pool is closing.
        clearInterval(providerGaugeTimer);
        recoveryScheduler?.stop();
        reorgScheduler?.stop();
        core?.stopHealthChecks();
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          );
        } finally {
          // Stop accepting and drain HTTP requests first, so a confirm that is finishing
          // does not start a background worker after tracker.close().
          transactions?.close();
          await runtime.persistence?.close();
        }
      },
    };
  } catch (error) {
    core?.stopHealthChecks();
    try {
      await runtime.persistence?.close();
    } catch {
      // The startup cause takes priority; a close failure must not mask the already-redacted original error.
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

export interface ShutdownOptions {
  /** Injection point: the global `process` by default; tests use a stand-in to avoid attaching signal handlers to the test process. */
  readonly process?: Pick<NodeJS.Process, 'on'>;
  /** Injection point: writes `process.exitCode` by default, and calls `process.exit(code)` immediately when non-zero. */
  readonly exit?: (code: number) => void;
  /** Structured log outlet; records only fixed messages, never raw exception text (which may contain a DSN/password). */
  readonly log?: (fields: Record<string, unknown>) => void;
}

/**
 * Wire SIGTERM / SIGINT to `app.close()` (DFR-M1-E02).
 *
 * Why explicit wiring is required: with no handler, Node's default behavior terminates the process immediately, hard-cutting
 * the HTTP requests being drained, the background confirmation loop, and the database connections. After container orchestration sends SIGTERM, it expects
 * a "graceful shutdown", not an "immediate kill".
 *
 * Three invariants (locked by apps/gateway/test/shutdown.test.ts):
 * 1. SIGTERM and SIGINT are equivalent, both triggering **one** shutdown;
 * 2. Another signal during shutdown → no concurrent repeat shutdown; force-exit with a non-zero code instead (fallback when stuck);
 * 3. Failed shutdown → non-zero exit code, and logs do not echo raw exception text.
 */
export function installShutdownHandlers(
  app: { close(): Promise<void> },
  options: ShutdownOptions = {},
): void {
  const proc = options.process ?? process;
  const exit =
    options.exit ??
    ((code: number) => {
      process.exitCode = code;
      // A non-zero code means "must exit as soon as possible": the event loop may still hold stuck handles.
      if (code !== 0) process.exit(code);
    });
  const log =
    options.log ??
    ((fields: Record<string, unknown>) => {
      process.stdout.write(`${JSON.stringify({ level: 'info', ...fields })}\n`);
    });

  let shuttingDown = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      log({ level: 'warn', msg: 'shutdown already in progress; forcing exit', signal });
      exit(1);
      return;
    }
    shuttingDown = true;
    log({ level: 'info', msg: 'shutdown signal received', signal });
    app.close().then(
      () => {
        log({ level: 'info', msg: 'shutdown complete' });
        exit(0);
      },
      () => {
        // Only record fixed messages: shutdown failures usually come from the driver layer, and exceptions may carry a DSN.
        log({ level: 'error', msg: 'shutdown failed' });
        exit(1);
      },
    );
  };

  proc.on('SIGTERM', () => handle('SIGTERM'));
  proc.on('SIGINT', () => handle('SIGINT'));
}

if (isMainModule()) {
  void startGateway()
    .then((app) => {
      installShutdownHandlers(app);
    })
    .catch((error: unknown) => {
      const message = error instanceof GatewayStartupError ? error.message : 'Gateway startup failed';
      process.stderr.write(`${JSON.stringify({ level: 'error', msg: message })}\n`);
      process.exitCode = 1;
    });
}
