/** Gateway 进程的唯一外层 composition root（ADR-017）。 */
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
  /** E5：Provider 日配额的持久预占端口；不可用时由 Provider 路径 fail-closed。 */
  readonly providerQuotaStore?: ProviderQuotaStore;
  /** 依赖就绪探针（DFR-M1-E02）：供 `/readyz` 判断事务存储是否仍可达。 */
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
 * 交易状态 → `tx.*` 事件类型（transaction-lifecycle 第 6 章的映射表）。
 *
 * 为什么放在 composition root：`@dfr/transaction` 不依赖 `@dfr/events`
 * （模块边界只允许叶子工具包），事件类型属于**对外的**事件契约，
 * 因此由外层把"状态事实"翻译成"事件类型"。
 *
 * `unknown` 没有对应事件（规范的事件表里没有 `tx.unknown`）：它只表示
 * "广播结果不确定"，不是可对外承诺的状态变化。
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

/** 可信代理地址列表（ADR-029）：逗号分隔；为空表示不信任任何转发头。 */
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
      // 固定文案：pg 的原始错误可能包含连接串；这里只报告"空闲连接丢失"。
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

/** 开放写 scope 前完成 DB readiness，错误不传播驱动异常或 DSN。 */
export async function resolveGatewayRuntime(
  env: NodeJS.ProcessEnv,
  createPersistence: GatewayPersistenceFactory = defaultPersistenceFactory,
): Promise<GatewayRuntime> {
  const writeFlag = optionalEnv(env, 'DFR_M1_ALLOW_WRITE');
  if (writeFlag !== undefined && writeFlag !== 'true' && writeFlag !== 'false') {
    throw new GatewayStartupError('DFR_M1_ALLOW_WRITE must be exactly true or false');
  }
  // ADR-038：运行时里程碑由显式部署开关决定，缺省时保持历史行为（写开关决定 M0/M1）。
  // 它只影响 Core 加载哪些链，不改变写权限；写权限仍只由 DFR_M1_ALLOW_WRITE + Key scope 决定。
  const requestedMilestone = parseDeployMilestone(env);
  const writeEnabled = writeFlag === 'true';
  if (!writeEnabled) {
    // fail-closed：未开放写路径时不允许声明需要交易引擎的里程碑。
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

/** 解析 `DFR_DEPLOY_MILESTONE`（ADR-038）：非法值 fail-closed，不静默降级。 */
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

/** keyId 必须是恰好 8 位 [A-Za-z0-9]（与 `auth.ts` 的 Key 解析正则一致）。 */
function assertApiKeyId(value: string, name: string): void {
  if (!/^[A-Za-z0-9]{8}$/u.test(value)) {
    throw new GatewayStartupError(`${name} must be exactly 8 alphanumeric characters`);
  }
}

/** hash 必须是无前缀的 64 位 hex，与 `hashSecret` 的输出形状一致。 */
function assertApiKeyHash(value: string, name: string): void {
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new GatewayStartupError(`${name} must be 64 hexadecimal characters without 0x prefix`);
  }
}

/**
 * 读取布尔型环境变量（只接受精确的 `true` / `false`，fail-closed）。
 *
 * 与 `DFR_M1_ALLOW_WRITE` 同一约定：拼错的值不得被当作"未设置"而静默降级——
 * 那会让运维以为某个开关生效了而它其实没有。
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
 * 读取整数型环境变量（DFR-M1-E02/D04 调度）。
 *
 * fail-closed：非整数或越界直接抛 `GatewayStartupError`，不静默取默认值——
 * 一个写错的巡检间隔如果被静默吞掉，运维会以为巡检在跑而它其实用的是别的值。
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
  /** 实际绑定端口；`DFR_GATEWAY_PORT=0` 时为内核分配的临时端口，供健康检查与测试使用。 */
  port: number;
}> {
  const runtime = await resolveGatewayRuntime(env, createPersistence);
  let core: DfrCore | undefined;
  try {
    const registryFile = optionalEnv(env, 'DFR_REGISTRY_FILE');
    const registry = ChainRegistry.load(
      registryFile !== undefined ? { file: registryFile, env } : { env },
    );
    // E6（M5 生产加固）：把四层观测记录导出为**真实 span**（独立 spanId + 父引用）。
    // opt-in：默认关闭即行为不变（既有部署没有 Trace 后端时不该让 stdout 翻倍）。
    const spanEmitters = optionalBoolEnv(env, 'DFR_OTLP_SPANS', false) ? createSpanEmitters() : undefined;
    core = new DfrCore({
      registry,
      adapters: [
        { id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) },
        // M2-A03：Solana Adapter（只读：account.balance / block.read）。
        // 注册表未声明的能力由启动校验（registry ⊆ adapter）与 Core 能力闸门共同保证 fail-closed。
        { id: 'solana', version: '0.1.0', create: (chain) => new SolanaAdapter({ chain }) },
      ],
      milestone: runtime.milestone,
      // Provider 调用结构化日志（observability-spec 第 3/7 节）。
      // 字段经 provider-call-log.ts 的白名单过滤——记录里本就不含端点/凭证，
      // 白名单是为了防止未来新增字段静默入日志。
      onProviderCall: (record) => {
        // 一次记录喂两个消费者：脱敏日志 + §5.4 计数器。
        createProviderCallLogger((line) => process.stdout.write(line))(record);
        providerMetrics.recordCall(record);
        spanEmitters?.providerRequest?.(record);
      },
      // Adapter 调用日志（observability-spec 第 4 章 span 层级 adapter.call）。
      onAdapterCall: (record) => {
        createAdapterCallLogger((line) => process.stdout.write(line))(record);
        adapterMetrics.recordCall(record);
        spanEmitters?.adapterCall?.(record);
      },
      onCoreOperation: (record) => {
        // 喂两个消费者：§4 的 core.operation 日志 + §5.2 的 Core 指标。
        createCoreOperationLogger((line) => process.stdout.write(line))(record);
        coreMetrics.recordOperation(record);
        spanEmitters?.coreOperation?.(record);
      },
      onCapabilityUnsupported: (input) => {
        // 两种来源映射到两个不同计数器（见 Core 的 onCapabilityUnsupported 文档）。
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
    // 配置参考承诺“成对变量只配置一半 → 配置错误”。此前缺这条校验：
    // 运维以为轮换窗口已生效，实际只有 current Key 可用，旧客户端会直接 401。
    // 错误只包含变量名，不包含任何 Key 值。
    if ((previousHash === undefined) !== (previousKeyId === undefined)) {
      throw new GatewayStartupError(
        'DFR_M0_API_KEY_ID_PREVIOUS and DFR_M0_API_KEY_HASH_PREVIOUS must be configured together',
      );
    }
    // 配置参考承诺：keyId / hash 格式非法 → 配置错误。此前缺失该校验，
    // 运营方误填长度、非 hex 或 0x 前缀也能启动，直到请求 401 才发现。
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
    // M1 写路径：只有部署开关打开且持久化就绪时才装配交易引擎（fail-closed）。
    // 引擎的链访问经 `TransactionChainPort` 注入（AGENTS.md 第 3 节依赖方向）。
    const persistence = runtime.persistence;
    // 进程内低基数交易指标：既是 `/metrics` 的数据源，也是引擎阶段/租约/reorg 的汇点。
    // 进程重启即重置——M1 不接受把指标当作持久事实（持久事实是交易记录与事件）。
    const metrics = new TransactionMetrics();
    // Store 调用观测（observability-spec 第 4 章 store.read / store.write）。
    // 同一出口喂日志与 span（与 Core/Adapter/Provider 三层同构）。
    const storeCallLogger = createStoreCallLogger((line) => process.stdout.write(line));
    const onStoreCall: (record: Parameters<typeof storeCallLogger>[0]) => void = (record) => {
      storeCallLogger(record);
      spanEmitters?.storeCall?.(record);
    };
    // Gateway HTTP 指标（§5.1）：请求量/延迟/鉴权失败/限流/幂等/在途。
    const gatewayMetrics = new GatewayMetrics();
    // §5.2 / §5.3 / §5.4：Core / Adapter / Provider 指标。
    const coreMetrics = new CoreMetrics();
    const adapterMetrics = new AdapterMetrics();
    const providerMetrics = new ProviderMetrics();
    // 网关级幂等（TODO-013）：只在有持久化 Store 时装配。
    // 无 Store 时不装配 → 广播没有重放保证（显式行为，非静默降级）。
    const idempotencyCoordinator =
      persistence !== undefined
        ? new GatewayIdempotencyCoordinator(persistence.stores.idempotency)
        : undefined;
    // D04 巡检节奏（可选环境变量，默认 5 分钟 / 单轮 100 条）。
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
    // D03 恢复巡检节奏（可选环境变量，默认 10 分钟）。
    // `DFR_RECOVERY_BATCH_SIZE` 此前只在 configuration-reference 里被登记为"预留、
    // 代码未读取"，这里把它真正接上（启动恢复与周期恢复共用同一上限）。
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

    // ADR-037 方案 C：built/simulated 多久没推进就自动作废（毫秒）。
    // 默认 30 分钟；显式设为 0 表示**关闭**该巡检（不是"立即作废"）。
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
    // ADR-023：unknown 静默超时判 dropped，以及 dropped 的有界观测宽限窗。
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
    // 就绪主动探测（opt-in，默认关闭）：开启后 /readyz 会当场探一次 Provider。
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
    // 后台巡检（重组/恢复）直接使用 Store 端口，不经引擎的包装；这里单独包一层，
    // 让它们的 store 调用同样产生观测记录（后台路径没有 request 上下文，记录里不带 request_id）。
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

    // 进程内事件总线（M2-C01/C03）。**单一实例**：既是 SSE 订阅的数据源，
    // 也是交易状态事件（tx.*）与后台巡检（chain.reorg）的发布目标。
    // cursor 仅本进程有效（ADR-006）。必须在引擎之前构造——引擎的 onTransition 要用它。
    const eventBus = new EventBus();

    const transactions =
      runtime.allowWrite && persistence !== undefined
        ? new TransactionEngine({
            stores: {
              transaction: persistence.stores.transaction,
              idempotency: persistence.stores.idempotency,
              nonce: persistence.stores.nonce,
              // M3-B03（ADR-033）：Solana 的 blockhash 排序租约。EVM 记录不写这张表；
              // 引擎按 token.kind 分派，因此这里一并装配即可，不影响 EVM 行为。
              ...(persistence.stores.sequencing !== undefined
                ? { sequencing: persistence.stores.sequencing }
                : {}),
              tracker: persistence.stores.tracker,
            },
            chain: createCoreTransactionChainPort(core),
            metrics,
            onStoreCall,
            // unknown 静默超过该时长且观测为 absent 才判 dropped（ADR-023）。
            dropTimeoutMs,
            // 状态事件出口：把已提交的迁移映射为 `tx.*` 并发布到总线。
            // 映射由 statusToEventType 决定；未知状态静默跳过（宁可少发，不发错类型）。
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
                // 事件投递失败不得影响状态迁移（引擎侧也有一层保护）。
              }
            },
          })
        : undefined;

    // D04 常驻重组巡检（关闭发布阻塞项：此前 ReorgReconciler 只有组件、无调度）。
    // 只在 M1（有持久化 Store）时装配；M0 只读部署没有 included 记录，无需巡检。
    //
    // 游标所有权在**进程级**：reconciler 必须跨巡检轮次复用同一个实例。
    // `ReorgReconciler.cursor` 是实例字段，若每轮 new 一个，游标每轮都从 1 重新开始，
    // 违反 ADR-006 对 `ChainEvent.cursor` 的单调递增承诺（下游按游标重放会重复）。
    const reorgReconciler =
      runtime.allowWrite && persistence !== undefined
        ? new ReorgReconciler({
            transactions: observedStores!.transaction,
            leases: observedStores!.tracker,
            metrics,
            // 只读观测：按记录里的高度型 blockRef 读当前 canonical 区块哈希。
            canonicalBlockHash: async ({ chain, blockRef }) => {
              const block = await core!.getBlock(chain as never, blockRef, {
                requestId: randomUUID() as never,
                signal: new AbortController().signal,
              });
              return block?.hash ?? null;
            },
            // 事件 sink：**双写**——结构化日志（运维可见）+ 进程内总线（SSE 订阅者可收到）。
            //
            // 顺序：先日志后总线。日志是本地同步写出；总线投递可能触发订阅者回调。
            // 两者都不应让巡检失败，因此总线发布包在 try 里（发布异常不得中断巡检）。
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
                // ReorgReconciler 自己分配了 cursor（进程内单调）。总线会**重新**分配
                // 自己的作用域 cursor——两者用途不同：前者是巡检视角，后者是订阅视角。
                eventBus.publish({
                  type: 'chain.reorg',
                  chain: event.chain,
                  payload: event.payload,
                  ...(event.blockRef !== undefined ? { blockRef: event.blockRef } : {}),
                });
              } catch {
                // 事件投递失败不得影响重组回退这一业务结果。
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
              // 固定文案：巡检失败可能来自 RPC/数据库，异常原文可能含内部地址。
              process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'reorg sweep failed' })}\n`);
            },
          })
        : undefined;

    // D03 恢复：启动时先跑一轮，并装配周期巡检。
    // 此前恢复只在启动时执行，长期不重启的实例永远不会回收过期幂等记录与孤儿 nonce 租约
    // （TODO-009 记录的残余缺口）。两处共用同一个有界 `run({ limit })`。
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
                // dropped 只在该宽限窗内继续被观测（ADR-023）。
                droppedGraceMs,
                // ADR-037 方案 C：**兜底**自动作废长期没推进的 built/simulated 记录。
                // 方案 A 的显式 abandon 只在调用方记得时有效；崩溃/中断/忘记时靠这里自愈。
                ...(abandonBuiltAfterMs !== undefined ? { abandonBuiltAfterMs } : {}),
              });
              // 先解析 unknown（含超时判 dropped），再对窗口内的 dropped 做收敛纠正，
              // 最后作废长期未推进的 built/simulated（ADR-037 方案 C）。
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
              // 固定文案：恢复失败可能来自数据库，异常原文可能含 DSN。
              process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'recovery sweep failed' })}\n`);
            },
          })
        : undefined;

    if (recoveryScheduler !== undefined) {
      // 启动轮：先完成一次恢复再监听端口，保证"能接流量"意味着"恢复扫描已跑过"。
      await recoveryScheduler.tick();
    }

    // 与其他整数型配置一致：非法值在监听前 fail-closed，并点名变量名。
    // 此前直接 `Number(...)`，错误会以 Node 内部信息 `NaN` 暴露，运维无法定位。
    // 允许 0（内核分配临时端口，容器/测试常用）；其余必须是 1..65535 的十进制整数。
    const port = optionalIntEnv(env, 'DFR_GATEWAY_PORT', {
      min: 0,
      max: 65535,
      fallback: 8787,
    });
    const server = createGatewayServer({
      core,
      auth,
      // 写路径是否对外可用由 composition root 决定（M0 默认 false，fail-closed）。
      allowWrite: runtime.allowWrite,
      ...(transactions !== undefined ? { transactions } : {}),
      transactionMetrics: metrics,
      gatewayMetrics,
      ...(idempotencyCoordinator !== undefined ? { idempotency: idempotencyCoordinator } : {}),
      // SSE 一次性票据（M2-C02）：进程内存储，不落库不落盘；TTL 到期即回收。
      sseTickets: new SseTicketStore(),
      // 复用上面的单一实例：SSE 订阅者因此能收到后台巡检发布的事件。
      eventBus,
      // ADR-029 第 5 点：可信代理列表为空 → 不信任 X-Forwarded-For。
      trustedProxies: trustedProxiesFromEnv(env),
      coreMetrics,
      adapterMetrics,
      providerMetrics,
      // M1 有事务存储时，/readyz 必须反映数据库是否仍可达；
      // 探针失败只影响就绪，不影响存活（/healthz 仍 200）。
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

    // §5.4 的 gauge 是"当前状态"，由低频巡检刷新即可（不是每请求写）。
    // 复用恢复巡检的节奏会让 gauge 在 10 分钟粒度上滞后；用独立定时器（默认 15s）
    // 使 gauge 足够新鲜，同时开销可忽略（只读内存快照，不联网）。
    const refreshProviderGauges = (): void => {
      // `core` 在 try 块内被赋值；此处已在监听成功之后，必然存在。
      const liveCore = core;
      if (liveCore === undefined) return;
      try {
        // E5：走异步快照，让 quota_used_ratio 读持久 Store（跨实例 / 重启准确）；
        // 其它 gauge 仍由同一快照刷新，避免出现两套口径。
        void liveCore.providerObservabilityAsync().then((snapshots) => {
          providerMetrics.refreshGauges(snapshots);
        }).catch(() => {
          // 观测是尽力而为：Store 临时不可用不得影响服务。
        });
      } catch {
        // 观测是尽力而为：刷新失败不得影响服务。
      }
    };
    const providerGaugeTimer = setInterval(refreshProviderGauges, 15_000);
    providerGaugeTimer.unref?.();
    // 立即刷一次，避免启动后 15s 内 gauge 为空。
    refreshProviderGauges();

    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        msg: 'dfr gateway listening',
        // 必须是**实际绑定**端口：`DFR_GATEWAY_PORT=0`（容器/测试常见）时，
        // 请求端口恒为 0，日志若回显它会让运维/探针无法找到真实端口。
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
        // 先停后台巡检，避免在关闭连接池的过程中又发起一轮数据库查询。
        clearInterval(providerGaugeTimer);
        recoveryScheduler?.stop();
        reorgScheduler?.stop();
        core?.stopHealthChecks();
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          );
        } finally {
          // 先停止接收并排空 HTTP 请求，避免一个正在完成的 confirm
          // 在 tracker.close() 之后又启动后台 worker。
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
      // 启动原因优先；关闭失败不得覆盖已脱敏的原始错误。
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

export interface ShutdownOptions {
  /** 注入点：默认全局 `process`；测试用替身避免给测试进程挂信号处理器。 */
  readonly process?: Pick<NodeJS.Process, 'on'>;
  /** 注入点：默认写 `process.exitCode`，非 0 时立即 `process.exit(code)`。 */
  readonly exit?: (code: number) => void;
  /** 结构化日志出口；只记录固定文案，绝不带异常原文（可能含 DSN/口令）。 */
  readonly log?: (fields: Record<string, unknown>) => void;
}

/**
 * 把 SIGTERM / SIGINT 接到 `app.close()`（DFR-M1-E02）。
 *
 * 为什么必须显式接线：没有处理器时 Node 的默认行为是立刻终止进程，正在排空的
 * HTTP 请求、后台确认循环与数据库连接都会被硬切断。容器编排发送 SIGTERM 后期望
 * 的是"优雅退出"，不是"立刻 kill"。
 *
 * 三条不变式（由 apps/gateway/test/shutdown.test.ts 锁定）：
 * 1. SIGTERM 与 SIGINT 等价，都触发**一次**关闭；
 * 2. 关闭进行中再收到信号 → 不并发重复关闭，直接以非零码强制退出（卡住时兜底）；
 * 3. 关闭失败 → 非零退出码，且日志不回显异常原文。
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
      // 非零码表示"必须尽快退出"：此时事件循环里可能仍有卡住的句柄。
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
        // 只记固定文案：关闭失败往往来自驱动层，异常里可能带 DSN。
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
