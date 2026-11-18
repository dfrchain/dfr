/**
 * DFR API Gateway (DFR-009).
 *
 * Processing order strictly follows gateway-spec chapter 3:
 *   Request ID → authentication → rate limiting → quota → idempotency (write operations) → contract validation → routing → Core → normalization
 *
 * Two orderings that must not be swapped:
 * - Authentication before rate limiting: otherwise invalid credentials could bypass rate limiting;
 * - Idempotency before contract validation: otherwise replayed requests could bypass idempotency through structural differences.
 *
 * Implemented with node:http, no Web framework: M0 has only 5 read-only routes,
 * and one fewer dependency means one less supply-chain risk.
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
import { UsageMeter } from './usage.js';
import {
  cursorAfterPage,
  decodeLogsCursor,
  logsAfter,
  sortChainLogs,
  type LogPosition,
  type LogsCursorState,
} from './logs-cursor.js';
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
   /** Read-path timeout, default 10s (gateway-spec chapter 9). */
  readTimeoutMs?: number;
   /** Request body limit, default 256 KiB. */
  maxBodyBytes?: number;
  /**
    * Whether write endpoints (build / simulate) are enabled.
   *
    * Default `false`: M0 deployments offer no write path, and even a Key whose scope allows writes is rejected with
    * `DFR_UNSUPPORTED_CAPABILITY` (fail-closed). `main.ts` passes `true` when
    * `DFR_M1_ALLOW_WRITE=true` and the database is ready.
   */
  allowWrite?: boolean;
  /**
    * M1 transaction engine (business orchestration for build / simulate).
   *
    * When not assembled, write endpoints return `DFR_UNSUPPORTED_CAPABILITY` (422), **not** 500:
    * a deployment without a transaction engine is a configuration state, not a service failure. `main.ts` only assembles it when
    * `DFR_M1_ALLOW_WRITE=true` and the database is ready.
   */
  transactions?: TransactionEngine;
  /**
    * Low-cardinality M1 **transaction** metrics; `/metrics` requires a valid API Key.
   *
    * This field has been called `metrics` since D06; after Gateway HTTP metrics (§5.1) were added,
    * the vague name made it unclear "which kind of metrics" it was, so it was explicitly renamed `transactionMetrics`.
   */
  transactionMetrics?: TransactionMetrics;
    /** Gateway HTTP metrics (§5.1: request volume / latency / auth failures / rate limiting / idempotency / in-flight). */
  gatewayMetrics?: GatewayMetrics;
    /** Core metrics (§5.2). */
  coreMetrics?: CoreMetrics;
    /** Adapter metrics (§5.3). */
  adapterMetrics?: AdapterMetrics;
    /** Provider metrics (§5.4). */
  providerMetrics?: ProviderMetrics;
  /**
    * Gateway-level idempotency coordinator (DFR-M1-C04, actually assembled starting from TODO-013).
   *
    * Only applies to **broadcast**: build idempotency lives inside the engine (by request-body fingerprint).
    * When not assembled, broadcast still requires `Idempotency-Key`, but with **no replay guarantee** — this is explicit behavior,
    * not silent degradation (a test locks in this difference).
   */
  idempotency?: GatewayIdempotencyCoordinator;
  /**
    * SSE single-use ticket store (M2-C02, ADR-029). When not assembled, ticket endpoints return 404 (this deployment has no SSE).
    * In memory only; never persisted, never written to disk.
   */
  sseTickets?: SseTicketStore;
  /**
    * In-process event bus (M2-C01). When not assembled, `/v1/events/subscribe` returns 404 (this deployment has no event stream).
   */
  eventBus?: EventBus;
  /**
    * Developer usage meter behind `GET /v1/usage` (developer-product task 03).
    *
    * Always assembled (an in-process default is created when omitted) because "view usage" is part of the
    * commercial acceptance bar; injecting one lets tests and multi-Gateway setups share/observe counters.
    * It counts authenticated, route-matched API calls only; it is not a billing ledger.
   */
  usageMeter?: UsageMeter;
  /** Max simultaneous SSE streams per Gateway process; defaults to 100. */
  maxSseConnections?: number;
  /**
    * Trusted-proxy address list (ADR-029 point 5). When empty, `X-Forwarded-For` is **not trusted**,
    * and the direct peer address is always used (otherwise the header could be forged to bypass IP binding).
   */
  trustedProxies?: readonly string[];
  /**
    * Optional dependency readiness probe (DFR-M1-E02): e.g. the M1 transaction database's `SELECT 1`.
   *
    * Resolving = dependency available; throwing / returning rejected = dependency unavailable → `/readyz` 503.
    * Raw error text is **never** echoed into responses or logs (it may contain a DSN or password).
    * When unconfigured, handled as `not_configured`: M0 read-only deployments have no transaction store, and are not unready because of it.
   */
  readyCheck?: () => Promise<void>;
  /**
    * Optional **active** readiness probing (DFR-M1-E02 observability supplement, opt-in).
   *
    * When unconfigured, `/readyz` uses `core.readiness()`: it only reads existing circuit-breaker / health state, so a cold-started
    * Provider (not yet observed by any probe, health=unknown) counts as available. Once configured, it switches to
    * `core.probeReadiness()`: probe once on the spot, where `available` means "it really just answered".
   *
    * The cost is that the readiness path issues RPC, so it is only assembled when `DFR_READY_ACTIVE_PROBE=true`;
    * the Core side has a TTL cache, single-flight, and a short-timeout fallback.
   */
  readyProbe?: () => Promise<CoreReadiness>;
}

const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const BLOCK_REF_RE = /^(number:[0-9]+|hash:0x[0-9a-fA-F]+|slot:[0-9]+|tag:(latest|safe|finalized))$/;

/** Create the HTTP service; tests can pass fetch-style calls directly without listening on a port. */
export function createGatewayServer(options: GatewayOptions): Server {
  const limiter = options.limiter ?? new TokenBucketLimiter();
  const logger = options.logger ?? silentLogger();
  // Resolve the usage meter once: the endpoint and the request path must share the same instance.
  const resolved: GatewayOptions = {
    ...options,
    limiter,
    ...(options.usageMeter === undefined ? { usageMeter: new UsageMeter() } : {}),
  };
  const usage = resolved.usageMeter as UsageMeter;
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
   // Per-key SSE admission registry: the process-level cap is still managed by reserveStream above; this only adds
   // the per-Key dimension. The total cap aligns with maxStreams, so the two mechanisms never contradict each other
   // (reserveStream validates first, so the registry's total cap never triggers before it).
  const sseConnections = new SseConnectionRegistry(SSE_MAX_CONNECTIONS_PER_KEY, maxStreams);

  return createServer((req, res) => {
    void handle(req, res, resolved, limiter, logger, reserveStream, sseConnections, usage);
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
  usage: UsageMeter,
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
   // Request-level metric labels: must be declared outside try so they can be recorded in finally.
   // `route` uses the handler id (a bounded enum), not the raw path — the latter would turn transaction hashes into labels.
  let routeLabel = 'unmatched';
  let routeClassLabel: GatewayRouteClass | undefined;
  let chainLabel: string | undefined;
  let capabilityLabel: string | undefined;
  let inflightEntered = false;
   // Usage is attributed only after authentication succeeds; anonymous traffic is not a project's usage.
  let usageProjectId: string | undefined;
   // `GET /v1/usage` excludes itself so a client can poll the endpoint without inflating its own numbers.
  let usageExcluded = false;
  let errorCodeLabel: string | undefined;

  try {
     // 1. Operations health check (not part of the public API; no auth required, and it does not enter the rate-limit bucket).
    if (path === '/healthz' && req.method === 'GET') {
      status = 200;
      return sendJson(res, 200, { status: 'ok', requestId });
    }

     // 1b. Readiness probe (DFR-M1-E02). Separate from /healthz: when a dependency fails, the process stays alive but accepts no traffic.
     //     Like /healthz, unauthenticated (a probe should not be blocked by an API Key), but exposing only coarse-grained state,
     //     with no endpoints, credentials, or high-cardinality fields.
    if (path === '/readyz' && req.method === 'GET') {
       // A failed active probe (if configured) must not make the readiness endpoint 500: treat it as "probe unavailable" and let the judgment below handle it.
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
           // Deliberately swallow the raw text: dependency errors may contain a DSN/password.
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

     // 1.5 SSE subscription: handled **before** standard header authentication.
    //
     // Reason (ADR-029): browser `EventSource` cannot set headers, so this endpoint supports
     // `?ticket=` ticket authentication. The ticket is itself a single-use credential; the standard auth path would require
     // `X-DFR-Key`, excluding the browser scenario. Ticket consumption logic completes here.
    if (req.method === 'GET' && path === '/v1/events/subscribe') {
      await handleSubscribe(req, res, url, options, limiter, requestId, reserveStream, sseConnections, usage);
      return;
    }

     // 2. Authentication (before rate-limit counting).
    const authHeader = headerValue(req.headers['x-dfr-key']);
    const auth = verifyApiKey(authHeader, options.auth);
    if (!auth.ok) {
      options.gatewayMetrics?.recordAuthFailure(auth.reason);
      throw createDfrError('DFR_UNAUTHENTICATED', {
        requestId,
        message:
          auth.reason === 'missing'
             ? 'Missing X-DFR-Key request header'
             : 'Invalid API Key',
      });
    }
    usageProjectId = auth.projectId;

     // ApiKeyScope's IP constraint must run before any authenticated business endpoint. X-Forwarded-For
     // shares clientIp with the SSE ticket binding for its trust boundary: it is only trusted when the direct peer is a configured trusted proxy.
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
           message: 'Rate limit exceeded',
          details: { retryAfterMs: decision.retryAfterMs },
        });
      }
       // Any assembled metric family means the endpoint is available; 404 only when none are assembled (keeping the existing fail-closed semantics).
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
         throw createDfrError('DFR_NOT_FOUND', { requestId, message: 'Metrics endpoint is not enabled' });
      }
      status = 200;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
       // Metric names do not overlap across families, so Prometheus text can be concatenated directly.
      res.end(rendered);
      return;
    }

     // 3. Route matching. Only to obtain the route class (rate-limit buckets and the write gate both depend on it), not "route to Core".
    const route = matchRoute(req.method ?? 'GET', path);
    if (route === null) {
       throw createDfrError('DFR_NOT_FOUND', { requestId, message: `Unknown route ${path}` });
    }
    routeLabel = route.handler;
    capabilityLabel = route.capability;
    usageExcluded = route.handler === 'getUsage';

     // When an M1 deployment has durable dependencies, /readyz=503 must not be just an observability signal:
     // when a dependency is already unreachable, reject new business requests to avoid unrecoverable half-states during a Store outage.
     // healthz/readyz already returned early above, so process liveness and readiness diagnostics stay available; after recovery, each request re-
     // probes, and traffic is automatically admitted once the dependency recovers — no Gateway restart needed.
    if (options.readyCheck !== undefined) {
      try {
        await options.readyCheck();
      } catch {
        options.gatewayMetrics?.recordDependencyRejected(route.routeClass);
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId,
           message: 'Transaction store temporarily unavailable; business request rejected',
        });
      }
    }

     // 4. Rate limiting (by projectId + keyId + route class).
    const routeClass: RouteClass = route.routeClass;
    routeClassLabel = routeClass;
    chainLabel =
      route.handler === 'getChain' ? route.chainId : (url.searchParams.get('chain') ?? undefined);
     // In-flight requests only count API calls with a "matched route": healthz/readyz/metrics are operations endpoints and do not consume business capacity.
    options.gatewayMetrics?.changeInflight(routeClass, 1);
    inflightEntered = true;
    const decision = limiter.check(`${auth.projectId}:${auth.keyId}`, routeClass);
    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      options.gatewayMetrics?.recordRateLimited(routeClass);
      throw createDfrError('DFR_RATE_LIMITED', {
        requestId,
         message: 'Rate limit exceeded',
        details: { retryAfterMs: decision.retryAfterMs },
      });
    }

     // 5. Scope checks (chain / capability / write permission). Write permission has **two independent gates**:
     //    the Key's scope (caller permission) and the Gateway deployment switch (whether this process serves the write path).
    if (route.routeClass === 'write') {
      if (auth.scope.allowWrite !== true) {
        throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
          requestId,
           message: 'This API Key does not have write permission',
          details: { routeClass },
        });
      }
      if (options.allowWrite !== true) {
        throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
          requestId,
           message: 'The write path is not enabled on this deployment (DFR_M1_ALLOW_WRITE is not on)',
          details: { capability: route.capability },
        });
      }
    }

    const requestedChain =
      route.handler === 'getChain' ? route.chainId : url.searchParams.get('chain') ?? undefined;
    if (requestedChain !== undefined && !scopeAllows(auth.scope, { chain: requestedChain })) {
      throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
        requestId,
         message: `API Key is not authorized to access chain ${requestedChain}`,
        chain: requestedChain as ChainId,
      });
    }
    if (route.capability !== undefined && !scopeAllows(auth.scope, { capability: route.capability })) {
      throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
        requestId,
         message: `API Key is not authorized to use capability ${route.capability}`,
        details: { capability: route.capability },
      });
    }

    const timeoutMs = route.handler === 'confirmTransaction'
      ? 605_000
      : options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('gateway-timeout')), timeoutMs);
     // Ticket endpoints need the issuer identity and client IP (ADR-029's binding dimensions).
    const ctx = { requestId, signal: controller.signal, traceId, spanId, apiKeyId: auth.keyId, clientIp: peerIp };

    try {
       // 6. Contract validation: only write routes read the body (read-only routes do not consume the request stream).
      const body =
        route.routeClass === 'write' ||
          route.handler === 'createEventTicket' ||
           // `POST /v1/logs` (ADR-034) and `POST /v1/contracts/read` (ADR-035) are read-class but carry a request body.
          route.handler === 'getLogs' ||
          route.handler === 'readContract' ||
           // `POST /v1/transactions/preflight` (ADR-037 option B): read-class (no nonce consumed, nothing persisted) but carries a request body.
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
             requestId, message: `API Key is not authorized to access chain ${chain}`, chain: chain as ChainId,
          });
        }
      }
      // A chain-restricted key cannot obtain a global event ticket.
      if (route.handler === 'createEventTicket' && auth.scope.chains !== '*' && bodyChain === undefined) {
        throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
           requestId, message: 'A restricted API Key must specify an authorized event chain',
        });
      }

       // 7. Route to Core / handler.
       // Use ALS to set the **request span** as the current span (observability-spec §4 "in-process
       // AsyncLocalStorage carries the current span"). This lets each layer's span emitters (E6) attach child spans to the right parent without changing
       // any port signature.
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
       // Scenarios such as idempotent replays need extra response headers (e.g. Idempotency-Replayed).
      for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
      return sendJson(res, result.status, result.body);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const error = isDfrError(err) ? err : toDfrError(err, { requestId });
    status = error.httpStatus;
    errorCodeLabel = error.code;
     // RFC 9110: a 429 SHOULD send Retry-After so generic HTTP retry middleware (and our SDK
     // retry policy) can back off by the real refill time instead of guessing.
    if (error.code === 'DFR_RATE_LIMITED') {
      const retryAfterMs = error.details?.['retryAfterMs'];
      if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      }
    }
     // Idempotency conflicts are only observable on the error path; `replayed` is reported by the write handler through the same outlet.
    if (error.code === 'DFR_IDEMPOTENCY_CONFLICT') {
      options.gatewayMetrics?.recordIdempotencyOutcome('conflict');
    }
    for (const [k, v] of Object.entries(errorHeaders(error))) res.setHeader(k, v);
    return sendJson(res, error.httpStatus, toErrorResponse(error, path));
  } finally {
     // Metrics before logs: logs may block on I/O, and metrics should not be dragged down by them.
    if (inflightEntered && routeClassLabel !== undefined) {
      options.gatewayMetrics?.changeInflight(routeClassLabel, -1);
    }
    if (usageProjectId !== undefined && routeClassLabel !== undefined && !usageExcluded) {
      usage.record({
        projectId: usageProjectId,
        route: routeLabel,
        routeClass: routeClassLabel,
        statusCode: status,
        ...(chainLabel !== undefined ? { chain: chainLabel } : {}),
        ...(capabilityLabel !== undefined ? { capability: capabilityLabel } : {}),
        ...(errorCodeLabel !== undefined ? { errorCode: errorCodeLabel } : {}),
      });
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
  * `GET /v1/events/subscribe` (M2-C03, ADR-029).
 *
  * Two authentication paths, choose one:
  *   1. `?ticket=`: single-use ticket (usable by browser `EventSource`) — **consumed on use**,
  *      validating the apiKeyId / IP / filter bindings;
  *   2. `X-DFR-Key`: server / desktop clients can use the header directly (equivalent to other read-only endpoints).
 *
  * filter may only come from a **ticket** (the ticket has bound it); the header path constructs it from the query.
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
  usage: UsageMeter,
): Promise<void> {
  const bus = options.eventBus;
  if (bus === undefined) {
     throw createDfrError('DFR_NOT_FOUND', { requestId, message: 'Event subscription is not enabled on this deployment' });
  }

   // Construct the filter from the query (the ticket path uses it for binding validation; the header path uses it directly).
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
       throw createDfrError('DFR_NOT_FOUND', { requestId, message: 'Ticket authentication is not enabled on this deployment' });
    }
     // If the caller also carries a header, the Key must match the issuer (one Key's permissions may not consume
     // another Key's ticket); in pure-browser scenarios there is only a ticket, the ticket is the sole credential, and apiKeyId is passed as undefined.
    const suppliedKey = headerValue(req.headers['x-dfr-key']);
    const headerAuth = verifyApiKey(suppliedKey, options.auth);
    const consumed = store.consume({
      ticket,
      projectId: options.auth.projectId,
      ...(headerAuth.ok ? { apiKeyId: headerAuth.keyId } : {}),
      ip,
      filter,
    });
     // A ticket only proxies the issuing Key's permissions; consumption re-checks against the current configuration, covering Key rotation and scope narrowing.
    const liveKey = consumed.kind === 'ok' && (
      consumed.ticket.apiKeyId === options.auth.keyId ||
      (consumed.ticket.apiKeyId === options.auth.previousKeyId &&
        options.auth.previousHash !== undefined && options.auth.previousHash !== '')
    );
    if (consumed.kind !== 'ok' || !liveKey || (suppliedKey !== undefined && !headerAuth.ok) ||
        !eventFilterScopeAllows(options.auth.scope, filter)) {
       // Unified `DFR_INVALID_TICKET`: expired / used / not found / binding mismatch are **not distinguished by cause** (to avoid enumeration).
      throw createDfrError('DFR_INVALID_TICKET', {
        requestId,
         message: 'SSE ticket is invalid or already used',
      });
    }
    // A ticket can outlive a key revocation or come from a shared ticket
    // store. Its issuing key must still be active in this gateway's policy.
    const keyId = consumed.ticket.apiKeyId;
    const currentKey = keyId === options.auth.keyId;
    const previousKey = keyId === options.auth.previousKeyId &&
      options.auth.previousHash !== undefined && options.auth.previousHash !== '';
    if (!currentKey && !previousKey) {
       throw createDfrError('DFR_INVALID_TICKET', { requestId, message: 'SSE ticket is invalid or already used' });
    }
    assertIpAllowed(options.auth.scope, ip, requestId);
    limiterKey = `${options.auth.projectId}:${consumed.ticket.apiKeyId}`;
    if (options.auth.scope.chains !== '*' &&
        (filter.chain === undefined || !scopeAllows(options.auth.scope, { chain: filter.chain }))) {
      throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
         requestId, message: 'This API Key does not allow all-chain or cross-chain event tickets',
      });
    }
  } else {
     // Header path: full authentication consistent with other endpoints.
    const auth = verifyApiKey(headerValue(req.headers['x-dfr-key']), options.auth);
    if (!auth.ok) {
      options.gatewayMetrics?.recordAuthFailure(auth.reason);
      throw createDfrError('DFR_UNAUTHENTICATED', {
        requestId,
         message: auth.reason === 'missing' ? 'Missing X-DFR-Key request header' : 'Invalid API Key',
      });
    }
    assertIpAllowed(auth.scope, ip, requestId);
    limiterKey = `${auth.projectId}:${auth.keyId}`;
    if (!eventFilterScopeAllows(auth.scope, filter)) {
      throw createDfrError('DFR_PROJECT_SCOPE_DENIED', {
        requestId,
         message: 'API Key is not authorized to access this event filter scope',
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
       requestId, message: 'Event subscription rate limit exceeded',
      details: { retryAfterMs: decision.retryAfterMs },
    });
  }
  const releaseStream = reserveStream();
  if (releaseStream === undefined) {
    options.gatewayMetrics?.recordRateLimited('stream');
    throw createDfrError('DFR_RATE_LIMITED', {
       requestId, message: 'Event subscription connection limit exceeded',
      details: { retryAfterMs: 1000 },
    });
  }
   // Beyond the process-level cap, also cap per-Key concurrency: the ticket and header paths share the same
   // limiterKey, so tickets cannot bypass the per-Key cap. On rejection, return the process-level slot first.
  const releaseKeySlot = sseConnections.acquire(limiterKey);
  if (releaseKeySlot === null) {
    releaseStream();
    options.gatewayMetrics?.recordRateLimited('stream');
    throw createDfrError('DFR_RATE_LIMITED', {
       requestId, message: 'Per-API-Key event subscription connection limit exceeded',
      details: { retryAfterMs: 1000 },
    });
  }
  // Establish long-lived SSE only after all auth/limiting gates succeeded.
   // Stream usage is counted once the subscription is admitted (long-lived connections are not
   // recorded per event). The route never reaches `dispatch`, so it records here explicitly.
  usage.record({
    projectId: options.auth.projectId,
    route: 'subscribeEvents',
    routeClass: 'stream',
    statusCode: 200,
    ...(filter.chain !== undefined ? { chain: filter.chain } : {}),
  });
  res.once('close', releaseStream);
  res.once('error', releaseStream);
  res.once('close', releaseKeySlot);
  res.once('error', releaseKeySlot);
  res.writeHead(200, sseHeaders());
   // Must explicitly flush: Node buffers response headers until the first write, while SSE may have no events for tens of seconds.
   // Without a flush, clients (and `fetch`) keep waiting for the 200, which looks like "cannot connect".
  res.flushHeaders();
  const writer = createSseWriter(res);
  const session = new SseSession({ bus, filter, writer });
  res.on('close', () => session.stop());
}

/** No chain means a global event scope, subscribable only by an all-chain Key. */
function eventFilterScopeAllows(scope: ApiKeyScope, filter: EventFilter): boolean {
  if (filter.chain === undefined) return scope.chains === '*';
  return scopeAllows(scope, { chain: filter.chain });
}

/** An empty allowlist means no restriction; a non-empty allowlist must exactly match the source address computed by the trusted-proxy rules. */
function assertIpAllowed(scope: ApiKeyScope, ip: string, requestId: RequestId): void {
  const ipAllowlist = scope.ipAllowlist;
  if (ipAllowlist === undefined || ipAllowlist.length === 0 || ipAllowlist.includes(ip)) return;
  throw createDfrError('DFR_IP_NOT_ALLOWED', {
    requestId,
     message: 'This API Key does not allow this source address',
  });
}

/**
  * Extract the JSON body fields that actually decide chain access, to enforce scope before entering the handler / Engine.
  * When undefined is returned, each handler's structural validation reports the input error; domain validation is not duplicated here.
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

/** Build the subscription filter from the query (OpenAPI's chain / types / afterCursor). */
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

    case 'getUsage': {
      const meter = options.usageMeter;
      const limiter = options.limiter;
      if (meter === undefined || limiter === undefined) {
        // createGatewayServer always resolves both; this guards a hand-built GatewayOptions.
        throw createDfrError('DFR_INTERNAL_ERROR', {
          requestId,
          message: 'Usage metering is not assembled on this Gateway',
        });
      }
      const snapshot = meter.snapshot(projectId);
      const scope = options.auth.scope;
      return {
        status: 200,
        body: {
          ...snapshot,
          limits: {
            rateLimits: limiter.limits(),
            scope: {
              chains: scope.chains,
              capabilities: scope.capabilities,
              allowWrite: scope.allowWrite,
            },
          },
          requestId,
        },
      };
    }

    case 'subscribeEvents':
       // SSE is handled in handleSubscribe (a long-lived connection, not via dispatch). Reaching here means the route dispatch has a bug.
      throw createDfrError('DFR_INTERNAL_ERROR', {
        requestId,
         message: 'subscribeEvents must not be handled via dispatch',
      });

    case 'createEventTicket': {
      const store = options.sseTickets;
      if (store === undefined) {
        throw createDfrError('DFR_NOT_FOUND', {
          requestId,
           message: 'Event subscription is not enabled on this deployment (no ticket store)',
        });
      }
      const filter = (body?.['filter'] ?? {}) as Record<string, unknown>;
      if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId,
           message: 'filter must be an object',
          details: { fields: ['filter'] },
        });
      }
      const ttlRaw = body?.['ttlMs'];
      if (ttlRaw !== undefined && (!Number.isInteger(ttlRaw) || (ttlRaw as number) > SSE_TICKET_MAX_TTL_MS || (ttlRaw as number) < 1)) {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId,
           message: `ttlMs must be an integer in 1..${SSE_TICKET_MAX_TTL_MS}`,
          details: { fields: ['ttlMs'] },
        });
      }
      // clientIp needs remoteAddress; dispatch does not hold req directly, so the caller passes it in (see below).
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
           message: 'Unconsumed ticket count exceeds the limit',
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
           message: 'Block does not exist',
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
           message: 'Transaction does not exist or is not yet visible',
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
      const parsed = parseLogsBody(body, requestId);
      const resolved = resolveLogsRequest(chain, parsed, requestId);
      // The Adapter's own `limit` truncates silently; pagination must happen here so `hasMore`
      // and the continuation cursor describe exactly what was returned.
      const logs = await core.getLogs(chain as ChainId, resolved.request, ctx);
      const sorted = sortChainLogs(logs);
      const remaining =
        resolved.after !== undefined ? logsAfter(sorted, resolved.after) : sorted;
      if (parsed.limit === undefined) {
        return { status: 200, body: { logs: remaining, hasMore: false, requestId } };
      }
      const page = remaining.slice(0, parsed.limit);
      const hasMore = remaining.length > parsed.limit;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last !== undefined ? cursorAfterPage(resolved.state, last, requestId) : undefined;
      return {
        status: 200,
        body: {
          logs: page,
          hasMore,
          ...(nextCursor !== undefined ? { nextCursor } : {}),
          requestId,
        },
      };
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
  * Write handler context: gathers the request information that has passed through all cross-cutting gates into one place.
  * `engine` not assembled = this deployment does not expose the write path.
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
     // Only the engine knows about an idempotent "replay" (`BuiltTransactionResult.replayed`); the handler reports it.
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
       message: `Missing required query parameter ${name}`,
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
     message: `Invalid consistency value: ${value}`,
    details: { fields: ['consistency'] },
  });
}

/** Tagged block reference syntax (review fix R-20). */
export function parseBlockRef(value: string, requestId: RequestId): BlockRef {
  if (!BLOCK_REF_RE.test(value)) {
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
       message: 'Invalid blockRef syntax (expected number:<uint> | hash:0x… | slot:<uint> | tag:latest|safe|finalized)',
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

interface ParsedLogsBody {
  /** Continuation cursor; mutually exclusive with range/filter fields. */
  readonly cursor?: string;
  /** Page size; when omitted the whole remaining result is returned with `hasMore: false`. */
  readonly limit?: number;
  /** Present only in the first-page form (no cursor). */
  readonly request?: ContractLogsRequest;
}

/**
 * Parse the `POST /v1/logs` body (ADR-034 + cursor pagination).
 *
 * Two mutually exclusive forms:
 *   - first page: `{ fromBlock, toBlock, address?, topics?, limit? }`
 *   - continuation: `{ cursor, limit? }`
 * Mixing them is rejected: a cursor already carries its range/filter, and guessing which side wins
 * is exactly how reconciliation bugs happen.
 */
function parseLogsBody(body: Record<string, unknown> | undefined, requestId: RequestId): ParsedLogsBody {
  if (body === undefined) {
     throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'Missing request body' });
  }
  const limit = parseLogsLimit(body['limit'], requestId);
  const cursorRaw = body['cursor'];
  if (cursorRaw !== undefined) {
    if (typeof cursorRaw !== 'string' || cursorRaw === '') {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId,
        message: 'cursor must be a non-empty string',
        details: { fields: ['cursor'] },
      });
    }
    for (const field of ['fromBlock', 'toBlock', 'address', 'topics'] as const) {
      if (body[field] !== undefined) {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId,
          message: `cursor cannot be combined with ${field}`,
          details: { fields: ['cursor', field] },
        });
      }
    }
    return { cursor: cursorRaw, ...(limit !== undefined ? { limit } : {}) };
  }

  const fromBlock = parseBlockRefBody(body['fromBlock'], requestId, 'fromBlock');
  const toBlock = parseBlockRefBody(body['toBlock'], requestId, 'toBlock');
  const req: ContractLogsRequest = { fromBlock, toBlock };
  if (typeof body['address'] === 'string') (req as { address?: string }).address = body['address'];
  else if (body['address'] !== undefined) {
     throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'address must be a string', details: { fields: ['address'] } });
  }
  if (body['topics'] !== undefined) {
    if (!Array.isArray(body['topics'])) {
       throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'topics must be an array', details: { fields: ['topics'] } });
    }
    (req as { topics?: unknown }).topics = body['topics'];
  }
  return { request: req, ...(limit !== undefined ? { limit } : {}) };
}

function parseLogsLimit(value: unknown, requestId: RequestId): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) {
     throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'limit must be a positive integer', details: { fields: ['limit'] } });
  }
  return value as number;
}

interface ResolvedLogsRequest {
  readonly request: ContractLogsRequest;
  readonly state: Omit<LogsCursorState, 'afterBlock' | 'afterIndex'>;
  readonly after?: LogPosition;
}

/** Turn the first-page or continuation form into one Core request plus the cursor position. */
function resolveLogsRequest(
  chain: string,
  parsed: ParsedLogsBody,
  requestId: RequestId,
): ResolvedLogsRequest {
  if (parsed.cursor !== undefined) {
    const cursor = decodeLogsCursor(parsed.cursor, requestId);
    if (cursor.chain !== chain) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId,
        message: 'cursor was issued for a different chain',
        details: { fields: ['cursor'] },
        chain: chain as ChainId,
      });
    }
    if (BigInt(cursor.fromBlock) > BigInt(cursor.toBlock)) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId,
        message: 'cursor contains an inverted block range',
        details: { fields: ['cursor'] },
      });
    }
    return {
      request: {
        fromBlock: { kind: 'number', number: cursor.fromBlock },
        toBlock: { kind: 'number', number: cursor.toBlock },
        ...(cursor.address !== undefined ? { address: cursor.address } : {}),
        ...(cursor.topics !== undefined ? { topics: cursor.topics } : {}),
      },
      state: {
        chain: cursor.chain,
        fromBlock: cursor.fromBlock,
        toBlock: cursor.toBlock,
        ...(cursor.address !== undefined ? { address: cursor.address } : {}),
        ...(cursor.topics !== undefined ? { topics: cursor.topics } : {}),
      },
      after: { block: BigInt(cursor.afterBlock), index: BigInt(cursor.afterIndex) },
    };
  }

  const request = parsed.request;
  if (request === undefined) {
    throw createDfrError('DFR_INTERNAL_ERROR', { requestId, message: 'logs request was not parsed' });
  }
  const from = request.fromBlock as { kind: 'number'; number: DecimalUint };
  const to = request.toBlock as { kind: 'number'; number: DecimalUint };
  return {
    request,
    state: {
      chain,
      fromBlock: from.number,
      toBlock: to.number,
      ...(request.address !== undefined ? { address: request.address } : {}),
      ...(request.topics !== undefined ? { topics: request.topics } : {}),
    },
  };
}

/** Parse the `POST /v1/contracts/read` request body (ADR-035). */
function parseContractReadBody(body: Record<string, unknown> | undefined, requestId: RequestId): ContractReadRequest {
  if (body === undefined) {
     throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'Missing request body' });
  }
  if (typeof body['contract'] !== 'string' || body['contract'] === '') {
     throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'contract is required', details: { fields: ['contract'] } });
  }
  const req: ContractReadRequest = { contract: body['contract'] };
  const withField = req as { data?: string; abi?: unknown; method?: string; args?: unknown };
  if (body['data'] !== undefined) {
     if (typeof body['data'] !== 'string') throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'data must be a string', details: { fields: ['data'] } });
    withField.data = body['data'];
  }
  if (body['abi'] !== undefined) {
     if (!Array.isArray(body['abi'])) throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'abi must be an array', details: { fields: ['abi'] } });
    withField.abi = body['abi'];
  }
  if (body['method'] !== undefined) {
     if (typeof body['method'] !== 'string') throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'method must be a string', details: { fields: ['method'] } });
    withField.method = body['method'];
  }
  if (body['args'] !== undefined) {
     if (!Array.isArray(body['args'])) throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'args must be an array', details: { fields: ['args'] } });
    withField.args = body['args'];
  }
  return req;
}

/** Only explicit block numbers (number) are accepted; tag/hash cannot be used for log ranges. */
function parseBlockRefBody(value: unknown, requestId: RequestId, field: string): BlockRef {
  const number = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
  if (number === undefined || !/^[0-9]+$/u.test(number)) {
     throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: `${field} must be a decimal block-number string`, details: { fields: [field] } });
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
 * Capability constants for M0 read-only routes (kept exported for compatibility with existing references).
 *
 * The full route capability list is in `routes.ts`'s `ROUTE_CAPABILITIES` (write capabilities included from B06).
 */
export const M0_ROUTE_CAPABILITIES: readonly CapabilityId[] = [
  'account.balance',
  'block.read',
  'transaction.read',
];
