/**
 * Route metadata (DFR-M1-B06, gateway-spec sections 3/5.2).
 *
 * Why a separate file: the route class (read / write / stream) decides the rate-limit bucket and the write-permission gate,
 * so it must be declared by **metadata**, not scattered in handler ifs. When the write endpoints (B07/B08) land,
 * they only need to be added to the table; no branch can forget the rate-limit and permission checks.
 *
 * The Gateway still only does structural matching: chain semantics and address formats are decided by the Adapter.
 */
import type { CapabilityId } from '@dfr/types';
import type { RouteClass } from './ratelimit.js';

export type RouteHandlerId =
  | 'listChains'
  | 'getChain'
  | 'getBalance'
  | 'getAccount'
  | 'getBlock'
  | 'getTransaction'
  | 'getLogs'
  | 'readContract'
  | 'buildTransaction'
  | 'preflightTransaction'
  | 'abandonTransaction'
  | 'simulateTransaction'
  | 'broadcastTransaction'
  | 'confirmTransaction'
  | 'createEventTicket'
  | 'subscribeEvents'
  | 'getUsage';

export interface RouteMatch {
  readonly handler: RouteHandlerId;
  readonly routeClass: RouteClass;
  /** The capability this route needs, used for scope checks (gateway-spec chapter 3 step 5). */
  readonly capability?: CapabilityId;
  /** Path parameter for `/v1/chains/{chainId}`. */
  readonly chainId?: string;
  /** Path parameter for `/v1/transactions/{hash}` (GET; on-chain transaction hash). */
  readonly txHash?: string;
  /** Path parameter for `/v1/transactions/{id}` (DELETE; DFR internal execution id `txn_<...>`). */
  readonly transactionId?: string;
  /** Path parameter for `/v1/blocks/{blockRef}` (already URL-decoded). */
  readonly blockRef?: string;
  /** Path parameter for `/v1/accounts/{address}` (already URL-decoded). */
  readonly address?: string;
}

const CHAIN_PATH_RE = /^\/v1\/chains\/([a-z0-9-]+)$/;
const BLOCK_PATH_RE = /^\/v1\/blocks\/(.+)$/;
const TRANSACTION_PATH_RE = /^\/v1\/transactions\/([^/]+)$/;
/** ADR-037: void an **unbroadcast** transaction (`POST /v1/transactions/{id}/abandon`). */
const ABANDON_PATH_RE = /^\/v1\/transactions\/([^/]+)\/abandon$/;
const CONFIRM_PATH_RE = /^\/v1\/transactions\/([^/]+)\/confirm$/;
const ACCOUNT_PATH_RE = /^\/v1\/accounts\/(.+)$/;

/** Match `method + path`; return `null` on no match, mapped to 404 by the caller (without leaking the route list). */
export function matchRoute(method: string, path: string): RouteMatch | null {
  if (method === 'GET') {
    if (path === '/v1/chains') {
      return { handler: 'listChains', routeClass: 'read' };
    }
    const chain = CHAIN_PATH_RE.exec(path);
    if (chain !== null) {
      return { handler: 'getChain', routeClass: 'read', chainId: chain[1] as string };
    }
    const account = ACCOUNT_PATH_RE.exec(path);
    if (account !== null) {
      return { handler: 'getAccount', routeClass: 'read', capability: 'account.code', address: decodeURIComponent(account[1] as string) };
    }
    if (path === '/v1/events/subscribe') {
      return { handler: 'subscribeEvents', routeClass: 'stream' };
    }
    // Developer-product task 03: per-project usage. Read-class: it changes no state and needs no write scope.
    if (path === '/v1/usage') {
      return { handler: 'getUsage', routeClass: 'read' };
    }
    if (path === '/v1/balances') {
      return { handler: 'getBalance', routeClass: 'read', capability: 'account.balance' };
    }
    const block = BLOCK_PATH_RE.exec(path);
    if (block !== null) {
      return {
        handler: 'getBlock',
        routeClass: 'read',
        capability: 'block.read',
        blockRef: decodeURIComponent(block[1] as string),
      };
    }
    const transaction = TRANSACTION_PATH_RE.exec(path);
    if (transaction !== null) {
      return {
        handler: 'getTransaction',
        routeClass: 'read',
        capability: 'transaction.read',
        txHash: decodeURIComponent(transaction[1] as string),
      };
    }
    return null;
  }

  if (method === 'POST') {
    const confirm = CONFIRM_PATH_RE.exec(path);
    if (confirm !== null) {
      return {
        handler: 'confirmTransaction',
        routeClass: 'write',
        capability: 'transaction.read',
        txHash: decodeURIComponent(confirm[1] as string),
      };
    }
    if (path === '/v1/transactions/build') {
      return {
        handler: 'buildTransaction',
        routeClass: 'write',
        capability: 'transaction.build',
      };
    }
    const abandon = ABANDON_PATH_RE.exec(path);
    if (abandon !== null) {
      // ADR-037: void an **unbroadcast** transaction, releasing its nonce.
      // Classified as **write**: it changes state and releases a lease (deliberately unlike the read-only preflight).
      //
      // The path parameter feeds `transactionId` (`txn_<...>`), not `txHash`:
      // the two have different semantics, and sharing a field would let errors like "passed a hash" explode deeper down.
      return {
        handler: 'abandonTransaction',
        routeClass: 'write',
        capability: 'transaction.build',
        transactionId: decodeURIComponent(abandon[1] as string),
      };
    }
    if (path === '/v1/transactions/preflight') {
      // ADR-037 option B: read-only preflight (no nonce taken, nothing persisted), so it is classified as **read** —
      // it should consume no write quota, just as it consumes no nonce.
      // The capability declares `transaction.build` (its main dependency); if the chain has not enabled `transaction.simulate`,
      // Core's `requireCapability` fails closed internally (no silent degradation).
      return {
        handler: 'preflightTransaction',
        routeClass: 'read',
        capability: 'transaction.build',
      };
    }
    if (path === '/v1/transactions/simulate') {
      return {
        handler: 'simulateTransaction',
        routeClass: 'write',
        capability: 'transaction.simulate',
      };
    }
    if (path === '/v1/transactions/broadcast') {
      return { handler: 'broadcastTransaction', routeClass: 'write', capability: 'transaction.broadcast' };
    }
    if (path === '/v1/contracts/read') {
      return { handler: 'readContract', routeClass: 'read', capability: 'contract.read' };
    }
    if (path === '/v1/logs') {
      return { handler: 'getLogs', routeClass: 'read', capability: 'contract.logs' };
    }
    if (path === '/v1/events/tickets') {
      // Issuing a ticket is **read**: it changes no on-chain or transaction state; it only exchanges for an SSE credential.
      // Using the stream bucket would charge "issue a ticket, then connect" twice the flow-control budget, which is also semantically wrong.
      return { handler: 'createEventTicket', routeClass: 'read' };
    }
    return null;
  }

  return null;
}

/** All declared capabilities (for contract tests asserting "every capability declared by routes is a CapabilityId"). */
export const ROUTE_CAPABILITIES: readonly CapabilityId[] = [
  'account.balance',
  'block.read',
  'transaction.read',
  'transaction.build',
  'transaction.simulate',
  'transaction.broadcast',
  // ADR-034: POST /v1/logs (event log query).
  'contract.logs',
  // ADR-035/036: POST /v1/contracts/read, GET /v1/accounts/{address}.
  'contract.read',
  'account.code',
];
