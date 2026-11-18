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

describe('Chain Registry loading and projection (DFR-005)', () => {
  it('loads the real chains.yaml in the repo', () => {
    const registry = ChainRegistry.load({ env: {} });
    const ids = registry.listChains().map((c) => c.id);
    expect(ids).toContain('ethereum-sepolia');
    expect(registry.providerCount('ethereum-sepolia')).toBe(2);
    expect(registry.updatedAt).toBe('2026-10-03T00:00:00Z');
  });

  it('milestone is deployment metadata and does not enter the domain model Chain (audit fix A-01)', () => {
    const chain = load(MINIMAL).listChains()[0]!;
    expect(chain).not.toHaveProperty('milestone');
    expect(load(MINIMAL).getEntry('ethereum-sepolia').milestone).toBe('M0');
  });

  it("a Provider's network is derived from its chain and need not be declared again in config (audit fix A-08)", () => {
    const provider = load(MINIMAL).listProviders()[0]!;
    expect(provider.network).toBe('testnet');
    expect(provider.capabilities).toEqual(['account.balance', 'block.read']);
  });
});

describe('config validation is fail-closed', () => {
  it('unknown capability → DFR_CONFIGURATION_ERROR', () => {
    const bad = MINIMAL.replace('capabilities: [account.balance, block.read]', 'capabilities: [account.balance, chain.info]');
    expect(() => load(bad)).toThrowError();
    try {
      load(bad);
    } catch (err) {
      expect(isDfrError(err) && (err as { code: string }).code).toBe('DFR_CONFIGURATION_ERROR');
    }
  });

  it('an orphaned Provider (pointing at a nonexistent chain) is rejected', () => {
    const bad = MINIMAL.replace('chain: ethereum-sepolia\n    kind: json-rpc-http', 'chain: no-such-chain\n    kind: json-rpc-http');
    expect(() => load(bad)).toThrowError(/orphaned Provider|nonexistent chain/);
  });

  it('an out-of-range priority is rejected by the schema (consistent with the scoring scale)', () => {
    const bad = MINIMAL.replace('priority: 10', 'priority: 100');
    expect(() => load(bad)).toThrowError(/schema/);
  });

  it('a plaintext secret is rejected, and the error does not echo the secret itself', () => {
    const bad = MINIMAL.replace('"env:TEST_PRIMARY_URL"', '"0x' + 'a'.repeat(64) + '"');
    try {
      load(bad);
      throw new Error('should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/suspected secret/);
      expect(message).not.toContain('a'.repeat(64));
    }
  });

  it('endpointRef must be a reference form; inline plaintext URLs are forbidden', () => {
    const bad = MINIMAL.replace('"env:TEST_PRIMARY_URL"', '"https://rpc.example.com/v1"');
    expect(() => load(bad)).toThrowError();
  });
});

describe('reference resolution (env: / none)', () => {
  it('env: reads the endpoint from an injected environment variable', () => {
    const registry = load(MINIMAL, { TEST_PRIMARY_URL: 'https://rpc.example.com' });
    const provider = registry.listProviders()[0]!;
    expect(registry.resolveEndpoint(provider)).toBe('https://rpc.example.com');
  });

  it('credentialRef: none means a public endpoint', () => {
    const registry = load(MINIMAL, { TEST_PRIMARY_URL: 'https://rpc.example.com' });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBeUndefined();
  });

  it('a missing endpoint environment variable → configuration error (no request is sent to an undefined address)', () => {
    const registry = load(MINIMAL, {});
    expect(() => registry.resolveEndpoint(registry.listProviders()[0]!)).toThrowError(/TEST_PRIMARY_URL/);
  });

  it('a missing credential environment variable is treated as unauthenticated access and returns undefined instead of erroring', () => {
    const withCred = MINIMAL.replace('credentialRef: "none"', 'credentialRef: "env:TEST_KEY"');
    const registry = load(withCred, { TEST_PRIMARY_URL: 'https://rpc.example.com' });
    expect(registry.resolveCredential(registry.listProviders()[0]!)).toBeUndefined();
  });
});

describe('registry ⊆ adapter startup validation (review fix R-03)', () => {
  it('passes when Adapter declarations cover the registry', () => {
    const registry = load(MINIMAL);
    expect(() =>
      registry.assertAdapterCapabilities('ethereum-sepolia', ['account.balance', 'block.read', 'transaction.read']),
    ).not.toThrow();
  });

  it('refuses to start when the Adapter lacks a capability declared by the registry', () => {
    const registry = load(MINIMAL);
    expect(() => registry.assertAdapterCapabilities('ethereum-sepolia', ['account.balance'])).toThrowError(
      /beyond those declared by the Adapter/,
    );
  });
});

describe('error classification for failed lookups', () => {
  it('unknown chain → DFR_NOT_FOUND', () => {
    try {
      load(MINIMAL).getEntry('nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect(isDfrError(err) && err.code).toBe('DFR_NOT_FOUND');
    }
  });
});
