/**
 * 测试替身（评审修正 R-11）。
 *
 * "主 Provider 掉线可自愈"这类验收项不能用公网端点确定性复现，必须由
 * **可编程失败的 Provider 替身**驱动。本文件同时提供：
 * - ProgrammableProvider：按脚本返回成功/失败/超时；
 * - createStubFetch：拦截 fetch 调用，供 JsonRpcHttpProvider 走完整传输路径。
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
  /** 按 providerId 分组的调用序列；用尽后复用最后一项。 */
  behaviors?: Record<string, StubBehavior[]>;
  /** 按 method 决定应答；与 behaviors 二选一（resolve 优先）。 */
  resolve?: (call: StubCall & { callIndex: number }) => StubBehavior;
  /** 每次调用记录，供断言"广播没有被重试"等。 */
  onCall?: (call: StubCall) => void;
}

/**
 * 构造一个可编程的 fetch 实现。
 *
 * `behaviors` 按 providerId 分组；每个数组是该 Provider 的调用序列，
 * 用尽后复用最后一项（便于表达"一直失败"）。
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
          // 由调用方的 AbortSignal 触发；这里只保证永不主动 resolve。
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

/** 约定：stub URL 形如 `https://stub.local/<providerId>`。 */
function providerIdFromUrl(url: string): string {
  const match = /stub\.local\/([^/?#]+)/.exec(url);
  return match?.[1] ?? 'unknown';
}

/** 构造测试用 ProviderDescriptor。 */
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
