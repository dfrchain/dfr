/**
 * `contract.logs` 真实链只读联调（ADR-034，M4）。
 *
 * 默认跳过；显式开启：
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL=https://sepolia.base.org \
 *   pnpm vitest run tests/integration/logs-reconcile.test.ts
 *
 * 只读：拒绝在链上无法满足的请求（超区间），并验证真实窗口能取回日志。
 */
import { describe, expect, it } from 'vitest';
import { ChainRegistry } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import { EvmAdapter } from '@dfr/adapter-evm';
import { newRequestId } from '@dfr/errors';
import type { Chain, ChainId, DecimalUint } from '@dfr/types';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';

const RUN = process.env['DFR_RUN_TESTNET'] === '1';
const BASE = process.env['DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL'];
const ENABLED = RUN && BASE !== undefined && BASE !== '';
const CHAIN = 'base-sepolia' as ChainId;

function makeCore(): DfrCore {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL: BASE ?? 'https://x.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://x.invalid',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://y.invalid',
      DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: 'https://s.invalid',
    },
  });
  return new DfrCore({
    registry,
    adapters: [
      { id: 'evm', version: '0.1.0', create: (chain: Chain) => new EvmAdapter({ chain, maxBlockRange: '2000' as DecimalUint }) },
    ],
    milestone: 'M1',
    transactionStores: createInMemoryTransactionStores(),
  });
}

interface BlockRpc { number: string }
async function rpc(method: string, params: readonly unknown[]): Promise<unknown> {
  const res = await fetch(BASE!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error !== undefined) throw new Error(JSON.stringify(json.error));
  return json.result;
}

describe.skipIf(!ENABLED)('contract.logs 真实链只读联调（ADR-034）', () => {
  it('窄窗口查询返回可映射的 ChainLog（含 blockRef/logIndex）', async () => {
    const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as BlockRpc;
    const latest = BigInt(head.number);
    const from = (latest - 1n).toString(10) as DecimalUint;
    const to = latest.toString(10) as DecimalUint;

    const logs = await makeCore().getLogs(
      CHAIN,
      { chain: CHAIN, fromBlock: { kind: 'number', number: from }, toBlock: { kind: 'number', number: to } },
      { requestId: newRequestId() },
    );
    // Base Sepolia 每块都有大量日志；至少能取回并映射。
    expect(Array.isArray(logs)).toBe(true);
    for (const log of logs.slice(0, 5)) {
      expect(typeof log.address).toBe('string');
      expect(log.blockRef?.kind).toBe('number');
      expect(typeof log.index).toBe('string');
    }
  }, 30_000);

  it('超 maxBlockRange 的请求被 400 拒绝（fail-closed，不静默截断）', async () => {
    const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as BlockRpc;
    const latest = BigInt(head.number);
    await expect(
      makeCore().getLogs(
        CHAIN,
        {
          chain: CHAIN,
          fromBlock: { kind: 'number', number: (latest - 5000n).toString(10) as DecimalUint },
          toBlock: { kind: 'number', number: latest.toString(10) as DecimalUint },
        },
        { requestId: newRequestId() },
      ),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  }, 30_000);
});
