/**
 * Solana JSON-RPC call wrapper (same conventions as the EVM rpc.ts).
 *
 * All read calls are tagged `safe-read`; the Adapter builds method/params, the Provider only transports.
 * If one Adapter operation makes multiple RPCs, it must reuse the same handle (otherwise endpoints may differ).
 */
import type { AdapterContext, ProviderCall, ProviderHandle } from '@dfr/types';

export const DEFAULT_READ_TIMEOUT_MS = 10_000;

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

export interface SolanaRpcAccountInfo {
  readonly context?: { readonly slot?: number };
  readonly value: {
    readonly lamports: number;
    readonly data?: readonly [string, string];
    readonly owner?: string;
    readonly executable?: boolean;
  } | null;
}

export interface SolanaRpcBlock {
  readonly blockhash?: string;
  readonly previousBlockhash?: string;
  readonly blockHeight?: number | null;
  readonly blockTime?: number | null;
  readonly parentSlot?: number;
  readonly transactions?: readonly unknown[];
  readonly signatures?: readonly string[];
}

export interface SolanaRpcTransaction {
  readonly slot?: number;
  readonly blockTime?: number | null;
  readonly transactionIndex?: number;
  readonly version?: string | number;
  readonly transaction?: {
    readonly signatures?: readonly string[];
    readonly message?: {
      readonly accountKeys?: readonly string[];
      readonly recentBlockhash?: string;
    };
  };
  readonly meta?: {
    readonly err?: unknown;
    readonly fee?: number;
    readonly computeUnitsConsumed?: number;
    readonly logMessages?: readonly string[] | null;
  } | null;
}
