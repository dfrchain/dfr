/**
 * M4 两腿最终性只读快照（Base Sepolia / Arbitrum Sepolia）。
 *
 * 默认跳过；显式开启（只读，不需要资金/私钥）：
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL=https://sepolia.base.org \
 *   DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_URL=https://sepolia-rollup.arbitrum.io/rpc \
 *   pnpm vitest run tests/integration/l2-finality.test.ts
 *
 * 这锁定"chains.yaml 里 checkpoint/finalizedTag 的声明在真实链上成立"，
 * 与 docs/reviews/2026-10-06-base-sepolia-finality-evidence.md 的结论对应。
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

/** registry 上该链的最终性声明必须与真实链行为一致。 */
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

describe.skipIf(!ENABLED)('M4 L2 两腿最终性快照（只读）', () => {
  for (const leg of LEGS) {
    it(`${leg.chain}：finality 声明为 checkpoint/finalizedTag，真实链上 finalized 可用`, async () => {
      // 1) 注册表声明。
      const entry = registry().listEntries().find((e) => e.id === leg.chain);
      expect(entry, `${leg.chain} 未注册`).toBeDefined();
      expect(entry!.finality).toEqual({ kind: 'checkpoint', finalizedTag: true });
      expect(entry!.finalityStatus).toBe('verified');

      // 2) 真实链：chainId 与注册表一致。
      const chainIdHex = (await rpc(leg.url, 'eth_chainId', [])) as string;
      expect(Number.parseInt(chainIdHex, 16)).toBe(leg.expectedChainId);

      // 3) 真实链：finalized/safe/latest 三方可得，且严格有序（checkpoint 语义）。
      const [latest, safe, finalized] = await Promise.all([
        rpc(leg.url, 'eth_getBlockByNumber', ['latest', false]) as Promise<{ number: string }>,
        rpc(leg.url, 'eth_getBlockByNumber', ['safe', false]) as Promise<{ number: string }>,
        rpc(leg.url, 'eth_getBlockByNumber', ['finalized', false]) as Promise<{ number: string }>,
      ]);
      const n = (b: { number: string }): bigint => BigInt(b.number);
      expect(n(finalized)).toBeLessThanOrEqual(n(safe));
      expect(n(safe)).toBeLessThanOrEqual(n(latest));

      // 4) finalized 复查不回退（单调）。
      const again = (await rpc(leg.url, 'eth_getBlockByNumber', ['finalized', false])) as { number: string };
      expect(n(again)).toBeGreaterThanOrEqual(n(finalized));
    }, 30_000);
  }
});
