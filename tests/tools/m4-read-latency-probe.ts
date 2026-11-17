/**
 * M4 只读延迟探针（DFR 侧完成门"延迟/错误/成本对照"的一半）。
 *
 * M4 完成门要求 BEX 迁移后产出延迟/错误/成本对照。DFR 侧能自证的只有
 * "经 DFR 公开面做这些只读动作要多久"；BEX 侧旧实现（`cast`）的数字必须由 BEX 提供，
 * 这里**不伪造**对照结论，只产出可直接对照的数字。
 *
 * 只读、无资金、无签名。默认打 Base Sepolia 的 WETH 合约，可覆盖链与地址。
 *
 * 为什么放在 tests/tools：它需要 workspace 的 @dfr/* 解析（scripts/ 不在 workspace 内）。
 *
 * 用法：
 *   DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL=https://sepolia.base.org \
 *   node --experimental-strip-types --experimental-transform-types \
 *     --import ./scripts/ts-runtime/register.mjs tests/tools/m4-read-latency-probe.ts
 *
 * 可选环境变量：
 *   DFR_PROBE_CHAIN（默认 base-sepolia）、DFR_PROBE_ADDRESS（默认 WETH）、
 *   DFR_PROBE_ITERATIONS（默认 20，去掉每类预热 2 次）
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
  // 只读探针不需要真实持久化；用内存 Store 满足 DfrCore 的 M1+ 前置检查。
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
      process.stderr.write(`  ! ${sample.name} 第 ${i} 次失败：${message}\n`);
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const fmt = (n: number) => (Number.isNaN(n) ? '  n/a' : n.toFixed(1).padStart(7));
  process.stdout.write(
    `${sample.name}\n` +
      `  n=${latencies.length}/${ITERATIONS} 错误=${errors}  ` +
      `min=${fmt(sorted[0] as number)}  p50=${fmt(percentile(sorted, 50))}  ` +
      `p95=${fmt(percentile(sorted, 95))}  max=${fmt(sorted[sorted.length - 1] as number)} ms\n`,
  );
}

async function main(): Promise<void> {
  process.stdout.write(
    `M4 只读延迟探针\n  chain=${CHAIN}  address=${ADDRESS}  iterations=${ITERATIONS}（各 +${WARMUP} 预热）\n\n`,
  );
  for (const sample of samples) {
    await measure(sample);
  }
  process.stdout.write(
    '\n注：这些是"开发机 → 公共 RPC"的单次观测，不是生产 SLA。\n' +
      '对照 BEX 旧实现（cast 子进程）时，两边必须在同一网络/同一时间段测量。\n',
  );
}

await main();
