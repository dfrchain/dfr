/**
 * Adapter Contract Test (adapter-spec Chapter 9 L1, review fix R-08).
 *
 * Runs the same set of assertions against every Adapter. The M2 Solana Adapter must call this function directly;
 * modifying this file to fit a chain counts as a failure.
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
  /** Contract test display name, e.g. 'EVM Adapter'. */
  name: string;
  /** The Chain under test (determines the capability set and finality policy). */
  chain: Chain;
  /** Construct an Adapter instance. */
  createAdapter: (chain: Chain) => ChainAdapter;
  /** mock Provider RPC response table. */
  handlers: Record<string, Handler>;
  /** Capabilities declared by the registry (for the registry ⊆ adapter check). */
  registryCapabilities: readonly string[];
  /** The concrete call asserting an "undeclared capability". */
  unsupportedCall: (adapter: ChainAdapter, ctx: AdapterContext) => Promise<unknown>;
  /** An invalid-address sample for this chain. */
  invalidAccount: string;
  /**
   * BlockRef branches this chain does **not** support.
   *
   * Make "an unsupported addressing mode must fail closed" the **same** assertion: tests no longer write
   * `if (chain.family === 'evm')`; instead each chain declares which branches it rejects.
   * EVM declares `slot`; Solana declares `number` / `tag` / `hash` (ADR-027).
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

  describe(`${name} Contract (adapter-spec Chapter 9 L1)`, () => {
    it('capabilities() returns a valid structure', () => {
      const caps = subject.createAdapter(chain).capabilities();
      expect(caps.specVersion).toBe('0.1');
      expect(caps.chain).toBe(chain.id);
      expect(caps.network).toBe(chain.network);
      expect(Array.isArray(caps.capabilities)).toBe(true);
      expect(new Set(caps.capabilities).size).toBe(caps.capabilities.length);
    });

    it('registry ⊆ adapter: capabilities declared by the registry must be implemented by the Adapter', () => {
      const declared = new Set(subject.createAdapter(chain).capabilities().capabilities);
      const missing = subject.registryCapabilities.filter((c) => !declared.has(c as never));
      expect(missing).toEqual([]);
    });

    it('a request for an undeclared capability returns DFR_UNSUPPORTED_CAPABILITY, without silent downgrade', async () => {
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

    it('an invalid account returns DFR_INVALID_ACCOUNT', async () => {
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

    it('an unsupported BlockRef branch fails explicitly (not a silent downgrade)', async () => {
      // Chain-agnostic: each chain declares in subject which branches it rejects. That way EVM and Solana run the
      // **same assertion**, with the differences expressed as data (ADR-027 / AGENTS.md §6).
      expect(
        subject.unsupportedBlockRefs.length,
        'Every Adapter must declare at least one BlockRef branch it does not support',
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
          expect(isDfrError(err) && err.code, `BlockRef ${ref.kind} must fail closed`).toBe(
            'DFR_UNSUPPORTED_CAPABILITY',
          );
        }
      }
    });

    it('Adapter carries no private key / credential fields', () => {
      const adapter = subject.createAdapter(chain) as unknown as Record<string, unknown>;
      const serialized = `${JSON.stringify(adapter, (_k, v) => (typeof v === 'function' ? '[fn]' : v))}`;
      for (const forbidden of ['privateKey', 'private_key', 'mnemonic', 'seedPhrase', 'signedPayload']) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });
}
