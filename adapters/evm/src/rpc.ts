/**
 * EVM JSON-RPC 调用封装。
 *
 * Adapter 负责构造 method/params 并声明幂等类别；Provider 只做传输
 * （provider-spec 第 2 章）。所有读调用都是 `safe-read`。
 *
 * 单次 Adapter 操作（例如 getInfo）如果发出多个 RPC 调用，应当**复用同一个句柄**，
 * 否则 eth_chainId 与 eth_blockNumber 可能落在不同端点，chainId 校验就失去意义。
 */
import type { AdapterContext, CapabilityId, ProviderCall, ProviderHandle } from '@dfr/types';

export const DEFAULT_READ_TIMEOUT_MS = 10_000;

/** 在已获取的句柄上发起一次只读调用。 */
export function rpcOn<T>(
  handle: ProviderHandle,
  ctx: AdapterContext,
  method: string,
  params: readonly unknown[],
  timeoutMs: number = DEFAULT_READ_TIMEOUT_MS,
): Promise<T> {
  const call: ProviderCall = { method, params, idempotency: 'safe-read', timeoutMs };
  return handle.request<T>(call, {
    requestId: ctx.requestId,
    ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
    ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
    signal: ctx.signal,
  });
}

/** 按能力获取句柄并发起一次只读调用（单次调用场景）。 */
export async function evmCall<T>(
  ctx: AdapterContext,
  capability: CapabilityId,
  method: string,
  params: readonly unknown[],
  timeoutMs: number = DEFAULT_READ_TIMEOUT_MS,
): Promise<T> {
  const handle = await ctx.providers.acquire({ capability });
  return rpcOn<T>(handle, ctx, method, params, timeoutMs);
}

export interface RpcBlock {
  number: string | null;
  hash: string | null;
  parentHash: string | null;
  timestamp: string | null;
  transactions: readonly unknown[] | null;
  baseFeePerGas?: string;
}

export interface RpcTransaction {
  hash: string;
  blockNumber: string | null;
  blockHash: string | null;
  from: string;
  to: string | null;
  value: string;
  nonce: string;
  gas?: string;
  gasPrice?: string;
}

/** `eth_getLogs` 的日志形状（ADR-034）。 */
export interface RpcLog {
  address?: string;
  topics?: readonly string[];
  data?: string;
  blockNumber?: string | null;
  blockHash?: string | null;
  transactionHash?: string | null;
  transactionIndex?: string | null;
  logIndex?: string | null;
  removed?: boolean;
}

export interface RpcReceipt {
  transactionHash: string;
  blockNumber: string;
  blockHash: string;
  status?: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  logs?: readonly unknown[];
}

/**
 * `eth_feeHistory` 的最小字段（EIP-1559）。
 *
 * 只在端点不支持 `eth_maxPriorityFeePerGas` 时用于回退取 priority fee；
 * `reward[i][j]` 是第 i 个区块第 j 个百分位的有效小费。
 */
export interface RpcFeeHistory {
  baseFeePerGas?: readonly string[];
  reward?: readonly (readonly string[])[];
}
