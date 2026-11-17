/**
 * Solana Adapter 契约测试（M2-A03）。
 *
 * **直接调用 `defineAdapterContract`**（ADR-025 / AGENTS.md §6）：
 * 通用断言不得为适配新链而修改；链特定的差异通过链对象与能力声明表达。
 *
 * 范围：M2 只读（getInfo / getBalance / getBlock）。写路径属 M3。
 */
import { describe, expect, it } from 'vitest';
import { SolanaAdapter } from '@dfr/adapter-solana';
import type { AdapterContext, BlockRef, Chain, ChainId } from '@dfr/types';
import { defineAdapterContract, makeContext } from './adapter-contract.js';
import { createMockProviderRouter } from './mock-provider.js';

const DEVNET = 'solana-devnet' as ChainId;
/** 一个合法的 32 字节公钥（base58）：全 1 = 32 个零字节的 base58 表示。 */
const ADDRESS = '11111111111111111111111111111111';
/** 64 个 '1' = 64 个零字节，是合法形状的 Solana 签名。 */
const SIGNATURE = '1'.repeat(64);
/** 另一个不同长度的合法 base58 串（64 字节），用于断言签名数组 >1 的情况。 */
const SIGNATURE_2 = '2'.repeat(64);
const SLOT = 508_000_000;

/** M2-A03 时 registry 实际声明的能力（见 chains.yaml 的 solana-devnet 段）。 */
const chain: Chain = {
  id: DEVNET,
  displayName: 'Solana Devnet',
  family: 'solana',
  network: 'devnet',
  adapter: { id: 'solana', version: '^0.1.0' },
  finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.build', 'transaction.simulate', 'transaction.broadcast'],
};

const handlers = {
  getVersion: () => ({ 'solana-core': '4.4.0-beta.0', 'feature-set': 1855282951 }),
  getSlot: () => SLOT,
  getLatestBlockhash: () => ({ context: { slot: SLOT }, value: { blockhash: 'BLOCKHASH111', lastValidBlockHeight: SLOT + 150 } }),
  getAccountInfo: () => ({ context: { slot: SLOT }, value: { lamports: 1_000_000_000, owner: '11111111111111111111111111111111', executable: false } }),
  getBlock: () => ({
    blockhash: 'BLOCKHASH111',
    previousBlockhash: 'BLOCKHASH000',
    blockHeight: 1234,
    blockTime: 1_700_000_000,
    parentSlot: SLOT - 1,
    signatures: ['SIG1', 'SIG2'],
  }),
  getTransaction: () => ({
    slot: SLOT,
    blockTime: 1_700_000_000,
    transactionIndex: 3,
    version: 'legacy',
    transaction: {
      signatures: [SIGNATURE, SIGNATURE_2],
      message: { accountKeys: [ADDRESS, '11111111111111111111111111111111'], recentBlockhash: 'BLOCKHASH111' },
    },
    meta: { err: null, fee: 10_000, computeUnitsConsumed: 13_336, logMessages: [] },
  }),
};

defineAdapterContract({
  name: 'Solana Adapter',
  chain,
  createAdapter: (c) => new SolanaAdapter({ chain: c }),
  handlers,
  registryCapabilities: chain.capabilities,
  // 非法地址：含 base58 字母表之外的字符 '0'
  invalidAccount: '0invalidSolanaAddress000000000000000000',
  // ADR-027：Solana 用 slot 定位；number / tag / hash 一律 fail-closed。
  unsupportedBlockRefs: [
    { kind: 'number', number: '1' as never },
    { kind: 'tag', tag: 'latest' },
    { kind: 'hash', hash: 'BLOCKHASH111' },
  ],
  // 未声明能力：contract.read（只读合约/程序调用）尚未实现 → fail-closed。
  unsupportedCall: async (adapter, ctx) =>
    (adapter as unknown as { readContract(a: AdapterContext, b: unknown): Promise<unknown> }).readContract(ctx, {}),
});

describe('Solana Adapter 只读路径（M2-A03）', () => {
  const adapter = new SolanaAdapter({ chain });

  it('getInfo 返回 slot 与节点版本，且不返回 EVM 高度', async () => {
    const ctx = makeContext(chain, handlers);
    const info = await adapter.getInfo(ctx);
    expect(info.family).toBe('solana');
    expect(info.chain).toBe(DEVNET);
    expect(info.slot).toBe(String(SLOT));
    expect(info.height, 'Solana 不得返回 EVM 高度').toBeUndefined();
    expect(info.nodeVersion).toBe('4.4.0-beta.0');
    expect(info.latestBlockHash).toBe('BLOCKHASH111');
  });

  it('getInfo 复用同一 Provider 句柄', async () => {
    const router = createMockProviderRouter({ chain: chain.id, handlers });
    const ctx: AdapterContext = {
      chain: chain.id,
      network: chain.network,
      providers: router,
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await adapter.getInfo(ctx);
    expect((router as unknown as { acquired: number }).acquired).toBe(1);
  });

  it('getBalance 返回 lamports 十进制字符串与 9 位小数', async () => {
    const ctx = makeContext(chain, handlers);
    const balance = await adapter.getBalance(ctx, { account: { chain: DEVNET, address: ADDRESS } });
    expect(balance.amount).toBe('1000000000');
    expect(balance.decimals).toBe(9);
    expect(balance.asset).toEqual({ kind: 'native', chain: DEVNET });
  });

  it('账户不存在时 lamports 视为 0（Solana 语义），不报 not found', async () => {
    const ctx = makeContext(chain, { ...handlers, getAccountInfo: () => ({ context: { slot: SLOT }, value: null }) });
    const balance = await adapter.getBalance(ctx, { account: { chain: DEVNET, address: ADDRESS } });
    expect(balance.amount).toBe('0');
  });

  it('SPL token 余额显式不受支持，不伪装成功', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.getBalance(ctx, {
        account: { chain: DEVNET, address: ADDRESS },
        asset: { kind: 'token', chain: DEVNET, assetId: ADDRESS },
      }),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });

  it('getBlock 用 slot 定位，返回 slot/blockhash，不返回 number', async () => {
    const ctx = makeContext(chain, handlers);
    const block = await adapter.getBlock(ctx, { kind: 'slot', slot: String(SLOT) as never });
    expect(block?.slot).toBe(String(SLOT));
    expect(block?.hash).toBe('BLOCKHASH111');
    expect(block?.number, 'Solana 区块不应带 EVM number').toBeUndefined();
    expect(block?.parentHash).toBe('BLOCKHASH000');
    expect(block?.transactionCount).toBe(2);
  });

  it('number / tag / hash 定位在 M2 显式失败（fail-closed，不是静默降级）', async () => {
    const ctx = makeContext(chain, handlers);
    const refs: BlockRef[] = [
      { kind: 'number', number: '1' as never },
      { kind: 'tag', tag: 'latest' },
      { kind: 'hash', hash: 'BLOCKHASH111' },
    ];
    for (const ref of refs) {
      await expect(adapter.getBlock(ctx, ref), `${ref.kind} 应被拒绝`).rejects.toMatchObject({
        code: 'DFR_UNSUPPORTED_CAPABILITY',
      });
    }
  });

  it('不存在的 slot 返回 null（与"链不可用"区分）', async () => {
    const ctx = makeContext(chain, { ...handlers, getBlock: () => null });
    expect(await adapter.getBlock(ctx, { kind: 'slot', slot: '1' as never })).toBeNull();
  });
});

describe('Solana Adapter 交易查询（M2-B04）', () => {
  const adapter = new SolanaAdapter({ chain });

  it('getTransaction 返回 slot 定位、lamports 费用与 included 状态', async () => {
    const ctx = makeContext(chain, handlers);
    const tx = await adapter.getTransaction(ctx, { kind: 'hash', hash: SIGNATURE });
    expect(tx).not.toBeNull();
    expect(tx!.chain).toBe(DEVNET);
    expect(tx!.status).toBe('included');
    expect(tx!.blockRef).toEqual({ kind: 'slot', slot: String(SLOT) });
    expect(tx!.fee?.amount).toBe('10000');
    expect(tx!.from?.address).toBe(ADDRESS);
    // 不套用 EVM 字段：Solana 没有 nonce，也没有单一 to/value。
    expect(tx!.nonce, 'Solana 交易不得带 EVM nonce').toBeUndefined();
    expect(tx!.value, 'Solana 交易不得伪造单一 value').toBeUndefined();
  });

  it('meta.err 非 null → status=failed 且带错误（不谎报成功）', async () => {
    const ctx = makeContext(chain, {
      ...handlers,
      getTransaction: () => ({
        slot: SLOT,
        transaction: { signatures: [SIGNATURE], message: { accountKeys: [ADDRESS] } },
        meta: { err: { InstructionError: [0, 'Custom'] }, fee: 5_000 },
      }),
    });
    const tx = await adapter.getTransaction(ctx, { kind: 'hash', hash: SIGNATURE });
    expect(tx!.status).toBe('failed');
    expect(tx!.error?.code).toBe('DFR_TRANSACTION_REVERTED');
  });

  it('不存在的签名返回 null', async () => {
    const ctx = makeContext(chain, { ...handlers, getTransaction: () => null });
    expect(await adapter.getTransaction(ctx, { kind: 'hash', hash: SIGNATURE })).toBeNull();
  });

  it('非法签名 → DFR_INVALID_REQUEST（形状校验在 Adapter）', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.getTransaction(ctx, { kind: 'hash', hash: 'not-a-signature' }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_REQUEST' });
  });

  it('getReceipt 返回 computeUnitsConsumed 作为 gasUsed 与 lamports 费用', async () => {
    const ctx = makeContext(chain, handlers);
    const receipt = await adapter.getReceipt(ctx, { kind: 'hash', hash: SIGNATURE });
    expect(receipt).not.toBeNull();
    expect(receipt!.success).toBe(true);
    expect(receipt!.gasUsed).toBe('13336');
    expect(receipt!.effectiveFee?.amount).toBe('10000');
    expect(receipt!.blockRef).toEqual({ kind: 'slot', slot: String(SLOT) });
  });

  it('getReceipt 对非法签名返回 null（软校验，不抛错）', async () => {
    const ctx = makeContext(chain, handlers);
    expect(await adapter.getReceipt(ctx, { kind: 'hash', hash: 'bad!' })).toBeNull();
  });
});

describe('Solana 排序前提过期语义（M3-A01，ADR-032）', () => {
  const adapter = new SolanaAdapter({ chain });
  const blockhashToken = (lastValidBlockHeight: string) => ({
    kind: 'blockhash' as const,
    value: '1'.repeat(48) + '2345', // secret-scan:allow public-blockhash-placeholder
    lastValidBlockHeight: lastValidBlockHeight as never,
  });

  it('链高 <= lastValidBlockHeight → 未过期；链高 > lastValidBlockHeight → 已过期', async () => {
    const fresh = makeContext(chain, { ...handlers, getBlockHeight: () => 1000 });
    // 边界：链高 == lastValidBlockHeight → 仍可用（只有**严格超过**才算过期）。
    await expect(adapter.isSequencingExpired(fresh, blockhashToken('1000'))).resolves.toBe(false);
    await expect(adapter.isSequencingExpired(fresh, blockhashToken('1001'))).resolves.toBe(false);
    await expect(adapter.isSequencingExpired(fresh, blockhashToken('999'))).resolves.toBe(true);

    const stale = makeContext(chain, { ...handlers, getBlockHeight: () => 1001 });
    await expect(adapter.isSequencingExpired(stale, blockhashToken('1000'))).resolves.toBe(true);
  });

  it('按区块高度判断（不依赖本地时钟），且用十进制字符串比较超安全整数范围', async () => {
    const ctx = makeContext(chain, { ...handlers, getBlockHeight: () => 9_007_199_254_740_994 });
    // 若用 JS number 比较会失真；这里必须精确。
    await expect(
      adapter.isSequencingExpired(ctx, blockhashToken('9007199254740995')),
    ).resolves.toBe(false);
    await expect(
      adapter.isSequencingExpired(ctx, blockhashToken('9007199254740993')),
    ).resolves.toBe(true);
  });

  it('非 blockhash token（EVM nonce）→ DFR_INVALID_REQUEST，不猜答案', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.isSequencingExpired(ctx, { kind: 'nonce', value: '1' as never }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_REQUEST' });
  });

  it('chain 不匹配 → DFR_CHAIN_MISMATCH（fail-closed）', async () => {
    const otherChain = 'ethereum-sepolia' as ChainId;
    const router = createMockProviderRouter({ chain: otherChain, handlers });
    const ctx: AdapterContext = {
      chain: otherChain,
      network: 'testnet',
      providers: router,
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await expect(adapter.isSequencingExpired(ctx, blockhashToken('1'))).rejects.toMatchObject({
      code: 'DFR_CHAIN_MISMATCH',
    });
  });
});
