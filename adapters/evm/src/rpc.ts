/**
 * EVM JSON-RPC call wrapper.
 *
 * The Adapter builds method/params and declares the idempotency class; the Provider only transports
 * (provider-spec Chapter 2). All read calls are `safe-read`.
 *
 * If a single Adapter operation (e.g. getInfo) makes multiple RPC calls, it should **reuse the same handle**,
 * otherwise eth_chainId and eth_blockNumber may land on different endpoints and the chainId check becomes meaningless.
 */
import type { AdapterContext, CapabilityId, ProviderCall, ProviderHandle } from '@dfr/types';

export const DEFAULT_READ_TIMEOUT_MS = 10_000;

/** Make one read-only call on an already acquired handle. */
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

/** Acquire a handle by capability and make one read-only call (single-call scenario). */
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

/** Log shape for `eth_getLogs` (ADR-034). */
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
 * Minimal fields of `eth_feeHistory` (EIP-1559).
 *
 * Only used to fall back to fetching the priority fee when the endpoint does not support `eth_maxPriorityFeePerGas`;
 * `reward[i][j]` is the effective tip for the j-th percentile of the i-th block.
 */
export interface RpcFeeHistory {
  baseFeePerGas?: readonly string[];
  reward?: readonly (readonly string[])[];
}
