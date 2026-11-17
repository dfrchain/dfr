import { describe, expect, it } from 'vitest';
import { ChainRegistry } from '../src/index.js';
import { isDfrError } from '@dfr/errors';

const MINIMAL = `
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
    capabilities: [account.balance, block.read]
    milestone: M0
providers:
  primary:
    chain: ethereum-sepolia
    kind: json-rpc-http
    endpointRef: "env:TEST_PRIMARY_URL"
    credentialRef: "none"
    priority: 10
    weight: 1
    timeoutMs: 10000
    cost: { unit: request, priceUsd: "0" }
`;

const load = (text: string, env: NodeJS.ProcessEnv = {}) =>
  ChainRegistry.fromText(text, { env, source: 'test' });

describe('Chain Registry 加载与投影（DFR-005）', () => {
  it('加载仓库内真实 chains.yaml', () => {
    const registry = ChainRegistry.load({ env: {} });
    const ids = registry.listChains().map((c) => c.id);
    expect(ids).toContain('ethereum-sepolia');
    expect(registry.providerCount('ethereum-sepolia')).toBe(2);
    expect(registry.updatedAt).toBe('2026-10-03T00:00:00Z');
  });

  it('milestone 是部署元数据，不进入领域模型 Chain（审计修正 A-01）', () => {
    const chain = load(MINIMAL).listChains()[0]!;
    expect(chain).not.toHaveProperty('milestone');
    expect(load(MINIMAL).getEntry('ethereum-sepolia').milestone).toBe('M0');
  });

  it('Provider 的 network 由 chain 派生，不需要在配置里重复声明（审计修正 A-08）', () => {
    const provider = load(MINIMAL).listProviders()[0]!;
    expect(provider.network).toBe('testnet');
    expect(provider.capabilities).toEqual(['account.balance', 'block.read']);
  });
});

describe('配置校验是 fail-closed 的', () => {
  it('未知能力 → DFR_CONFIGURATION_ERROR', () => {
    const bad = MINIMAL.replace('capabilities: [account.balance, block.read]', 'capabilities: [account.balance, chain.info]');
    expect(() => load(bad)).toThrowError();
    try {
      load(bad);
    } catch (err) {
      expect(isDfrError(err) && (err as { code: string }).code).toBe('DFR_CONFIGURATION_ERROR');
    }
  });

  it('孤儿 Provider（指向不存在的 chain）被拒绝', () => {
    const bad = MINIMAL.replace('chain: ethereum-sepolia\n    kind: json-rpc-http', 'chain: no-such-chain\n    kind: json-rpc-http');
    expect(() => load(bad)).toThrowError(/孤儿 Provider|不存在的 chain/);
  });

  it('priority 越界被 schema 拒绝（与评分量纲一致）', () => {
    const bad = MINIMAL.replace('priority: 10', 'priority: 100');
    expect(() => load(bad)).toThrowError(/schema/);
  });

  it('明文密钥被拒绝，且报错信息不回显密钥本体', () => {
    const bad = MINIMAL.replace('"env:TEST_PRIMARY_URL"', '"0x' + 'a'.repeat(64) + '"');
    try {
      load(bad);
      throw new Error('should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/疑似密钥/);
      expect(message).not.toContain('a'.repeat(64));
    }
  });

  it('endpointRef 必须是引用形式，禁止内联明文 URL', () => {
    const bad = MINIMAL.replace('"env:TEST_PRIMARY_URL"', '"https://rpc.example.com/v1"');
    expect(() => load(bad)).toThrowError();
  });
});

describe('引用解析（env: / none）', () => {
  it('env: 从注入的环境变量读取端点', () => {
    const registry = load(MINIMAL, { TEST_PRIMARY_URL: 'https://rpc.example.com' });
    const provider = registry.listProviders()[0]!;
    expect(registry.resolveEndpoint(provider)).toBe('https://rpc.example.com');
  });

  it('credentialRef: none 表示公开端点', () => {
    const registry = load(MINIMAL, { TEST_PRIMARY_URL: 'https://rpc.example.com' });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBeUndefined();
  });

  it('端点环境变量缺失 → 配置错误（不把请求发往未定义地址）', () => {
    const registry = load(MINIMAL, {});
    expect(() => registry.resolveEndpoint(registry.listProviders()[0]!)).toThrowError(/TEST_PRIMARY_URL/);
  });

  it('凭证环境变量缺失视为未认证访问，返回 undefined 而非报错', () => {
    const withCred = MINIMAL.replace('credentialRef: "none"', 'credentialRef: "env:TEST_KEY"');
    const registry = load(withCred, { TEST_PRIMARY_URL: 'https://rpc.example.com' });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBeUndefined();
  });
});

describe('registry ⊆ adapter 启动校验（评审修正 R-03）', () => {
  it('Adapter 声明覆盖 registry 时通过', () => {
    const registry = load(MINIMAL);
    expect(() =>
      registry.assertAdapterCapabilities('ethereum-sepolia', ['account.balance', 'block.read', 'transaction.read']),
    ).not.toThrow();
  });

  it('Adapter 缺少 registry 声明的能力 → 拒绝启动', () => {
    const registry = load(MINIMAL);
    expect(() => registry.assertAdapterCapabilities('ethereum-sepolia', ['account.balance'])).toThrowError(
      /超出 Adapter 声明/,
    );
  });
});

describe('查找失败的错误归类', () => {
  it('未知链 → DFR_NOT_FOUND', () => {
    try {
      load(MINIMAL).getEntry('nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect(isDfrError(err) && err.code).toBe('DFR_NOT_FOUND');
    }
  });
});
