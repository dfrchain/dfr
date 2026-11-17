/**
 * Solana devnet 真实只读联调（M2-A03）。
 *
 * 默认跳过：CI 与本地默认运行不依赖公网 RPC。
 * 显式开启：
 *   DFR_RUN_SOLANA=1 pnpm vitest run tests/integration/solana-devnet.test.ts
 *
 * 全程只读：getVersion / getSlot / getLatestBlockhash / getAccountInfo / getBlock。
 */
import { describe, expect, it } from 'vitest';
import { DfrCore } from '@dfr/core';
import { SolanaAdapter } from '@dfr/adapter-solana';
import { EvmAdapter } from '@dfr/adapter-evm';
import { ChainRegistry } from '@dfr/registry';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';

const ENABLED = process.env['DFR_RUN_SOLANA'] === '1';
const DEVNET = 'solana-devnet' as never;
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

function makeCore(): DfrCore {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: 'https://api.devnet.solana.com',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://1rpc.io/sepolia',
    },
  });
  return new DfrCore({
    registry,
    // M2 里程碑会加载全部 <=M2 的链（含 EVM 链），因此两个 Adapter 都要注册。
    adapters: [
      { id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) },
      { id: 'solana', version: '0.1.0', create: (chain) => new SolanaAdapter({ chain }) },
    ],
    milestone: 'M2',
    // M1+ 要求完整的交易 Store；本测试只驱动只读路径，用替身即可
    // （生产路径必须用 @dfr/storage-postgres，见 ADR-014）。
    transactionStores: createInMemoryTransactionStores(),
  });
}

const ctx = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  signal: new AbortController().signal,
};

describe.skipIf(!ENABLED)('Solana devnet 真实只读联调（M2-A03）', () => {
  it('Core 在 M2 里程碑下加载 solana-devnet', () => {
    expect(makeCore().listChains().map((c) => c.id)).toContain('solana-devnet');
  });

  it('getChainInfo 返回真实 slot 与 solana-core 版本', async () => {
    const info = await makeCore().getChainInfo(DEVNET, ctx);
    expect(info.family).toBe('solana');
    expect(BigInt(info.slot ?? '0')).toBeGreaterThan(100_000_000n);
    expect(info.height, '不得伪装 EVM 高度').toBeUndefined();
    expect(typeof info.nodeVersion).toBe('string');
  }, 30_000);

  it('getBalance 返回 Wrapped SOL 账户的 lamports（十进制字符串）', async () => {
    const balance = await makeCore().getBalance(
      { chain: DEVNET, account: { chain: DEVNET, address: WRAPPED_SOL } },
      ctx,
    );
    expect(balance.decimals).toBe(9);
    expect(balance.asset).toEqual({ kind: 'native', chain: DEVNET });
    expect(/^\d+$/u.test(String(balance.amount))).toBe(true);
  }, 30_000);

  it('getBlock 用真实 slot 读取区块（slot / blockhash 一致）', async () => {
    const core = makeCore();
    const info = await core.getChainInfo(DEVNET, ctx);
    const slot = (BigInt(info.slot!) - 32n).toString(10);
    const block = await core.getBlock(DEVNET, { kind: 'slot', slot: slot as never }, ctx);
    expect(block).not.toBeNull();
    expect(block!.slot).toBe(slot);
    expect(typeof block!.hash).toBe('string');
    expect(block!.number, 'Solana 区块不得带 EVM number').toBeUndefined();
  }, 30_000);

  it('getTransaction 用真实签名查询（M2-B04）', async () => {
    const core = makeCore();
    // 取 Wrapped SOL 账户的最近一笔真实签名，再按签名查询。
    const sig = await fetch('https://api.devnet.solana.com', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [WRAPPED_SOL, { limit: 1 }],
      }),
    })
      .then((r) => r.json() as Promise<{ result?: { signature: string }[] }>)
      .then((d) => d.result?.[0]?.signature);
    expect(typeof sig).toBe('string');

    const tx = await core.getTransaction(DEVNET, { kind: 'hash', hash: sig! }, ctx);
    expect(tx).not.toBeNull();
    expect(tx!.chain).toBe('solana-devnet');
    expect(['included', 'failed']).toContain(tx!.status);
    if (tx!.blockRef !== undefined) expect(tx!.blockRef.kind).toBe('slot');
    expect(tx!.nonce, 'Solana 交易不得带 EVM nonce').toBeUndefined();
    expect(tx!.fee).toBeDefined();
  }, 30_000);

  it('number 定位被显式拒绝（fail-closed，不是静默降级）', async () => {
    await expect(
      makeCore().getBlock(DEVNET, { kind: 'number', number: '1' as never }, ctx),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  }, 30_000);
});
