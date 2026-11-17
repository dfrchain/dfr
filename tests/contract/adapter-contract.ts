/**
 * Adapter Contract Test（adapter-spec 第 9 章 L1，评审修正 R-08）。
 *
 * 对每个 Adapter 运行同一套断言。M2 的 Solana Adapter 必须直接调用本函数，
 * 为适配某条链而修改本文件即视为失败。
 */
import { describe, expect, it } from 'vitest';
import { isDfrError } from '@dfr/errors';
import type {
  AdapterContext,
  BlockRef,
  Chain,
  ChainAdapter,
  RequestId,
} from '@dfr/types';
import { createMockProviderRouter, type Handler } from './mock-provider.js';

export interface AdapterContractSubject {
  /** 契约测试展示名，例如 'EVM Adapter'。 */
  name: string;
  /** 被测 Chain（决定能力集合与最终性策略）。 */
  chain: Chain;
  /** 构造 Adapter 实例。 */
  createAdapter: (chain: Chain) => ChainAdapter;
  /** mock Provider 的 RPC 应答表。 */
  handlers: Record<string, Handler>;
  /** registry 声明的能力（用于 registry ⊆ adapter 校验）。 */
  registryCapabilities: readonly string[];
  /** 断言"未声明能力"的具体调用。 */
  unsupportedCall: (adapter: ChainAdapter, ctx: AdapterContext) => Promise<unknown>;
  /** 该链的非法地址样本。 */
  invalidAccount: string;
  /**
   * 该链**不支持**的 BlockRef 分支。
   *
   * 让"不支持的定位方式必须 fail-closed"成为**同一套**断言：测试不再写
   * `if (chain.family === 'evm')`，而是由各链声明自己拒绝哪些分支。
   * EVM 声明 `slot`；Solana 声明 `number` / `tag` / `hash`（ADR-027）。
   */
  unsupportedBlockRefs: readonly BlockRef[];
}

const REQUEST_ID = 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as RequestId;

export function makeContext(
  chain: Chain,
  handlers: Record<string, Handler>,
  onCall?: (method: string) => void,
): AdapterContext {
  const router = createMockProviderRouter({ chain: chain.id, handlers, ...(onCall ? { onCall } : {}) });
  return {
    chain: chain.id,
    network: chain.network,
    providers: router,
    signal: new AbortController().signal,
    requestId: REQUEST_ID,
  };
}

export function defineAdapterContract(subject: AdapterContractSubject): void {
  const { name, chain } = subject;

  describe(`${name} 契约（adapter-spec 第 9 章 L1）`, () => {
    it('capabilities() 返回结构合法', () => {
      const caps = subject.createAdapter(chain).capabilities();
      expect(caps.specVersion).toBe('0.1');
      expect(caps.chain).toBe(chain.id);
      expect(caps.network).toBe(chain.network);
      expect(Array.isArray(caps.capabilities)).toBe(true);
      expect(new Set(caps.capabilities).size).toBe(caps.capabilities.length);
    });

    it('registry ⊆ adapter：注册表声明的能力必须被 Adapter 实现', () => {
      const declared = new Set(subject.createAdapter(chain).capabilities().capabilities);
      const missing = subject.registryCapabilities.filter((c) => !declared.has(c as never));
      expect(missing).toEqual([]);
    });

    it('未声明的能力请求返回 DFR_UNSUPPORTED_CAPABILITY，不静默降级', async () => {
      const adapter = subject.createAdapter(chain);
      const ctx = makeContext(chain, subject.handlers);
      try {
        await subject.unsupportedCall(adapter, ctx);
        throw new Error('expected the call to fail');
      } catch (err) {
        expect(isDfrError(err)).toBe(true);
        if (isDfrError(err)) expect(err.code).toBe('DFR_UNSUPPORTED_CAPABILITY');
      }
    });

    it('非法账户返回 DFR_INVALID_ACCOUNT', async () => {
      const adapter = subject.createAdapter(chain) as unknown as {
        getBalance(ctx: AdapterContext, req: unknown): Promise<unknown>;
      };
      const ctx = makeContext(chain, subject.handlers);
      try {
        await adapter.getBalance(ctx, {
          account: { chain: chain.id, address: subject.invalidAccount },
        });
        throw new Error('expected the call to fail');
      } catch (err) {
        expect(isDfrError(err) && err.code).toBe('DFR_INVALID_ACCOUNT');
      }
    });

    it('不支持的 BlockRef 分支显式失败（不是静默降级）', async () => {
      // 链无关：各链在 subject 里声明自己拒绝哪些分支。这样 EVM 与 Solana 跑的是
      // **同一个断言**，差异由数据表达（ADR-027 / AGENTS.md §6）。
      expect(
        subject.unsupportedBlockRefs.length,
        '每个 Adapter 至少要声明一个自己不支持的 BlockRef 分支',
      ).toBeGreaterThan(0);

      const adapter = subject.createAdapter(chain) as unknown as {
        getBlock(ctx: AdapterContext, ref: BlockRef): Promise<unknown>;
      };
      const ctx = makeContext(chain, subject.handlers);
      for (const ref of subject.unsupportedBlockRefs) {
        try {
          await adapter.getBlock(ctx, ref);
          throw new Error(`expected ${ref.kind} to fail`);
        } catch (err) {
          expect(isDfrError(err) && err.code, `BlockRef ${ref.kind} 应 fail-closed`).toBe(
            'DFR_UNSUPPORTED_CAPABILITY',
          );
        }
      }
    });

    it('Adapter 不携带任何私钥 / 凭证字段', () => {
      const adapter = subject.createAdapter(chain) as unknown as Record<string, unknown>;
      const serialized = `${JSON.stringify(adapter, (_k, v) => (typeof v === 'function' ? '[fn]' : v))}`;
      for (const forbidden of ['privateKey', 'private_key', 'mnemonic', 'seedPhrase', 'signedPayload']) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });
}
