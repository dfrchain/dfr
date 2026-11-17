/**
 * DFR-014：Ethereum Sepolia 真实只读联调。
 *
 * 默认**跳过**：CI 与本地默认运行不应依赖公网 RPC（不确定、有配额、会 flake）。
 * 显式开启：
 *
 *   DFR_RUN_TESTNET=1 \
 *   DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL=https://<你的 Sepolia RPC> \
 *   pnpm vitest run tests/integration/ethereum-sepolia.test.ts
 *
 * 可选：DFR_TESTNET_TX_HASH=0x… 用于验证交易查询路径。
 *
 * 本测试只做只读调用：不签名、不广播、不接触私钥（ADR-010）。
 */
import { describe, expect, it } from 'vitest';
import { ChainRegistry, projectChain } from '@dfr/registry';
import { DfrCore } from '@dfr/core';
import { ProviderManager } from '@dfr/provider';
import { decodeTransactionPayload, EvmAdapter } from '@dfr/adapter-evm';
import { newRequestId } from '@dfr/errors';
import type { AdapterContext, ChainId } from '@dfr/types';

const RUN = process.env['DFR_RUN_TESTNET'] === '1';
const ENDPOINT = process.env['DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL'];
const ENABLED = RUN && ENDPOINT !== undefined && ENDPOINT !== '';
const CHAIN = 'ethereum-sepolia' as ChainId;

function makeCore(): DfrCore {
  const registry = ChainRegistry.load();
  return new DfrCore({
    registry,
    adapters: [{ id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) }],
    milestone: 'M0',
  });
}

describe.skipIf(!ENABLED)('Ethereum Sepolia 只读联调（DFR-014）', () => {
  const core = makeCore();
  const ctx = { requestId: newRequestId() };

  it('getInfo 返回真实高度与最新区块哈希，且 chainId 校验通过', async () => {
    const info = await core.getChainInfo(CHAIN, ctx);
    expect(info.chain).toBe(CHAIN);
    expect(info.network).toBe('testnet');
    expect(BigInt(info.height ?? '0')).toBeGreaterThan(0n);
    expect(info.latestBlockHash).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 30_000);

  it('getBalance 返回十进制最小单位余额', async () => {
    const balance = await core.getBalance(
      {
        chain: CHAIN,
        // 零地址余额可预期地存在（通常为 0），用于验证管路而不依赖某个账户的余额。
        account: { chain: CHAIN, address: '0x0000000000000000000000000000000000000000' },
      },
      ctx,
    );
    expect(balance.amount).toMatch(/^[0-9]+$/);
    expect(balance.decimals).toBe(18);
  }, 30_000);

  it('getBlock(tag:finalized) 返回已最终化区块', async () => {
    const block = await core.getBlock(CHAIN, { kind: 'tag', tag: 'finalized' }, ctx);
    expect(block).not.toBeNull();
    expect(block?.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(block?.finality).toBe('finalized');
  }, 30_000);

  it('getBlock 对不存在的未来高度返回 null', async () => {
    const block = await core.getBlock(CHAIN, { kind: 'number', number: '999999999999' as never }, ctx);
    expect(block).toBeNull();
  }, 30_000);

  const txHash = process.env['DFR_TESTNET_TX_HASH'];
  it.skipIf(txHash === undefined)('getTransaction 使用 DFR_TESTNET_TX_HASH 验证交易查询', async () => {
    const tx = await core.getTransaction(CHAIN, { kind: 'hash', hash: txHash as string }, ctx);
    expect(tx?.chain).toBe(CHAIN);
    expect(typeof tx?.status).toBe('string');
  }, 30_000);
});

describe.skipIf(ENABLED)('Ethereum Sepolia 联调（未启用）', () => {
  it('默认跳过：设置 DFR_RUN_TESTNET=1 与 RPC 端点后运行', () => {
    expect(ENABLED).toBe(false);
  });
});

/**
 * DFR-M1-B02：真实 Sepolia 上构造（build）一笔未签名交易。
 *
 * 只读 + 只构造：不签名、不广播、不接触私钥。默认跳过，与其他真实网络测试同一开关。
 * 用 Sepolia 存款合约地址作为 `from`（该地址长期持有余额），使 `eth_estimateGas`
 * 不会因"发送方无余额支付 gas"而失败；转账金额为 0，不产生任何链上影响。
 */
describe.skipIf(!ENABLED)('Ethereum Sepolia build 联调（DFR-M1-B02，只构造）', () => {
  const FUNDED_FROM = '0x00000000219ab540356cBB839Cbe05303d7705Fa';

  it('build 在真实 RPC 上产出可解码的 eip1559 未签名载荷', async () => {
    const registry = ChainRegistry.load();
    const entry = registry.listEntries().find((e) => e.id === CHAIN);
    if (entry === undefined) throw new Error(`registry 缺少链 ${CHAIN}`);
    const chain = projectChain(entry);
    const adapter = new EvmAdapter({ chain });
    const providers = new ProviderManager({
      chain: CHAIN,
      descriptors: registry.listProviders(CHAIN),
      resolveEndpoint: (d) => registry.resolveEndpoint(d),
      resolveCredential: (d) => registry.resolveCredential(d),
    });
    const ctx: AdapterContext = {
      chain: CHAIN,
      network: chain.network,
      providers,
      signal: new AbortController().signal,
      requestId: newRequestId(),
    };

    const unsigned = await adapter.build(ctx, {
      chain: CHAIN,
      from: { chain: CHAIN, address: FUNDED_FROM },
      to: { chain: CHAIN, address: FUNDED_FROM },
      value: { asset: { kind: 'native', chain: CHAIN }, amount: '0' as never },
    });

    const decoded = decodeTransactionPayload(unsigned.payload);
    expect(unsigned.meta.encoding).toBe('hex');
    expect(decoded.type).toBe('eip1559');
    expect(decoded.chainId).toBe(chain.externalChainId);
    expect(decoded.signed).toBe(false);
    expect(decoded.nonce).toBe(unsigned.meta.requiresNonce);
    expect(BigInt(decoded.gas)).toBeGreaterThan(0n);
    expect(BigInt(decoded.maxFeePerGas ?? '0')).toBeGreaterThan(0n);
    expect(BigInt(decoded.maxPriorityFeePerGas ?? '0')).toBeGreaterThanOrEqual(0n);
  }, 30_000);
});
