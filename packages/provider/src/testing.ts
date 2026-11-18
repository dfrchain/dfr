/**
 * Test doubles (review fix R-11).
 *
 * Acceptance items like "the primary Provider going down heals itself" cannot be deterministically reproduced with public endpoints; they must be driven by
 * **programmable-failure Provider doubles**. This file also provides:
 * - ProgrammableProvider: returns success/failure/timeout by script;
 * - createStubFetch: intercepts fetch calls, so JsonRpcHttpProvider takes the full transport path.
 */
import type { ProviderDescriptor, ProviderId, ChainId, NetworkId, ProviderKind } from '@dfr/types';

export type StubBehavior =
  | { kind: 'result'; value: unknown }
  | { kind: 'http'; status: number; body?: unknown }
  | { kind: 'rpc-error'; code: number; message: string }
  | { kind: 'network-error'; message?: string }
  | { kind: 'timeout' };

export interface StubCall {
  method: string;
  params: readonly unknown[];
  providerId: string;
}

export interface StubFetchOptions {
  /** The call sequence grouped by providerId; the last item is reused after exhaustion. */
  behaviors?: Record<string, StubBehavior[]>;
  /** Decide the response by method; either this or behaviors (resolve wins). */
  resolve?: (call: StubCall & { callIndex: number }) => StubBehavior;
  /** Every call is recorded, for assertions like "broadcast was not retried". */
  onCall?: (call: StubCall) => void;
}

/**
 * Construct a programmable fetch implementation.
 *
 * `behaviors` are grouped by providerId; each array is that Provider's call sequence,
 * reused after exhaustion (handy for expressing "always failing").
 */
export function createStubFetch(options: StubFetchOptions): typeof fetch {
  const cursors = new Map<string, number>();

  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = String(input);
    const providerId = providerIdFromUrl(url);
    const body = typeof init?.body === 'string' ? init.body : '{}';
    const parsed = JSON.parse(body) as { method?: string; params?: unknown[] };
    const method = parsed.method ?? 'unknown';
    options.onCall?.({ method, params: parsed.params ?? [], providerId });

    const index = cursors.get(providerId) ?? 0;
    cursors.set(providerId, index + 1);
    const behavior = resolveBehavior(options, { method, params: parsed.params ?? [], providerId }, index);

    switch (behavior.kind) {
      case 'result':
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: behavior.value });
      case 'http':
        return new Response(
          behavior.body === undefined ? 'error' : JSON.stringify(behavior.body),
          { status: behavior.status, headers: { 'content-type': 'application/json' } },
        );
      case 'rpc-error':
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          error: { code: behavior.code, message: behavior.message },
        });
      case 'network-error':
        throw new TypeError(behavior.message ?? 'network error');
      case 'timeout':
        return await new Promise<Response>((_resolve, reject) => {
          // Triggered by the caller's AbortSignal; here it only guarantees never resolving on its own.
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      default:
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
    }
  }) as typeof fetch;
}

function resolveBehavior(
  options: StubFetchOptions,
  call: StubCall,
  callIndex: number,
): StubBehavior {
  if (options.resolve !== undefined) return options.resolve({ ...call, callIndex });
  const list = options.behaviors?.[call.providerId] ?? [{ kind: 'result', value: null }];
  return (list[Math.min(callIndex, list.length - 1)] ?? list[0]) as StubBehavior;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Convention: a stub URL looks like `https://stub.local/<providerId>`. */
function providerIdFromUrl(url: string): string {
  const match = /stub\.local\/([^/?#]+)/.exec(url);
  return match?.[1] ?? 'unknown';
}

/** Construct a test ProviderDescriptor. */
export function stubDescriptor(
  id: string,
  chain: ChainId,
  overrides: Partial<ProviderDescriptor> = {},
): ProviderDescriptor {
  const descriptor: ProviderDescriptor = {
    id: id as ProviderId,
    chain,
    network: 'testnet' as NetworkId,
    kind: 'json-rpc-http' as ProviderKind,
    endpointRef: `env:STUB_${id.toUpperCase().replace(/-/g, '_')}` as never,
    credentialRef: 'none',
    capabilities: ['account.balance', 'block.read', 'transaction.read'],
    priority: 10,
    weight: 1,
    timeoutMs: 200,
  };
  return { ...descriptor, ...overrides };
}
