/**
 * DFR API Gateway（DFR-009）。
 *
 * 处理顺序严格按 gateway-spec 第 3 章：
 *   请求 ID → 鉴权 → 限流 → 配额 → 幂等（写操作）→ 契约校验 → 路由 → Core → 归一化
 *
 * 两条不能颠倒的顺序：
 * - 鉴权先于限流：否则无效凭证可绕过限流；
 * - 幂等先于契约校验：否则重放请求可因结构差异绕过幂等。
 *
 * 用 node:http 实现，不引入 Web 框架：M0 只有 5 条只读路由，
 * 少一个依赖就少一份供应链风险。
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createDfrError, errorHeaders, isDfrError, resolveRequestId, toDfrError, toErrorResponse } from '@dfr/errors';
import type { CoreReadiness, DfrCore } from '@dfr/core';
import type { TransactionEngine, TransactionMetrics } from '@dfr/transaction';
import type { GatewayMetrics, GatewayRouteClass, IdempotencyOutcome } from './gateway-metrics.js';
import type { GatewayIdempotencyCoordinator } from './idempotency.js';
import type { AdapterMetrics, CoreMetrics, ProviderMetrics } from './layer-metrics.js';
import type {
  BlockRef,
  CapabilityId,
  ChainId,
  ContractLogsRequest,
  ContractReadRequest,
  DecimalUint,
  RequestId,
  TransactionRef,
} from '@dfr/types';
import { scopeAllows, type ApiKeyScope, type StaticApiKeyConfig, verifyApiKey } from './auth.js';
import { readJsonBody } from './body.js';
import {
  handleBuildTransaction,
  handleBroadcastTransaction,
  handleAbandonTransaction,
  handleConfirmTransaction,
  handlePreflightTransaction,
  handleSimulateTransaction,
  type WriteHandlerContext,
} from './handlers/write.js';
import { matchRoute, type RouteHandlerId, type RouteMatch } from './routes.js';
import { SSE_TICKET_MAX_TTL_MS, clientIp, type SseTicketStore } from './sse-ticket.js';
import {
  SSE_MAX_CONNECTIONS_PER_KEY,
  SseConnectionRegistry,
  SseSession,
  createSseWriter,
  sseHeaders,
} from './sse-stream.js';
import type { EventBus } from '@dfr/events';
import type { EventFilter } from '@dfr/types';
import { TokenBucketLimiter, type RouteClass } from './ratelimit.js';
import { runInSpan } from '@dfr/telemetry';

export interface GatewayLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export interface GatewayOptions {
  core: DfrCore;
  auth: StaticApiKeyConfig;
  limiter?: TokenBucketLimiter;
  logger?: GatewayLogger;
  /** 只读路径超时，默认 10s（gateway-spec 第 9 章）。 */
  readTimeoutMs?: number;
  /** 请求体上限，默认 256 KiB。 */
  maxBodyBytes?: number;
  /**
   * 是否启用写端点（build / simulate）。
   *
   * 默认 `false`：M0 部署不提供写路径，即使 Key 的 scope 允许写也会被
   * `DFR_UNSUPPORTED_CAPABILITY` 拒绝（fail-closed）。`main.ts` 在
   * `DFR_M1_ALLOW_WRITE=true` 且数据库就绪时传 `true`。
   */
  allowWrite?: boolean;
  /**
   * M1 交易引擎（build / simulate 的业务编排）。
   *
   * 未装配时写端点返回 `DFR_UNSUPPORTED_CAPABILITY`（422），**不是** 500：
   * 部署没有交易引擎是配置状态，不是服务故障。`main.ts` 仅在
   * `DFR_M1_ALLOW_WRITE=true` 且数据库就绪时装配它。
   */
  transactions?: TransactionEngine;
  /**
   * 低基数 M1 **交易**指标；`/metrics` 需要有效 API Key。
   *
   * 从 D06 起本字段一直叫 `metrics`；在加入 Gateway HTTP 指标（§5.1）后，
   * 这个含糊的名字会让人分不清是"哪一类指标"，故显式改名为 `transactionMetrics`。
   */
  transactionMetrics?: TransactionMetrics;
  /** Gateway HTTP 指标（§5.1：请求量/延迟/鉴权失败/限流/幂等/在途）。 */
  gatewayMetrics?: GatewayMetrics;
  /** Core 指标（§5.2）。 */
  coreMetrics?: CoreMetrics;
  /** Adapter 指标（§5.3）。 */
  adapterMetrics?: AdapterMetrics;
  /** Provider 指标（§5.4）。 */
  providerMetrics?: ProviderMetrics;
  /**
   * 网关级幂等协调器（DFR-M1-C04，TODO-013 起真正装配）。
   *
   * 只作用于**广播**：build 的幂等在引擎内（按请求体指纹）。
   * 未装配时广播仍要求 `Idempotency-Key`，但**没有重放保证** —— 这是显式行为，
   * 不是静默降级（有测试锁定该差异）。
   */
  idempotency?: GatewayIdempotencyCoordinator;
  /**
   * SSE 一次性票据存储（M2-C02，ADR-029）。未装配时票据端点返回 404（该部署无 SSE）。
   * 只在内存中；不落库、不落盘。
   */
  sseTickets?: SseTicketStore;
  /**
   * 进程内事件总线（M2-C01）。未装配时 `/v1/events/subscribe` 返回 404（该部署无事件流）。
   */
  eventBus?: EventBus;
  /** Max simultaneous SSE streams per Gateway process; defaults to 100. */
  maxSseConnections?: number;
  /**
   * 可信代理地址列表（ADR-029 第 5 点）。为空时**不信任** `X-Forwarded-For`，
   * 一律取直连对端地址（否则该头可被伪造绕过 IP 绑定）。
   */
  trustedProxies?: readonly string[];
  /**
   * 可选依赖就绪探针（DFR-M1-E02）：例如 M1 事务数据库的 `SELECT 1`。
   *
   * 返回 resolve = 依赖可用；抛错/返回 rejected = 依赖不可用 → `/readyz` 503。
   * 错误原文**不会**回显到响应或日志（可能含 DSN 或口令）。
   * 未配置时按 `not_configured` 处理：M0 只读部署没有事务存储，不因此不可就绪。
   */
  readyCheck?: () => Promise<void>;
  /**
   * 可选的**主动**就绪探测（DFR-M1-E02 观测补充，opt-in）。
   *
   * 未配置时 `/readyz` 用 `core.readiness()`：只读已有熔断/健康状态，因此冷启动的
   * Provider（尚未被任何探针观测，health=unknown）会被计为可用。配置后改用
   * `core.probeReadiness()`：当场探一次，`available` 表示"刚才真的应答了"。
   *
   * 代价是就绪路径会发 RPC，因此只在 `DFR_READY_ACTIVE_PROBE=true` 时装配；
   * Core 侧有 TTL 缓存、单飞与短超时兜底。
   */
  readyProbe?: () => Promise<CoreReadiness>;
}

const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const BLOCK_REF_RE = /^(number:[0-9]+|hash:0x[0-9a-fA-F]+|slot:[0-9]+|tag:(latest|safe|finalized))$/;

/** 创建 HTTP 服务；测试可直接传入 fetch 风格调用而不监听端口。 */
export function createGatewayServer(options: GatewayOptions): Server {
  const limiter = options.limiter ?? new TokenBucketLimiter();
  const logger = options.logger ?? silentLogger();
  const maxStreams = options.maxSseConnections ?? 100;
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 1) {
    throw new Error('maxSseConnections must be a positive safe integer');
  }
  let activeStreams = 0;
  const reserveStream = (): (() => void) | undefined => {
    if (activeStreams >= maxStreams) return undefined;
    activeStreams += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeStreams -= 1;
    };
  };
  // Per-key SSE 准入登记：进程级上限仍由上面的 reserveStream 管理，这里只补
  // 单 Key 维度。总上限与 maxStreams 对齐，保证两套机制不会互相矛盾
  // （reserveStream 先行校验，注册表的总上限永远不会先于它触发）。
  const sseConnections = new SseConnectionRegistry(SSE_MAX_CONNECTIONS_PER_KEY, maxStreams);

  return createServer((req, res) => {
    void handle(req, res, options, limiter, logger, reserveStream, sseConnections);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayOptions,
  limiter: TokenBucketLimiter,
  logger: GatewayLogger,
  reserveStream: () => (() => void) | undefined,
  sseConnections: SseConnectionRegistry,
): Promise<void> {
  const started = Date.now();
  const url = new URL(req.url ?? '/', 'http://gateway.local');
  const path = url.pathname;
  const requestId: RequestId = resolveRequestId(
    headerValue(req.headers['x-request-id']),
  );
  const traceId = resolveTraceId(headerValue(req.headers['traceparent']));
  const spanId = randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);

  let status = 500;
  const hasAnyMetrics =
    options.gatewayMetrics !== undefined ||
    options.transactionMetrics !== undefined ||
    options.coreMetrics !== undefined ||
    options.adapterMetrics !== undefined ||
    options.providerMetrics !== undefined;
  // 请求级指标标签：必须在 try 之外声明，才能在 finally 里记录。
  // `route` 用 handler id（有界枚举）而不是原始 path——后者会把交易哈希变成标签。
  let routeLabel = 'unmatched';
  let routeClassLabel: GatewayRouteClass | undefined;
  let chainLabel: string | undefined;
  let inflightEntered = false;

  try {
    // 1. 运维健康检查（不属于公开 API，不需要鉴权，也不进入限流桶）。
    if (path === '/healthz' && req.method === 'GET') {
      status = 200;
      return sendJson(res, 200, { status: 'ok', requestId });
    }

    // 1b. 就绪探针（DFR-M1-E02）。与 /healthz 分离：依赖故障时进程存活但不接流量。
    //     与 /healthz 一样不鉴权（探针不应被 API Key 挡住），但只暴露粗粒度状态，
    //     不含端点、凭证、高基数字段。
    if (path === '/readyz' && req.method === 'GET') {
      // 主动探测（若配置）失败不得让就绪端点 500：视为"探测不可用"，交由下面的判定处理。
      let readiness: CoreReadiness;
      if (options.readyProbe !== undefined) {
        try {
          readiness = await options.readyProbe();
        } catch {
          readiness = { ready: false, chains: [] };
        }
      } else {
        readiness = options.core.readiness();
      }
      let stores: 'ok' | 'unavailable' | 'not_configured' = 'not_configured';
      if (options.readyCheck !== undefined) {
        try {
          await options.readyCheck();
          stores = 'ok';
        } catch {
          // 刻意吞掉原文：依赖错误可能包含 DSN/口令。
          stores = 'unavailable';
        }
      }
      const ready = readiness.ready && stores !== 'unavailable';
      status = ready ? 200 : 503;
      return sendJson(res, status, {
        status: ready ? 'ready' : 'not_ready',
        requestId,
        chains: readiness.chains,
        stores,
      });
    }

    // 1.5 SSE 订阅：**先于**标准 header 鉴权处理。
    //
    // 原因（ADR-029）：浏览器 `EventSource` 无法设置 header，因此该端点支持
    // `?ticket=` 票据鉴权。票据本身就是一次性的凭证，走标准鉴权路径会要求
    // `X-DFR-Key`，把浏览器场景排除掉。票据的消费逻辑在这里完成。
    if (req.method === 'GET' && path === '/v1/events/subscribe') {
      await handleSubscribe(req, res, url, options, limiter, requestId, reserveStream, sseConnections);
      return;
    }

    // 2. 鉴权（先于限流计数）。
    const authHeader = headerValue(req.headers['x-dfr-key']);
    const auth = verifyApiKey(authHeader, options.auth);
    if (!auth.ok) {
      options.gatewayMetrics?.recordAuthFailure(auth.reason);
      throw createDfrError('DFR_UNAUTHENTICATED', {
        requestId,
        message:
          auth.reason === 'missing'
            ? '缺少 X-DFR-Key 请求头'
            : 'API Key 无效',
      });
    }

    // ApiKeyScope 的 IP 约束必须在任何已鉴权业务端点之前执行。X-Forwarded-For
    // 的可信边界与 SSE ticket 绑定共用 clientIp：只有直连对端是配置过的可信代理时才采信。
    const peerIp = clientIp({
      remoteAddress: req.socket.remoteAddress,
      forwardedFor: headerValue(req.headers['x-forwarded-for']),
      trustedProxies: options.trustedProxies ?? [],
    });
    assertIpAllowed(auth.scope, peerIp, requestId);

    if (path === '/metrics' && req.method === 'GET') {
      const decision = limiter.check(`${auth.projectId}:${auth.keyId}`, 'read');
      res.setHeader('X-RateLimit-Limit', String(decision.limit));
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
      if (!decision.allowed) {
        options.gatewayMetrics?.recordRateLimited('read');
        throw createDfrError('DFR_RATE_LIMITED', {
          requestId,
          message: '超出速率限制',
          details: { retryAfterMs: decision.retryAfterMs },
        });
      }
      // 任一指标族装配即认为端点可用；全部未装配才 404（保持既有 fail-closed 语义）。
      const rendered = [
        options.gatewayMetrics,
        options.transactionMetrics,
        options.coreMetrics,
        options.adapterMetrics,
        options.providerMetrics,
      ]
        .filter((m) => m !== undefined)
        .map((m) => m.renderPrometheus())
        .join('');
      if (rendered === '' && !hasAnyMetrics) {
        throw createDfrError('DFR_NOT_FOUND', { requestId, message: '指标端点未启用' });
      }
      status = 200;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      // 各族指标名互不重叠，Prometheus 文本可直接相连。
      res.end(rendered);
      return;
    }

    // 3. 路由匹配。只为拿到路由类（限流桶与写闸门都依赖它），不是"路由到 Core"。
    const route = matchRoute(req.method ?? 'GET', path);
    if (route === null) {
      throw createDfrError('DFR_NOT_FOUND', { requestId, message: `未知路由 ${path}` });
    }
    routeLabel = route.handler;

    // M1 部署有持久化依赖时，/readyz=503 不能只是一个观测信号：
    // 依赖已经不可达就拒绝新的业务请求，避免在 Store 故障期间产生不可恢复的半状态。
    // healthz/readyz 在上方已提前返回，故进程存活与就绪诊断仍可用；恢复后每次请求重新
    // 探测，依赖恢复即可自动放行，不需要重启 Gateway。
    if (options.readyCheck !== undefined) {
      try {
        await options.readyCheck();
      } catch {
        options.gatewayMetrics?.recordDependencyRejected(route.routeClass);
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId,
          message: '事务存储暂不可用，已拒绝业务请求',
        });
      }
    }

    // 4. 限流（按 projectId + keyId + 路由类）。
    const routeClass: RouteClass = route.routeClass;
    routeClassLabel = routeClass;
    chainLabel =
      route.handler === 'getChain' ? route.chainId : (url.searchParams.get('chain') ?? undefined);
    // 在途请求只统计"已匹配路由"的 API 调用：healthz/readyz/metrics 是运维端点，不占业务容量。
    options.gatewayMetrics?.changeInflight(routeClass, 1);
    inflightEntered = true;
    const decision = limiter.check(`${auth.projectId}:${auth.keyId}`, routeClass);
    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      options.gatewayMetrics?.recordRateLimited(routeClass);
      throw createDfrError('DFR_RATE_LIMITED', {
        requestId,
        message: '超出速率限制',
        details: { retryAfterMs: decision.retryAfterMs },
      });
    }

    // 5. 作用域检查（链 / 能力 / 写权限）。写权限是**两道独立闸门**：
    //    Key 的 scope（调用方权限）与 Gateway 部署开关（本进程是否服务写路径）。
    if (route.routeClass === 'write') {
      if (auth.scope.allowWrite !== true) {
        throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
          requestId,
          message: '该 API Key 未开放写权限',
          details: { routeClass },
        });
      }
      if (options.allowWrite !== true) {
        throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
          requestId,
          message: '本部署未启用写路径（DFR_M1_ALLOW_WRITE 未开启）',
          details: { capability: route.capability },
        });
      }
    }

    const requestedChain =
      route.handler === 'getChain' ? route.chainId : url.searchParams.get('chain') ?? undefined;
    if (requestedChain !== undefined && !scopeAllows(auth.scope, { chain: requestedChain })) {
      throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
        requestId,
        message: `API Key 无权访问链 ${requestedChain}`,
        chain: requestedChain as ChainId,
      });
    }
    if (route.capability !== undefined && !scopeAllows(auth.scope, { capability: route.capability })) {
      throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
        requestId,
        message: `API Key 无权使用能力 ${route.capability}`,
        details: { capability: route.capability },
      });
    }

    const timeoutMs = route.handler === 'confirmTransaction'
      ? 605_000
      : options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('gateway-timeout')), timeoutMs);
    // 票据端点需要签发者身份与客户端 IP（ADR-029 的绑定维度）。
    const ctx = { requestId, signal: controller.signal, traceId, spanId, apiKeyId: auth.keyId, clientIp: peerIp };

    try {
      // 6. 契约校验：写路由才读 body（只读路由不消费请求流）。
      const body =
        route.routeClass === 'write' ||
          route.handler === 'createEventTicket' ||
          // `POST /v1/logs`（ADR-034）与 `POST /v1/contracts/read`（ADR-035）是读类但带请求体。
          route.handler === 'getLogs' ||
          route.handler === 'readContract' ||
          // `POST /v1/transactions/preflight`（ADR-037 方案 B）：读类（不占 nonce、不落库）但带请求体。
          route.handler === 'preflightTransaction'
          ? await readJsonBody(req, {
              maxBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
              requestId,
            })
          : undefined;

      // AUTH: validate every declared chain, including nested signed payloads.
      const signedClaim = body?.['signedTransaction'];
      const echoedUnsigned = signedClaim !== null && typeof signedClaim === 'object' && !Array.isArray(signedClaim)
        ? (signedClaim as Record<string, unknown>)['unsigned'] : undefined;
      const bodyChain = scopedBodyChain(route.handler, body);
      const assertedChains = [
        bodyChain,
        typeof body?.['chain'] === 'string' ? body['chain'] : undefined,
        nestedString(body?.['unsignedTransaction'], 'chain'),
        nestedString(signedClaim, 'chain'),
        nestedString(echoedUnsigned, 'chain'),
      ];
      for (const chain of assertedChains) {
        if (chain !== undefined && !scopeAllows(auth.scope, { chain })) {
          throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
            requestId, message: `API Key 无权访问链 ${chain}`, chain: chain as ChainId,
          });
        }
      }
      // A chain-restricted key cannot obtain a global event ticket.
      if (route.handler === 'createEventTicket' && auth.scope.chains !== '*' && bodyChain === undefined) {
        throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
          requestId, message: '受限 API Key 必须指定授权事件链',
        });
      }

      // 7. 路由到 Core / handler。
      // 用 ALS 把**请求 span** 设为当前 span（observability-spec §4「进程内
      // AsyncLocalStorage 承载当前 span」）。这样各层 span 发射器（E6）能在不改
      // 任何端口签名的前提下，把子 span 挂到正确的父上。
      const result = await runInSpan({ traceId, spanId }, () =>
        dispatch(
          route,
          url,
          options,
          auth.projectId,
          auth.scope.chains,
          ctx,
          requestId,
          body,
          headerValue(req.headers['idempotency-key']),
        ),
      );
      status = result.status;
      // 幂等重放等场景需要额外响应头（例如 Idempotency-Replayed）。
      for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
      return sendJson(res, result.status, result.body);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const error = isDfrError(err) ? err : toDfrError(err, { requestId });
    status = error.httpStatus;
    // 幂等冲突在错误路径上唯一可观测；`replayed` 由 write handler 通过同一出口上报。
    if (error.code === 'DFR_IDEMPOTENCY_CONFLICT') {
      options.gatewayMetrics?.recordIdempotencyOutcome('conflict');
    }
    for (const [k, v] of Object.entries(errorHeaders(error))) res.setHeader(k, v);
    return sendJson(res, error.httpStatus, toErrorResponse(error, path));
  } finally {
    // 指标先于日志：日志可能因 I/O 阻塞，指标不应被它拖累。
    if (inflightEntered && routeClassLabel !== undefined) {
      options.gatewayMetrics?.changeInflight(routeClassLabel, -1);
    }
    options.gatewayMetrics?.recordRequest({
      route: routeLabel,
      method: req.method ?? 'GET',
      statusCode: status,
      ...(chainLabel !== undefined ? { chain: chainLabel } : {}),
      durationSeconds: (Date.now() - started) / 1000,
    });
    logger.info({
      requestId,
      trace_id: traceId,
      span_id: spanId,
      method: req.method,
      path,
      status,
      latencyMs: Date.now() - started,
    });
  }
}

/**
 * `GET /v1/events/subscribe`（M2-C03，ADR-029）。
 *
 * 两条鉴权路径二选一：
 *   1. `?ticket=`：一次性票据（浏览器 `EventSource` 可用）——**消费即失效**，
 *      并校验 apiKeyId / IP / filter 三项绑定；
 *   2. `X-DFR-Key`：服务端/桌面客户端可直接用 header（等价于其它只读端点）。
 *
 * filter 只能来自**票据**（票据已绑定它）；header 路径从 query 构造。
 */
async function handleSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: GatewayOptions,
  limiter: TokenBucketLimiter,
  requestId: RequestId,
  reserveStream: () => (() => void) | undefined,
  sseConnections: SseConnectionRegistry,
): Promise<void> {
  const bus = options.eventBus;
  if (bus === undefined) {
    throw createDfrError('DFR_NOT_FOUND', { requestId, message: '本部署未启用事件订阅' });
  }

  // 从 query 构造 filter（ticket 路径会用它做绑定校验；header 路径直接用它）。
  const filter = filterFromQuery(url);
  const ip = clientIp({
    remoteAddress: req.socket.remoteAddress,
    forwardedFor: headerValue(req.headers['x-forwarded-for']),
    trustedProxies: options.trustedProxies ?? [],
  });

  const ticket = url.searchParams.get('ticket');
  let limiterKey: string;
  if (ticket !== null) {
    const store = options.sseTickets;
    if (store === undefined) {
      throw createDfrError('DFR_NOT_FOUND', { requestId, message: '本部署未启用票据鉴权' });
    }
    // 若调用方同时带了 header，Key 必须与签发者一致（不能用一个 Key 的权限消费
    // 另一个 Key 的票据）；纯浏览器场景只有票据，票据即唯一凭证，apiKeyId 传 undefined。
    const suppliedKey = headerValue(req.headers['x-dfr-key']);
    const headerAuth = verifyApiKey(suppliedKey, options.auth);
    const consumed = store.consume({
      ticket,
      projectId: options.auth.projectId,
      ...(headerAuth.ok ? { apiKeyId: headerAuth.keyId } : {}),
      ip,
      filter,
    });
    // 票据仅代理签发时的 Key 权限；消费时按当前配置复核，覆盖 Key 轮换与范围收窄。
    const liveKey = consumed.kind === 'ok' && (
      consumed.ticket.apiKeyId === options.auth.keyId ||
      (consumed.ticket.apiKeyId === options.auth.previousKeyId &&
        options.auth.previousHash !== undefined && options.auth.previousHash !== '')
    );
    if (consumed.kind !== 'ok' || !liveKey || (suppliedKey !== undefined && !headerAuth.ok) ||
        !eventFilterScopeAllows(options.auth.scope, filter)) {
      // 统一 `DFR_INVALID_TICKET`：过期/已用/未找到/绑定不匹配**不区分原因**（避免枚举）。
      throw createDfrError('DFR_INVALID_TICKET', {
        requestId,
        message: 'SSE 票据无效或已使用',
      });
    }
    // A ticket can outlive a key revocation or come from a shared ticket
    // store. Its issuing key must still be active in this gateway's policy.
    const keyId = consumed.ticket.apiKeyId;
    const currentKey = keyId === options.auth.keyId;
    const previousKey = keyId === options.auth.previousKeyId &&
      options.auth.previousHash !== undefined && options.auth.previousHash !== '';
    if (!currentKey && !previousKey) {
      throw createDfrError('DFR_INVALID_TICKET', { requestId, message: 'SSE 票据无效或已使用' });
    }
    assertIpAllowed(options.auth.scope, ip, requestId);
    limiterKey = `${options.auth.projectId}:${consumed.ticket.apiKeyId}`;
    if (options.auth.scope.chains !== '*' &&
        (filter.chain === undefined || !scopeAllows(options.auth.scope, { chain: filter.chain }))) {
      throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
        requestId, message: '该 API Key 不允许全链或跨链事件票据',
      });
    }
  } else {
    // header 路径：与其它端点一致的完整鉴权。
    const auth = verifyApiKey(headerValue(req.headers['x-dfr-key']), options.auth);
    if (!auth.ok) {
      options.gatewayMetrics?.recordAuthFailure(auth.reason);
      throw createDfrError('DFR_UNAUTHENTICATED', {
        requestId,
        message: auth.reason === 'missing' ? '缺少 X-DFR-Key 请求头' : 'API Key 无效',
      });
    }
    assertIpAllowed(auth.scope, ip, requestId);
    limiterKey = `${auth.projectId}:${auth.keyId}`;
    if (!eventFilterScopeAllows(auth.scope, filter)) {
      throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
        requestId,
        message: 'API Key 无权访问该事件过滤范围',
        ...(filter.chain !== undefined ? { chain: filter.chain as ChainId } : {}),
      });
    }
  }

  // Both ticket and header authentication must pass the same stream bucket.
  // Enforce a per-process concurrent connection bound as well as the rate.
  const decision = limiter.check(limiterKey, 'stream');
  res.setHeader('X-RateLimit-Limit', String(decision.limit));
  res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
  if (!decision.allowed) {
    options.gatewayMetrics?.recordRateLimited('stream');
    throw createDfrError('DFR_RATE_LIMITED', {
      requestId, message: '事件订阅速率超过限制',
      details: { retryAfterMs: decision.retryAfterMs },
    });
  }
  const releaseStream = reserveStream();
  if (releaseStream === undefined) {
    options.gatewayMetrics?.recordRateLimited('stream');
    throw createDfrError('DFR_RATE_LIMITED', {
      requestId, message: '事件订阅连接数超过限制',
      details: { retryAfterMs: 1000 },
    });
  }
  // 进程级上限之外再卡单 Key 并发：票据与 header 两条路径共用同一个
  // limiterKey，因此票据不能绕过单 Key 上限。拒绝时先归还进程级槽位。
  const releaseKeySlot = sseConnections.acquire(limiterKey);
  if (releaseKeySlot === null) {
    releaseStream();
    options.gatewayMetrics?.recordRateLimited('stream');
    throw createDfrError('DFR_RATE_LIMITED', {
      requestId, message: '单个 API Key 的事件订阅连接数超过限制',
      details: { retryAfterMs: 1000 },
    });
  }
  // Establish long-lived SSE only after all auth/limiting gates succeeded.
  res.once('close', releaseStream);
  res.once('error', releaseStream);
  res.once('close', releaseKeySlot);
  res.once('error', releaseKeySlot);
  res.writeHead(200, sseHeaders());
  // 必须显式 flush：Node 会缓冲响应头直到首次写入，而 SSE 可能在数十秒内没有事件。
  // 不 flush 的话客户端（以及 `fetch`）会一直等不到 200，表现为"连不上"。
  res.flushHeaders();
  const writer = createSseWriter(res);
  const session = new SseSession({ bus, filter, writer });
  res.on('close', () => session.stop());
}

/** 无 chain 即全局事件范围，只能由全链 Key 订阅。 */
function eventFilterScopeAllows(scope: ApiKeyScope, filter: EventFilter): boolean {
  if (filter.chain === undefined) return scope.chains === '*';
  return scopeAllows(scope, { chain: filter.chain });
}

/** 空白名单表示不限制；非空名单必须精确匹配可信代理规则计算出的来源地址。 */
function assertIpAllowed(scope: ApiKeyScope, ip: string, requestId: RequestId): void {
  const ipAllowlist = scope.ipAllowlist;
  if (ipAllowlist === undefined || ipAllowlist.length === 0 || ipAllowlist.includes(ip)) return;
  throw createDfrError('DFR_IP_NOT_ALLOWED', {
    requestId,
    message: '该 API Key 不允许此来源地址',
  });
}

/**
 * 提取会实际决定链访问的 JSON body 字段，用于在进入 handler / Engine 前执行 scope。
 * 返回 undefined 时由各 handler 的结构校验给出输入错误；这里不复制其领域校验。
 */
function scopedBodyChain(handler: RouteHandlerId, body: Record<string, unknown> | undefined): string | undefined {
  if (body === undefined) return undefined;
  switch (handler) {
    case 'buildTransaction':
    case 'preflightTransaction':
    case 'confirmTransaction':
      return typeof body['chain'] === 'string' ? body['chain'] : undefined;
    case 'simulateTransaction':
      return nestedString(body['unsignedTransaction'], 'chain');
    case 'broadcastTransaction':
      return nestedString(body['signedTransaction'], 'chain');
    case 'createEventTicket':
      return nestedString(body['filter'], 'chain');
    default:
      return undefined;
  }
}

function nestedString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

/** 从 query 构造订阅 filter（OpenAPI 的 chain / types / afterCursor）。 */
function filterFromQuery(url: URL): EventFilter {
  const chain = url.searchParams.get('chain');
  const types = url.searchParams.getAll('types');
  const afterCursor = url.searchParams.get('afterCursor');
  const addresses = url.searchParams.getAll('addresses');
  return {
    ...(chain !== null && chain !== '' ? { chain: chain as ChainId } : {}),
    ...(types.length > 0 ? { types: types as never } : {}),
    ...(addresses.length > 0 ? { addresses } : {}),
    ...(afterCursor !== null && afterCursor !== '' ? { afterCursor: afterCursor as never } : {}),
  };
}

async function dispatch(
  route: RouteMatch,
  url: URL,
  options: GatewayOptions,
  projectId: string,
  authorizedChains: StaticApiKeyConfig['scope']['chains'],
  ctx: {
    requestId: RequestId;
    signal: AbortSignal;
    traceId: string;
    spanId: string;
    apiKeyId: string;
    clientIp: string;
  },
  requestId: RequestId,
  body: Record<string, unknown> | undefined,
  idempotencyKey: string | undefined,
): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  const core = options.core;
  switch (route.handler) {
    case 'listChains':
      return { status: 200, body: { items: core.listChains(), requestId } };

    case 'subscribeEvents':
      // SSE 在 handleSubscribe 中处理（长连接，不走 dispatch）。走到这里说明路由分派有 bug。
      throw createDfrError('DFR_INTERNAL_ERROR', {
        requestId,
        message: 'subscribeEvents 不应经由 dispatch 处理',
      });

    case 'createEventTicket': {
      const store = options.sseTickets;
      if (store === undefined) {
        throw createDfrError('DFR_NOT_FOUND', {
          requestId,
          message: '本部署未启用事件订阅（无票据存储）',
        });
      }
      const filter = (body?.['filter'] ?? {}) as Record<string, unknown>;
      if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId,
          message: 'filter 必须是对象',
          details: { fields: ['filter'] },
        });
      }
      const ttlRaw = body?.['ttlMs'];
      if (ttlRaw !== undefined && (!Number.isInteger(ttlRaw) || (ttlRaw as number) > SSE_TICKET_MAX_TTL_MS || (ttlRaw as number) < 1)) {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId,
          message: `ttlMs 必须是 1..${SSE_TICKET_MAX_TTL_MS} 的整数`,
          details: { fields: ['ttlMs'] },
        });
      }
      // clientIp 需要 remoteAddress；dispatch 不直接持有 req，改由调用方传入（见下）。
      const issued = store.issue({
        projectId,
        apiKeyId: ctx.apiKeyId,
        ip: ctx.clientIp,
        filter: filter as never,
        ...(ttlRaw !== undefined ? { ttlMs: ttlRaw as number } : {}),
      });
      if (issued === null) {
        throw createDfrError('DFR_RATE_LIMITED', {
          requestId,
          message: '未消费票据数超出上限',
        });
      }
      return { status: 201, body: { ticket: issued.ticket, expiresAt: issued.expiresAt, requestId } };
    }

    case 'getChain': {
      const info = await core.getChainInfo(route.chainId as string, ctx);
      return { status: 200, body: { ...info, requestId } };
    }

    case 'getBalance': {
      const chain = requireQuery(url, 'chain', requestId);
      const account = requireQuery(url, 'account', requestId);
      const assetId = url.searchParams.get('assetId');
      const consistency = url.searchParams.get('consistency');
      const blockRefRaw = url.searchParams.get('blockRef');

      const request: Parameters<DfrCore['getBalance']>[0] = {
        chain: chain as ChainId,
        account: { chain: chain as ChainId, address: account },
      };
      if (assetId !== null) {
        request.asset = { kind: 'token', chain: chain as ChainId, assetId };
      }
      if (consistency !== null || blockRefRaw !== null) {
        const hint: { mode: 'best-effort' | 'at-block' | 'finalized'; blockRef?: BlockRef } = {
          mode: parseConsistency(consistency, requestId),
        };
        if (blockRefRaw !== null) hint.blockRef = parseBlockRef(blockRefRaw, requestId);
        request.consistency = hint;
      }

      const balance = await core.getBalance(request, ctx);
      return {
        status: 200,
        body: {
          balance,
          requestId,
          observedAt: new Date().toISOString(),
        },
      };
    }

    case 'getBlock': {
      const chain = requireQuery(url, 'chain', requestId);
      const ref = parseBlockRef(route.blockRef as string, requestId);
      const block = await core.getBlock(chain as ChainId, ref, ctx);
      if (block === null) {
        throw createDfrError('DFR_NOT_FOUND', {
          requestId,
          message: '区块不存在',
          chain: chain as ChainId,
        });
      }
      return { status: 200, body: { block, requestId } };
    }

    case 'getTransaction': {
      const chain = requireQuery(url, 'chain', requestId);
      const includeReceipt = url.searchParams.get('includeReceipt') === 'true';
      const txHash = route.txHash as string;
      const ref: TransactionRef = { kind: 'hash', hash: txHash };
      const transaction = await core.getTransaction(chain as ChainId, ref, ctx);
      if (transaction === null) {
        throw createDfrError('DFR_TRANSACTION_NOT_FOUND', {
          requestId,
          message: '交易不存在或尚不可见',
          chain: chain as ChainId,
        });
      }
      const body: Record<string, unknown> = { transaction, requestId };
      if (includeReceipt) {
        const receipt = await core.getReceipt(chain as ChainId, ref, ctx);
        if (receipt !== null) body['receipt'] = receipt;
      }
      return { status: 200, body };
    }

    case 'getAccount': {
      const chain = requireQuery(url, 'chain', requestId);
      const address = route.address as string;
      const account = await core.getAccount(chain as ChainId, { chain: chain as ChainId, address }, ctx);
      return { status: 200, body: { account, requestId } };
    }

    case 'readContract': {
      const chain = requireQuery(url, 'chain', requestId);
      const req = parseContractReadBody(body, requestId);
      const result = await core.readContract(chain as ChainId, req, ctx);
      return { status: 200, body: { result, requestId } };
    }

    case 'getLogs': {
      const chain = requireQuery(url, 'chain', requestId);
      const req = parseLogsBody(body, requestId);
      const logs = await core.getLogs(chain as ChainId, req, ctx);
      return { status: 200, body: { logs, requestId } };
    }

    case 'buildTransaction': {
      return await handleBuildTransaction(body, writeContext(options, projectId, ctx, idempotencyKey, authorizedChains));
    }

    case 'abandonTransaction':
      return await handleAbandonTransaction(
        route.transactionId ?? '',
        writeContext(options, projectId, ctx, idempotencyKey, authorizedChains),
      );

    case 'preflightTransaction':
      return await handlePreflightTransaction(
        body,
        writeContext(options, projectId, ctx, idempotencyKey, authorizedChains),
      );

    case 'simulateTransaction':
      return await handleSimulateTransaction(
        body,
        writeContext(options, projectId, ctx, idempotencyKey, authorizedChains),
      );
    case 'broadcastTransaction':
      return await handleBroadcastTransaction(body, writeContext(options, projectId, ctx, idempotencyKey, authorizedChains));

    case 'confirmTransaction':
      return await handleConfirmTransaction(
        route.txHash ?? '',
        body,
        writeContext(options, projectId, ctx, idempotencyKey, authorizedChains),
      );
  }
}

/**
 * 写 handler 的上下文：把已经穿过全部横切闸门的请求信息收拢成一份。
 * `engine` 未装配 = 本部署未开放写路径。
 */
function writeContext(
  options: GatewayOptions,
  projectId: string,
  ctx: { requestId: RequestId; signal: AbortSignal; traceId: string; spanId: string },
  idempotencyKey: string | undefined,
  authorizedChains?: StaticApiKeyConfig['scope']['chains'],
): WriteHandlerContext {
  return {
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    projectId,
    signal: ctx.signal,
    ...(authorizedChains !== undefined ? { authorizedChains } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(options.transactions !== undefined ? { engine: options.transactions } : {}),
    ...(options.idempotency !== undefined ? { idempotency: options.idempotency } : {}),
    // 幂等"重放"只有引擎知道（`BuiltTransactionResult.replayed`），由 handler 上报。
    ...(options.gatewayMetrics !== undefined
      ? {
          onIdempotencyOutcome: (outcome: IdempotencyOutcome) =>
            options.gatewayMetrics!.recordIdempotencyOutcome(outcome),
        }
      : {}),
  };
}

function resolveTraceId(traceparent: string | undefined): string {
  if (traceparent !== undefined) {
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu.exec(traceparent);
    if (match !== null && !/^0+$/u.test(match[1]!) && !/^0+$/u.test(match[2]!)) {
      return match[1]!.toLowerCase();
    }
  }
  return randomBytes(16).toString('hex');
}


/* ------------------------------ helpers ------------------------------ */

function requireQuery(url: URL, name: string, requestId: RequestId): string {
  const value = url.searchParams.get(name);
  if (value === null || value === '') {
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
      message: `缺少必填查询参数 ${name}`,
      details: { fields: [name] },
    });
  }
  return value;
}

function parseConsistency(
  value: string | null,
  requestId: RequestId,
): 'best-effort' | 'at-block' | 'finalized' {
  if (value === null || value === '') return 'best-effort';
  if (value === 'best-effort' || value === 'at-block' || value === 'finalized') return value;
  throw createDfrError('DFR_VALIDATION_FAILED', {
    requestId,
    message: `consistency 取值非法：${value}`,
    details: { fields: ['consistency'] },
  });
}

/** 带标签的区块引用语法（评审修正 R-20）。 */
export function parseBlockRef(value: string, requestId: RequestId): BlockRef {
  if (!BLOCK_REF_RE.test(value)) {
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
      message: 'blockRef 语法非法（期望 number:<uint> | hash:0x… | slot:<uint> | tag:latest|safe|finalized）',
      details: { fields: ['blockRef'] },
    });
  }
  const colon = value.indexOf(':');
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  switch (kind) {
    case 'number':
      return { kind: 'number', number: rest as DecimalUint };
    case 'hash':
      return { kind: 'hash', hash: rest };
    case 'slot':
      return { kind: 'slot', slot: rest as DecimalUint };
    default:
      return { kind: 'tag', tag: rest as 'latest' | 'safe' | 'finalized' };
  }
}

/** 解析 `POST /v1/logs` 的请求体（ADR-034）。所有字段校验 fail-closed。 */
function parseLogsBody(body: Record<string, unknown> | undefined, requestId: RequestId): ContractLogsRequest {
  if (body === undefined) {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: '缺少请求体' });
  }
  const fromBlock = parseBlockRefBody(body['fromBlock'], requestId, 'fromBlock');
  const toBlock = parseBlockRefBody(body['toBlock'], requestId, 'toBlock');
  const req: ContractLogsRequest = { fromBlock, toBlock };
  if (typeof body['address'] === 'string') (req as { address?: string }).address = body['address'];
  else if (body['address'] !== undefined) {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'address 必须是字符串', details: { fields: ['address'] } });
  }
  if (body['topics'] !== undefined) {
    if (!Array.isArray(body['topics'])) {
      throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'topics 必须是数组', details: { fields: ['topics'] } });
    }
    (req as { topics?: unknown }).topics = body['topics'];
  }
  if (body['limit'] !== undefined) {
    if (!Number.isInteger(body['limit']) || (body['limit'] as number) < 1) {
      throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'limit 必须是正整数', details: { fields: ['limit'] } });
    }
    (req as { limit?: number }).limit = body['limit'] as number;
  }
  return req;
}

/** 解析 `POST /v1/contracts/read` 的请求体（ADR-035）。 */
function parseContractReadBody(body: Record<string, unknown> | undefined, requestId: RequestId): ContractReadRequest {
  if (body === undefined) {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: '缺少请求体' });
  }
  if (typeof body['contract'] !== 'string' || body['contract'] === '') {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'contract 必填', details: { fields: ['contract'] } });
  }
  const req: ContractReadRequest = { contract: body['contract'] };
  const withField = req as { data?: string; abi?: unknown; method?: string; args?: unknown };
  if (body['data'] !== undefined) {
    if (typeof body['data'] !== 'string') throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'data 必须是字符串', details: { fields: ['data'] } });
    withField.data = body['data'];
  }
  if (body['abi'] !== undefined) {
    if (!Array.isArray(body['abi'])) throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'abi 必须是数组', details: { fields: ['abi'] } });
    withField.abi = body['abi'];
  }
  if (body['method'] !== undefined) {
    if (typeof body['method'] !== 'string') throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'method 必须是字符串', details: { fields: ['method'] } });
    withField.method = body['method'];
  }
  if (body['args'] !== undefined) {
    if (!Array.isArray(body['args'])) throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'args 必须是数组', details: { fields: ['args'] } });
    withField.args = body['args'];
  }
  return req;
}

/** 只接受显式的区块号（number）；tag/hash 不能用于日志区间。 */
function parseBlockRefBody(value: unknown, requestId: RequestId, field: string): BlockRef {
  const number = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
  if (number === undefined || !/^[0-9]+$/u.test(number)) {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: `${field} 必须是十进制区块号字符串`, details: { fields: [field] } });
  }
  return { kind: 'number', number: number as DecimalUint };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

function silentLogger(): GatewayLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

/**
 * M0 只读路由的能力常量（保留导出以兼容既有引用）。
 *
 * 完整路由能力清单见 `routes.ts` 的 `ROUTE_CAPABILITIES`（B06 起含写能力）。
 */
export const M0_ROUTE_CAPABILITIES: readonly CapabilityId[] = [
  'account.balance',
  'block.read',
  'transaction.read',
];
