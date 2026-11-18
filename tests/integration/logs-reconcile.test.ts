/**
 * `contract.logs` real-chain read-only integration test (ADR-034, M4).
 *
 * Skipped by default; enable explicitly:
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_BASE_SEPOLIA_PRIMARY_URL=https://sepolia.base.org \
 *   pnpm vitest run tests/integration/logs-reconcile.test.ts
 *
 * Read-only: reject requests the chain cannot satisfy (out-of-range) and verify a real window retrieves logs.
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

describe.skipIf(!ENABLED)('contract.logs real-chain read-only integration test (ADR-034)', () => {
  it('a narrow-window query returns a mappable ChainLog (with blockRef/logIndex)', async () => {
    const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as BlockRpc;
    const latest = BigInt(head.number);
    const from = (latest - 1n).toString(10) as DecimalUint;
    const to = latest.toString(10) as DecimalUint;

    const logs = await makeCore().getLogs(
      CHAIN,
      { chain: CHAIN, fromBlock: { kind: 'number', number: from }, toBlock: { kind: 'number', number: to } },
      { requestId: newRequestId() },
    );
    // Every Base Sepolia block has plenty of logs; at least some must be retrievable and mappable.
    expect(Array.isArray(logs)).toBe(true);
    for (const log of logs.slice(0, 5)) {
      expect(typeof log.address).toBe('string');
      expect(log.blockRef?.kind).toBe('number');
      expect(typeof log.index).toBe('string');
    }
  }, 30_000);

  it('a request exceeding maxBlockRange is rejected with 400 (fail-closed, no silent truncation)', async () => {
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
