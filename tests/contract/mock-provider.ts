/**
 * 契约测试用的 mock ProviderRouter。
 *
 * 评审修正 R-08：Adapter 契约测试是 **M0 交付物**，必须用 mock Provider 离线运行，
 * 不依赖公网端点。M2 的 Solana Adapter 必须通过**同一套**测试，不允许为它改测试。
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
   * 记录调用顺序，供断言"未声明的能力没有被静默降级"。
   *
   * 第二个参数是完整调用，供广播类断言"标记为 non-idempotent-write 且只调用一次"；
   * 只关心方法名的既有调用方可以忽略它（TS 允许少参数回调）。
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
          message: `mock 未实现方法 ${call.method}`,
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
