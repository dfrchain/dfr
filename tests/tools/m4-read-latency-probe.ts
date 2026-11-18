/**
 * M4 read-only latency probe (the DFR side's half of the "latency/error/cost comparison" completion gate).
 *
 * The M4 completion gate requires a latency/error/cost comparison after the BEX migration. All the DFR side can prove on its own is
 * "how long these read-only actions take via DFR's public surface"; the numbers for the BEX side's old implementation (`cast`) must come from BEX,
 * and this probe **does not fabricate** a comparison conclusion, it only produces numbers that can be compared directly.
 *
 * Read-only, no funds, no signing. By default it hits the Base Sepolia WETH contract; the chain and address can be overridden.
 *
 * Why it lives in tests/tools: it needs the workspace's @dfr/* resolution (scripts/ is not inside the workspace).
 *
 * Usage:
 *   DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL=https://sepolia.base.org \
 *   node --experimental-strip-types --experimental-transform-types \
 *     --import ./scripts/ts-runtime/register.mjs tests/tools/m4-read-latency-probe.ts
 *
 * Optional environment variables:
 *   DFR_PROBE_CHAIN (default base-sepolia), DFR_PROBE_ADDRESS (default WETH),
 *   DFR_PROBE_ITERATIONS (default 20, minus 2 warmups per category)
 */
import { performance } from 'node:perf_hooks';
import { EvmAdapter } from '@dfr/adapter-evm';
import { DfrCore } from '@dfr/core';
import { newRequestId } from '@dfr/errors';
import { ChainRegistry } from '@dfr/registry';
import type { Chain, ChainId } from '@dfr/types';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';

const CHAIN = (process.env['DFR_PROBE_CHAIN'] ?? 'base-sepolia') as ChainId;
const ADDRESS = process.env['DFR_PROBE_ADDRESS'] ?? '0x4200000000000000000000000000000000000006';
const ITERATIONS = Number.parseInt(process.env['DFR_PROBE_ITERATIONS'] ?? '20', 10);
const WARMUP = 2;

const env = {
  DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: process.env['DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL'] ?? 'https://x.invalid',
  DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_KEY: process.env['DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_KEY'] ?? '',
  DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_URL: process.env['DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_URL'] ?? 'https://x.invalid',
  DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_KEY: process.env['DFR_PROVIDER_ARBITRUM_SEPOLIA_PRIMARY_KEY'] ?? '',
  DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: process.env['DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL'] ?? 'https://x.invalid',
  DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_KEY: process.env['DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_KEY'] ?? '',
  DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: process.env['DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL'] ?? 'https://y.invalid',
  DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_KEY: process.env['DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_KEY'] ?? '',
  DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: process.env['DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL'] ?? 'https://s.invalid',
  DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_KEY: process.env['DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_KEY'] ?? '',
};

const registry = ChainRegistry.load({ env });
const core = new DfrCore({
  registry,
  adapters: [{ id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain }) }],
  // A read-only probe needs no real persistence; an in-memory Store satisfies DfrCore's M1+ preconditions.
  milestone: 'M1',
  transactionStores: createInMemoryTransactionStores(),
});

const requestId = () => newRequestId();

interface Sample { readonly name: string; readonly run: () => Promise<unknown> }

const samples: readonly Sample[] = [
  {
    name: 'account.code (GET /v1/accounts/{address})',
    run: () => core.getAccount(CHAIN, { chain: CHAIN, address: ADDRESS }, { requestId: requestId() }),
  },
  {
    name: 'contract.read abi+method (POST /v1/contracts/read)',
    run: () =>
      core.readContract(
        CHAIN,
        {
          chain: CHAIN,
          contract: ADDRESS,
          abi: ['function totalSupply() view returns (uint256)'],
          method: 'totalSupply',
        },
        { requestId: requestId() },
      ),
  },
  {
    name: 'block.read (GET /v1/blocks/tag:finalized)',
    run: () => core.getBlock(CHAIN, { kind: 'tag', tag: 'finalized' }, { requestId: requestId() }),
  },
];

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

async function measure(sample: Sample): Promise<void> {
  for (let i = 0; i < WARMUP; i += 1) {
    await sample.run();
  }
  const latencies: number[] = [];
  let errors = 0;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = performance.now();
    try {
      await sample.run();
      latencies.push(performance.now() - started);
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ! ${sample.name} attempt ${i} failed: ${message}\n`);
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const fmt = (n: number) => (Number.isNaN(n) ? '  n/a' : n.toFixed(1).padStart(7));
  process.stdout.write(
    `${sample.name}\n` +
      `  n=${latencies.length}/${ITERATIONS} errors=${errors}  ` +
      `min=${fmt(sorted[0] as number)}  p50=${fmt(percentile(sorted, 50))}  ` +
      `p95=${fmt(percentile(sorted, 95))}  max=${fmt(sorted[sorted.length - 1] as number)} ms\n`,
  );
}

async function main(): Promise<void> {
  process.stdout.write(
    `M4 read-only latency probe\n  chain=${CHAIN}  address=${ADDRESS}  iterations=${ITERATIONS}(each +${WARMUP} warmups)\n\n`,
  );
  for (const sample of samples) {
    await measure(sample);
  }
  process.stdout.write(
    '\nNote: these are single observations from "dev machine → public RPC", not a production SLA.\n' +
      'When comparing against the old BEX implementation (cast subprocess), both sides must be measured on the same network in the same time window.\n',
  );
}

await main();
