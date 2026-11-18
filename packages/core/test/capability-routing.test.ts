/**
 * The two failure paths of Core capability routing (testing-strategy §8: 100% Capability routing).
 *
 * The spec requires both the supported and unsupported paths of every capability to be covered. `DFR_UNSUPPORTED_CAPABILITY`
 * has two causes with different semantics that must be distinguished (observability-spec §5.2 counts them separately):
 *
 *   - `capability_not_declared`: the Adapter did not declare the capability → the normal "this chain does not support it";
 *   - `method_missing`: the Registry declared it but the Adapter has no matching method → startup validation was bypassed,
 *     a **configuration incident**, normally always 0.
 *
 * The latter needs a deliberately constructed Adapter whose capability list disagrees with its implementation to trigger.
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

/** An Adapter that declares all capabilities but implements none of the methods (simulating bypassed startup validation). */
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

describe('Core capability routing: method_missing (Registry declares it but the Adapter does not implement it)', () => {
  it('getBalance: declared account.balance but has no method → UNSUPPORTED, counted as method_missing', async () => {
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

  it('getBlock: same as above; block.read missing its method → method_missing', async () => {
    const seen: Array<{ kind?: string }> = [];
    const core = makeCore(declaredButUnimplemented, (event) => {
      seen.push(event as { kind?: string });
    });
    await expect(
      core.getBlock('ethereum-sepolia' as never, { kind: 'tag', tag: 'latest' }, ctx),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
    expect(seen[0]?.kind).toBe('method_missing');
  });

  it('getTransaction: same as above; transaction.read missing its method → method_missing', async () => {
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

describe('Core startup validation: fail-closed when registry ⊄ adapter', () => {
  it('when the Adapter does not declare a Registry-required capability, constructing Core fails directly (never reaches runtime)', () => {
    // This explains an important fact: `capability_not_declared` **never** appears at runtime because "the Registry declared it
    // but the Adapter did not declare it" — that is the startup validation's job; it refuses directly here.
    // At runtime, that branch only triggers when Core requests a capability the Adapter did not declare (see the method_missing case above
    // and the gateway endpoint's 422 case).
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
    ).toThrowError(/registry capabilities beyond those declared by the Adapter/u);
  });
});

describe('Core public read-only API', () => {
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

  it('hasChain is true for a registered chain and false for an unknown chain', () => {
    const core = makeCore(unimplemented);
    expect(core.hasChain('ethereum-sepolia')).toBe(true);
    expect(core.hasChain('base-sepolia')).toBe(false);
  });

  it('providerHealth returns an empty snapshot for a chain with no configured endpoints (no throw, no fabrication)', () => {
    const core = makeCore(unimplemented);
    // That chain has no usable Provider endpoint in the test Registry, so the Manager's lazy construction is skipped,
    // and the snapshot is therefore an empty array — both "no fabrication" and the `/readyz` 0-providers wording.
    expect(core.providerHealth()).toEqual({ 'ethereum-sepolia': [] });
  });

  it('listChains only returns chains enabled under the current milestone', () => {
    const core = makeCore(unimplemented);
    expect(core.listChains().map((c) => c.id)).toEqual(['ethereum-sepolia']);
  });
});

describe('Core ordering-precondition expiry routing (M3-A01, ADR-032)', () => {
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

  it('when the Adapter implements the method, return by its decision', async () => {
    await expect(withExpiry(true).isSequencingExpired('ethereum-sepolia' as never, token, ctx)).resolves.toBe(true);
    await expect(withExpiry(false).isSequencingExpired('ethereum-sepolia' as never, token, ctx)).resolves.toBe(false);
  });

  it('B41: without the Solana blockhash expiry-check capability, it must fail closed and never pretend it is still valid', async () => {
    await expect(
      withExpiry('missing').isSequencingExpired('ethereum-sepolia' as never, token, ctx),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('B41: an EVM nonce does not expire by block height; without the method, still compatibly return false', async () => {
    const nonce = { kind: 'nonce' as const, value: '42' as never };
    await expect(
      withExpiry('missing').isSequencingExpired('ethereum-sepolia' as never, nonce, ctx),
    ).resolves.toBe(false);
  });
});
