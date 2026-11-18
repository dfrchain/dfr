/**
 * mock ProviderRouter for contract tests.
 *
 * Review fix R-08: Adapter contract tests are an **M0 deliverable** and must run offline against a mock Provider,
 * without depending on any public endpoint. The M2 Solana Adapter must pass the **same** tests; the tests may not
 * be changed for it.
 */
import { createDfrError } from '@dfr/errors';
import type {
  ChainId,
  ProviderCall,
  ProviderContext,
  ProviderHandle,
  ProviderRequirements,
  ProviderRouter,
} from '@dfr/types';

export type Handler = (params: readonly unknown[]) => unknown;

export interface MockRouterOptions {
  chain: ChainId;
  handlers: Record<string, Handler>;
  /**
   * Records call order, for asserting that an "undeclared capability was not silently downgraded".
   *
   * The second parameter is the full call, for broadcast assertions that it is "marked non-idempotent-write and
   * called exactly once"; existing callers that only care about the method name can ignore it
   * (TS allows callbacks with fewer parameters).
   */
  onCall?: (method: string, call: ProviderCall) => void;
}

export function createMockProviderRouter(options: MockRouterOptions): ProviderRouter {
  let acquired = 0;
  const handle: ProviderHandle = {
    id: 'mock-primary' as never,
    chain: options.chain,
    async request<T>(call: ProviderCall, _ctx: ProviderContext): Promise<T> {
      options.onCall?.(call.method, call);
      const handler = options.handlers[call.method];
      if (handler === undefined) {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          message: `mock has not implemented method ${call.method}`,
          chain: options.chain,
        });
      }
      return handler(call.params) as T;
    },
  };

  return {
    chain: options.chain,
    async acquire(_requirements?: ProviderRequirements): Promise<ProviderHandle> {
      acquired += 1;
      return handle;
    },
    get acquired(): number {
      return acquired;
    },
  } as ProviderRouter & { acquired: number };
}
