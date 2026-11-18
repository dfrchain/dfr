// Behavior of `vault:` references at the Registry layer (M5 production hardening E4).
//
// The assertions here target **semantics**, not implementation:
// - Without a configured vault, it must **throw a configuration error** and never pass as "unauthenticated" (fail-closed);
// - An explicitly injected reader can retrieve values;
// - A missing credential keeps the existing semantics (undefined = unauthenticated), consistent with `env:`.
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

describe('vault: references', () => {
  it('an injected VaultReader can resolve credentials', () => {
    const registry = ChainRegistry.fromText(withVault('vault:providers/eth.key'), {
      env: { TEST_PRIMARY_URL: 'https://rpc.example.com' },
      vault: new FileVaultReader(vault()),
      source: 'test',
    });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBe('vault-secret');
  });

  it('without a configured vault it **throws a configuration error** instead of silently passing as unauthenticated', () => {
    const registry = ChainRegistry.fromText(withVault('vault:providers/eth.key'), {
      env: { TEST_PRIMARY_URL: 'https://rpc.example.com' },
      source: 'test',
    });
    expect(() => registry.resolveCredential(registry.listProviders()[0]!)).toThrowError(/DFR_VAULT_DIR/);
  });

  it('a missing vault entry returns undefined as "not provided" (keeping the env: semantics)', () => {
    const registry = ChainRegistry.fromText(withVault('vault:providers/missing.key'), {
      env: { TEST_PRIMARY_URL: 'https://rpc.example.com' },
      vault: new FileVaultReader(vault()),
      source: 'test',
    });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBeUndefined();
  });

  it('path escapes cannot retrieve values at the Registry layer either (no leak, no pass-through)', () => {
    const registry = ChainRegistry.fromText(withVault('vault:../../../../etc/hosts'), {
      env: { TEST_PRIMARY_URL: 'https://rpc.example.com' },
      vault: new FileVaultReader(vault()),
      source: 'test',
    });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBeUndefined();
  });

  it('an endpoint using vault with a missing entry must error (endpoints may not be missing)', () => {
    const text = withVault('none').replace('endpointRef: "env:TEST_PRIMARY_URL"', 'endpointRef: "vault:providers/missing.key"');
    const registry = ChainRegistry.fromText(text, {
      env: {},
      vault: new FileVaultReader(vault()),
      source: 'test',
    });
    expect(() => registry.resolveEndpoint(registry.listProviders()[0]!)).toThrowError(/vault/);
  });
});
