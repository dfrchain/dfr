// `vault:` 引用在 Registry 层的行为（M5 生产加固 E4）。
//
// 这里的断言针对**语义**，不是实现：
// - 未配置 vault 时必须**抛配置错误**，绝不当成"未认证"放行（fail-closed）；
// - 显式注入 reader 时能取到值；
// - 凭证缺失仍沿用既有语义（undefined = 未认证），与 `env:` 一致。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChainRegistry, FileVaultReader } from '../src/index.js';

const withVault = (credentialRef: string): string => `
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
    credentialRef: "${credentialRef}"
    priority: 10
    weight: 1
    timeoutMs: 10000
    cost: { unit: request, priceUsd: "0" }
`;

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'dfr-registry-vault-'));
  mkdirSync(join(root, 'providers'), { recursive: true });
  writeFileSync(join(root, 'providers', 'eth.key'), 'vault-secret', 'utf8');
  return root;
}

describe('vault: 引用', () => {
  it('注入 VaultReader 后可解析凭证', () => {
    const registry = ChainRegistry.fromText(withVault('vault:providers/eth.key'), {
      env: { TEST_PRIMARY_URL: 'https://rpc.example.com' },
      vault: new FileVaultReader(vault()),
      source: 'test',
    });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBe('vault-secret');
  });

  it('未配置 vault 时**抛配置错误**，不静默当作未认证', () => {
    const registry = ChainRegistry.fromText(withVault('vault:providers/eth.key'), {
      env: { TEST_PRIMARY_URL: 'https://rpc.example.com' },
      source: 'test',
    });
    expect(() => registry.resolveCredential(registry.listProviders()[0]!)).toThrowError(/DFR_VAULT_DIR/);
  });

  it('vault 中条目不存在时按"未提供"返回 undefined（沿用 env: 语义）', () => {
    const registry = ChainRegistry.fromText(withVault('vault:providers/missing.key'), {
      env: { TEST_PRIMARY_URL: 'https://rpc.example.com' },
      vault: new FileVaultReader(vault()),
      source: 'test',
    });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBeUndefined();
  });

  it('路径逃逸在 Registry 层同样取不到值（不泄漏、放行）', () => {
    const registry = ChainRegistry.fromText(withVault('vault:../../../../etc/hosts'), {
      env: { TEST_PRIMARY_URL: 'https://rpc.example.com' },
      vault: new FileVaultReader(vault()),
      source: 'test',
    });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBeUndefined();
  });

  it('端点使用 vault 且条目缺失时必须报错（端点不可缺失）', () => {
    const text = withVault('none').replace('endpointRef: "env:TEST_PRIMARY_URL"', 'endpointRef: "vault:providers/missing.key"');
    const registry = ChainRegistry.fromText(text, {
      env: {},
      vault: new FileVaultReader(vault()),
      source: 'test',
    });
    expect(() => registry.resolveEndpoint(registry.listProviders()[0]!)).toThrowError(/vault/);
  });
});
