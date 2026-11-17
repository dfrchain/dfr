/**
 * @dfr/gateway —— DFR API Gateway（DFR-009，M0 只读）。
 */
export { createGatewayServer, parseBlockRef, type GatewayOptions, type GatewayLogger } from './server.js';
export { matchRoute, ROUTE_CAPABILITIES, type RouteHandlerId, type RouteMatch } from './routes.js';
export { readJsonBody, type ReadJsonBodyOptions } from './body.js';
export { createCoreTransactionChainPort } from './transaction-port.js';
export {
  GatewayIdempotencyCoordinator,
  canonicalJson,
  fingerprintRequest,
  type GatewayIdempotencyCoordinatorOptions,
} from './idempotency.js';
export {
  hashSecret,
  constantTimeEqualHex,
  verifyApiKey,
  scopeAllows,
  type ApiKeyScope,
  type StaticApiKeyConfig,
  type AuthResult,
} from './auth.js';
export {
  TokenBucketLimiter,
  DEFAULT_BUCKETS,
  type BucketConfig,
  type RouteClass,
  type RateLimitDecision,
} from './ratelimit.js';
