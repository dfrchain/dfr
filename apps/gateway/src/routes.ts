/**
 * 路由元数据（DFR-M1-B06，gateway-spec 第 3/5.2 节）。
 *
 * 为什么单独成文件：路由类（read / write / stream）决定限流桶与写权限闸门，
 * 必须由**元数据**声明，而不是散落在 handler 的 if 里。写端点（B07/B08）落地时
 * 只需在表里补齐，不会把限流与权限判断漏在某个分支上。
 *
 * Gateway 仍然只做结构匹配：链语义、地址格式由 Adapter 判定。
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
  | 'subscribeEvents';

export interface RouteMatch {
  readonly handler: RouteHandlerId;
  readonly routeClass: RouteClass;
  /** 该路由需要的能力，用于作用域检查（gateway-spec 第 3 章第 5 步）。 */
  readonly capability?: CapabilityId;
  /** `/v1/chains/{chainId}` 的路径参数。 */
  readonly chainId?: string;
  /** `/v1/transactions/{hash}` 的路径参数（GET；链上交易哈希）。 */
  readonly txHash?: string;
  /** `/v1/transactions/{id}` 的路径参数（DELETE；DFR 内部执行标识 `txn_<...>`）。 */
  readonly transactionId?: string;
  /** `/v1/blocks/{blockRef}` 的路径参数（已 URL 解码）。 */
  readonly blockRef?: string;
  /** `/v1/accounts/{address}` 的路径参数（已 URL 解码）。 */
  readonly address?: string;
}

const CHAIN_PATH_RE = /^\/v1\/chains\/([a-z0-9-]+)$/;
const BLOCK_PATH_RE = /^\/v1\/blocks\/(.+)$/;
const TRANSACTION_PATH_RE = /^\/v1\/transactions\/([^/]+)$/;
/** ADR-037：作废**未广播**交易（`POST /v1/transactions/{id}/abandon`）。 */
const ABANDON_PATH_RE = /^\/v1\/transactions\/([^/]+)\/abandon$/;
const CONFIRM_PATH_RE = /^\/v1\/transactions\/([^/]+)\/confirm$/;
const ACCOUNT_PATH_RE = /^\/v1\/accounts\/(.+)$/;

/** 匹配 `method + path`；不匹配返回 `null`，由调用方映射为 404（不泄漏路由清单）。 */
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
      // ADR-037：作废一笔**未广播**的交易，释放其 nonce 占用。
      // 归**写类**：它会改变状态并释放租约（与"只读的 preflight"刻意不同）。
      //
      // 路径参数喂给 `transactionId`（`txn_<...>`）而不是 `txHash`：
      // 两者语义不同，共用字段会让"传了哈希"这类错误在更深处才炸。
      return {
        handler: 'abandonTransaction',
        routeClass: 'write',
        capability: 'transaction.build',
        transactionId: decodeURIComponent(abandon[1] as string),
      };
    }
    if (path === '/v1/transactions/preflight') {
      // ADR-037 方案 B：只读预检（不占 nonce、不落库），因此归**读类**——
      // 它不该消耗写限额，正如它不该消耗 nonce 一样。
      // Capability 声明 `transaction.build`（它的主依赖）；若该链未启用 `transaction.simulate`，
      // Core 的 `requireCapability` 会在内部 fail-closed（不静默降级）。
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
      // 签发票据是**读类**：它不改变链上或交易状态，只是换取一个 SSE 凭据。
      // 用 stream 桶会让"先签票再连接"占用两次流控额度，语义也不对。
      return { handler: 'createEventTicket', routeClass: 'read' };
    }
    return null;
  }

  return null;
}

/** 全部已声明能力（供契约测试断言"路由声明的能力都在 CapabilityId 内"）。 */
export const ROUTE_CAPABILITIES: readonly CapabilityId[] = [
  'account.balance',
  'block.read',
  'transaction.read',
  'transaction.build',
  'transaction.simulate',
  'transaction.broadcast',
  // ADR-034：POST /v1/logs（事件日志查询）。
  'contract.logs',
  // ADR-035/036：POST /v1/contracts/read、GET /v1/accounts/{address}。
  'contract.read',
  'account.code',
];
