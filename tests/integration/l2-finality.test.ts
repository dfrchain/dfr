/**
 * M4 two-leg finality read-only snapshot (Base Sepolia / Arbitrum Sepolia).
 *
 * Skipped by default; enable explicitly (read-only, no funds/private keys needed):
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL=https://sepolia.base.org \
 *   DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_URL=https://sepolia-rollup.arbitrum.io/rpc \
 *   pnpm vitest run tests/integration/l2-finality.test.ts
 *
 * This pins down that "the checkpoint/finalizedTag declarations in chains.yaml hold on the real chains",
 * matching the conclusions in docs/reviews/2026-10-06-base-sepolia-finality-evidence.md.
 */
import { describe, expect, it } from 'vitest';
import { ChainRegistry } from '@dfr/registry';
import type { ChainId } from '@dfr/types';

const RUN = process.env['DFR_RUN_TESTNET'] === '1';
const BASE = process.env['DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL'];
const ARB = process.env['DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_URL'];
const ENABLED = RUN && BASE !== undefined && BASE !== '' && ARB !== undefined && ARB !== '';

const LEGS: ReadonlyArray<{ chain: ChainId; url: string; expectedChainId: number }> = [
  { chain: 'base-sepolia' as ChainId, url: BASE ?? '', expectedChainId: 84532 },
  { chain: 'arbitrum-sepolia' as ChainId, url: ARB ?? '', expectedChainId: 421614 },
];

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error !== undefined) throw new Error(JSON.stringify(json.error));
  return json.result;
}

/** The chain's finality declaration in the registry must match real-chain behavior. */
function registry() {
  return ChainRegistry.load({
    env: {
      DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: BASE ?? 'https://x.invalid',
      DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_URL: ARB ?? 'https://x.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://x.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://x.invalid',
      DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: 'https://x.invalid',
    },
  });
}

describe.skipIf(!ENABLED)('M4 L2 two-leg finality snapshot (read-only)', () => {
  for (const leg of LEGS) {
    it(`${leg.chain}: finality declared as checkpoint/finalizedTag, finalized is available on the real chain`, async () => {
      // 1) Registry declaration.
      const entry = registry().listEntries().find((e) => e.id === leg.chain);
      expect(entry, `${leg.chain} not registered`).toBeDefined();
      expect(entry!.finality).toEqual({ kind: 'checkpoint', finalizedTag: true });
      expect(entry!.finalityStatus).toBe('verified');

      // 2) Real chain: chainId matches the registry.
      const chainIdHex = (await rpc(leg.url, 'eth_chainId', [])) as string;
      expect(Number.parseInt(chainIdHex, 16)).toBe(leg.expectedChainId);

      // 3) Real chain: finalized/safe/latest are all available and strictly ordered (checkpoint semantics).
      const [latest, safe, finalized] = await Promise.all([
        rpc(leg.url, 'eth_getBlockByNumber', ['latest', false]) as Promise<{ number: string }>,
        rpc(leg.url, 'eth_getBlockByNumber', ['safe', false]) as Promise<{ number: string }>,
        rpc(leg.url, 'eth_getBlockByNumber', ['finalized', false]) as Promise<{ number: string }>,
      ]);
      const n = (b: { number: string }): bigint => BigInt(b.number);
      expect(n(finalized)).toBeLessThanOrEqual(n(safe));
      expect(n(safe)).toBeLessThanOrEqual(n(latest));

      // 4) finalized does not regress on re-check (monotonic).
      const again = (await rpc(leg.url, 'eth_getBlockByNumber', ['finalized', false])) as { number: string };
      expect(n(again)).toBeGreaterThanOrEqual(n(finalized));
    }, 30_000);
  }
});
