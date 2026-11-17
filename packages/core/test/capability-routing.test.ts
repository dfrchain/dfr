/**
 * Core 能力路由的两条失败路径（testing-strategy §8：Capability 路由 100%）。
 *
 * 规范要求"每个能力的支持/不支持两条路径"都被覆盖。`DFR_UNSUPPORTED_CAPABILITY`
 * 有两个成因，二者语义不同、必须区分（observability-spec §5.2 分别计数）：
 *
 *   - `capability_not_declared`：Adapter 没声明该能力 → 正常的"这条链不支持"；
 *   - `method_missing`：Registry 声明了、Adapter 却没有对应方法 → 启动校验被绕过，
 *     属**配置事故**，正常应恒为 0。
 *
 * 后者需要刻意构造一个"能力清单与实现不一致"的 Adapter 才能触发。
 */
import { describe, expect, it } from 'vitest';
import { ChainRegistry } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import type { ChainAdapter } from '@dfr/types';

const REGISTRY_YAML = `
schemaVersion: "1"
updatedAt: "2026-10-03T00:00:00Z"
chains:
  ethereum-sepolia:
    displayName: "Ethereum Sepolia"
    family: evm
    network: testnet
    externalChainId: "11155111"
    adapter: { id: evm, version: "^0.1.0" }
    finality: { kind: checkpoint, finalizedTag: true }
    finalityStatus: unverified
    capabilities: [account.balance, block.read, transaction.read]
    milestone: M0
providers:
  stub-primary:
    chain: ethereum-sepolia
    kind: json-rpc-http
    endpointRef: "env:STUB_PRIMARY_URL"
    credentialRef: "none"
    priority: 10
    weight: 1
    timeoutMs: 5000
    cost: { unit: request, priceUsd: "0" }
`;

function registry(): ChainRegistry {
  return ChainRegistry.fromText(REGISTRY_YAML, {
    env: { STUB_PRIMARY_URL: 'https://stub.local/primary' },
    source: 'capability-routing-test',
  });
}

/** 声明全部能力、但不实现任何方法的 Adapter（模拟启动校验被绕过）。 */
function declaredButUnimplemented(chain: unknown): ChainAdapter {
  return {
    family: 'evm',
    version: '0.1.0',
    specVersion: '0.1',
    getInfo: async () => ({}) as never,
    capabilities: () => ({
      specVersion: '0.1',
      chain: (chain as { id: string }).id as never,
      network: 'testnet' as never,
      capabilities: ['account.balance', 'block.read', 'transaction.read'] as never,
    }),
  } as unknown as ChainAdapter;
}

function makeCore(create: (chain: unknown) => ChainAdapter, onCapabilityUnsupported?: (e: unknown) => void): DfrCore {
  return new DfrCore({
    registry: registry(),
    adapters: [{ id: 'evm', version: '0.1.0', create }],
    milestone: 'M0',
    ...(onCapabilityUnsupported !== undefined
      ? { onCapabilityUnsupported: onCapabilityUnsupported as never }
      : {}),
  });
}

const ctx = { requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never };

describe('Core 能力路由：method_missing（Registry 声明但 Adapter 未实现）', () => {
  it('getBalance：声明了 account.balance 但没有方法 → UNSUPPORTED，且计为 method_missing', async () => {
    const seen: Array<{ kind?: string; capability?: string }> = [];
    const core = makeCore(declaredButUnimplemented, (event) => {
      seen.push(event as { kind?: string; capability?: string });
    });

    await expect(
      core.getBalance(
        {
          chain: 'ethereum-sepolia' as never,
          account: { chain: 'ethereum-sepolia' as never, address: '0x1111111111111111111111111111111111111111' },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('method_missing');
    expect(seen[0]?.capability).toBe('account.balance');
  });

  it('getBlock：同上，block.read 缺方法 → method_missing', async () => {
    const seen: Array<{ kind?: string }> = [];
    const core = makeCore(declaredButUnimplemented, (event) => {
      seen.push(event as { kind?: string });
    });
    await expect(
      core.getBlock('ethereum-sepolia' as never, { kind: 'tag', tag: 'latest' }, ctx),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
    expect(seen[0]?.kind).toBe('method_missing');
  });

  it('getTransaction：同上，transaction.read 缺方法 → method_missing', async () => {
    const seen: Array<{ kind?: string }> = [];
    const core = makeCore(declaredButUnimplemented, (event) => {
      seen.push(event as { kind?: string });
    });
    await expect(
      core.getTransaction('ethereum-sepolia' as never, { kind: 'hash', hash: `0x${'a'.repeat(64)}` }, ctx),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
    expect(seen[0]?.kind).toBe('method_missing');
  });
});

describe('Core 启动校验：registry ⊄ adapter 时 fail-closed', () => {
  it('Adapter 未声明 Registry 要求的能力时，构造 Core 直接失败（不进入运行期）', () => {
    // 这条解释了一个重要事实：`capability_not_declared` **不会**因为"Registry 声明了、
    // Adapter 没声明"而在运行期出现——那是启动校验的职责，会在这里直接拒绝。
    // 运行期该分支只会在 Core 请求一个 Adapter 未声明的能力时触发（见上面的 method_missing
    // 与 gateway 端点的 422 用例）。
    expect(() =>
      new DfrCore({
        registry: registry(),
        adapters: [
          {
            id: 'evm',
            version: '0.1.0',
            create: (chain) =>
              ({
                family: 'evm',
                version: '0.1.0',
                specVersion: '0.1',
                getInfo: async () => ({}) as never,
                capabilities: () => ({
                  specVersion: '0.1',
                  chain: (chain as { id: string }).id as never,
                  network: 'testnet' as never,
                  capabilities: ['block.read'] as never,
                }),
              }) as unknown as ChainAdapter,
          },
        ],
        milestone: 'M0',
      }),
    ).toThrowError(/registry 能力超出 Adapter 声明/u);
  });
});

describe('Core 公开只读 API', () => {
  const unimplemented = (chain: unknown): ChainAdapter =>
    ({
      family: 'evm',
      version: '0.1.0',
      specVersion: '0.1',
      getInfo: async () => ({}) as never,
      capabilities: () => ({
        specVersion: '0.1',
        chain: (chain as { id: string }).id as never,
        network: 'testnet' as never,
        capabilities: ['account.balance', 'block.read', 'transaction.read'] as never,
      }),
    }) as unknown as ChainAdapter;

  it('hasChain 对已注册链为 true、对未知链为 false', () => {
    const core = makeCore(unimplemented);
    expect(core.hasChain('ethereum-sepolia')).toBe(true);
    expect(core.hasChain('base-sepolia')).toBe(false);
  });

  it('providerHealth 对未配置端点的链返回空快照（不抛错、不伪造）', () => {
    const core = makeCore(unimplemented);
    // 该链在测试 Registry 里没有可用 Provider 端点，管理器的惰性构造会被跳过，
    // 因此快照为空数组——这既是"不伪造",也是 `/readyz` 的 0 providers 口径。
    expect(core.providerHealth()).toEqual({ 'ethereum-sepolia': [] });
  });

  it('listChains 只返回当前 milestone 下启用的链', () => {
    const core = makeCore(unimplemented);
    expect(core.listChains().map((c) => c.id)).toEqual(['ethereum-sepolia']);
  });
});

describe('Core 排序前提过期路由（M3-A01，ADR-032）', () => {
  const token = {
    kind: 'blockhash' as const,
    value: '1'.repeat(48) + '2345', // secret-scan:allow public-blockhash-placeholder
    lastValidBlockHeight: '1000' as never,
  };

  function withExpiry(answer: boolean | 'missing'): DfrCore {
    return makeCore((chain) => {
      const base = {
        family: 'solana',
        version: '0.1.0',
        specVersion: '0.1',
        getInfo: async () => ({}) as never,
        capabilities: () => ({
          specVersion: '0.1',
          chain: (chain as { id: string }).id as never,
          network: 'testnet' as never,
          capabilities: ['account.balance', 'block.read', 'transaction.read'] as never,
        }),
      } as unknown as ChainAdapter;
      if (answer === 'missing') return base;
      return { ...base, isSequencingExpired: async () => answer } as unknown as ChainAdapter;
    });
  }

  it('Adapter 实现该方法时按它的判定返回', async () => {
    await expect(withExpiry(true).isSequencingExpired('ethereum-sepolia' as never, token, ctx)).resolves.toBe(true);
    await expect(withExpiry(false).isSequencingExpired('ethereum-sepolia' as never, token, ctx)).resolves.toBe(false);
  });

  it('B41: 缺少 Solana blockhash 过期检查能力，必须 fail-closed，不得假装仍有效', async () => {
    await expect(
      withExpiry('missing').isSequencingExpired('ethereum-sepolia' as never, token, ctx),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('B41: EVM nonce 不按区块高度过期，缺少方法时仍兼容返回 false', async () => {
    const nonce = { kind: 'nonce' as const, value: '42' as never };
    await expect(
      withExpiry('missing').isSequencingExpired('ethereum-sepolia' as never, nonce, ctx),
    ).resolves.toBe(false);
  });
});
