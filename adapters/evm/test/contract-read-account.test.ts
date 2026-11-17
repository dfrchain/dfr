/**
 * EVM Adapter `readContract`（ADR-035）与 `getAccount`（ADR-036）单元测试。
 */
import { describe, expect, it } from 'vitest';
import { EvmAdapter } from '../src/adapter.js';
import type { AdapterContext, Chain, ChainId } from '@dfr/types';
import { createMockProviderRouter } from '../../../tests/contract/mock-provider.js';

const CHAIN = 'base-sepolia' as ChainId;
const chain: Chain = {
  id: CHAIN, displayName: 'Base Sepolia', family: 'evm', network: 'testnet',
  externalChainId: '84532', adapter: { id: 'evm', version: '^0.1.0' },
  finality: { kind: 'checkpoint', finalizedTag: true }, finalityStatus: 'verified',
  capabilities: ['account.balance', 'account.code', 'block.read', 'transaction.read', 'contract.read'],
};
const ADDRESS = '0x1111111111111111111111111111111111111111';

function ctxWith(handlers: Record<string, unknown>, onCall?: (m: string, params: readonly unknown[]) => void): AdapterContext {
  const router = createMockProviderRouter({
    chain: CHAIN,
    handlers: handlers as never,
    ...(onCall !== undefined ? { onCall: (m: string, c: { params: readonly unknown[] }) => onCall(m, c.params) } : {}),
  });
  return {
    chain: CHAIN, network: 'testnet', providers: router,
    signal: new AbortController().signal, requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  };
}

// balanceOf(address) returns (uint256)
const ABI = ['function balanceOf(address) view returns (uint256)'];

describe('EVM Adapter readContract（ADR-035）', () => {
  const adapter = new EvmAdapter({ chain });

  it('声明 contract.read；abi+method 路径编码并解码返回', async () => {
    expect(adapter.capabilities().capabilities).toContain('contract.read');
    const calls: Array<{ m: string; params: readonly unknown[] }> = [];
    // balanceOf → uint256 = 42
    // uint256 = 42 → 32 字节（64 hex），即 62 个 0 + 2a
    const ctx = ctxWith(
      { eth_call: () => `0x${'0'.repeat(62)}2a` },
      (m, params) => calls.push({ m, params }),
    );
    const result = await adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS, abi: ABI, method: 'balanceOf', args: [ADDRESS] });
    // bigint 被归一化为十进制字符串（HTTP/JSON 安全，符合禁 number 契约）。
    expect(result.decoded).toBe('42');
    expect(result.data).toBe(`0x${'0'.repeat(62)}2a`);
    const call = calls.find((c) => c.m === 'eth_call')!;
    const param = (call.params[0]) as { to: string; data: string };
    expect(param.to).toBe(ADDRESS);
    // balanceOf 选择器 0x70a08231
    expect(param.data.startsWith('0x70a08231')).toBe(true);
  });

  it('data 路径：直接调用并返回原始 hex（不解码）', async () => {
    const calls: string[] = [];
    const ctx = ctxWith({ eth_call: () => '0xabc' }, (m) => calls.push(m));
    const result = await adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS, data: '0xdeadbeef' });
    expect(result.data).toBe('0xabc');
    expect(result.decoded).toBeUndefined();
    expect(calls).toContain('eth_call');
  });

  it('data 与 abi 同时给出 → DFR_VALIDATION_FAILED（不猜）', async () => {
    const ctx = ctxWith({ eth_call: () => '0x' });
    await expect(
      adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS, data: '0xdeadbeef', abi: ABI, method: 'balanceOf' }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('两者都不给 → DFR_VALIDATION_FAILED', async () => {
    const ctx = ctxWith({ eth_call: () => '0x' });
    await expect(adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS })).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('ABI 里没有该方法 → DFR_VALIDATION_FAILED（不发出 eth_call）', async () => {
    const calls: string[] = [];
    const ctx = ctxWith({ eth_call: () => '0x' }, (m) => calls.push(m));
    await expect(
      adapter.readContract(ctx, { chain: CHAIN, contract: ADDRESS, abi: ABI, method: 'missing' }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    expect(calls).not.toContain('eth_call');
  });
});

describe('EVM Adapter getAccount（ADR-036）', () => {
  const adapter = new EvmAdapter({ chain });

  it('code 非空 → kind=contract，exists=true，返回 nonce', async () => {
    expect(adapter.capabilities().capabilities).toContain('account.code');
    const ctx = ctxWith({ eth_getCode: () => '0x60806040', eth_getTransactionCount: () => '0x0', eth_getBalance: () => '0x0' });
    const account = await adapter.getAccount(ctx, { chain: CHAIN, address: ADDRESS });
    expect(account.kind).toBe('contract');
    expect(account.exists).toBe(true);
    expect(account.nonce).toBe('0');
  });

  it('code 为空、nonce=0、余额=0 → kind=externally-owned，exists=false（启发式）', async () => {
    const ctx = ctxWith({ eth_getCode: () => '0x', eth_getTransactionCount: () => '0x0', eth_getBalance: () => '0x0' });
    const account = await adapter.getAccount(ctx, { chain: CHAIN, address: ADDRESS });
    expect(account.kind).toBe('externally-owned');
    expect(account.exists).toBe(false);
  });

  it('code 为空但有余额 → EOA 且 exists=true', async () => {
    const ctx = ctxWith({ eth_getCode: () => '0x', eth_getTransactionCount: () => '0x0', eth_getBalance: () => '0x2a' });
    const account = await adapter.getAccount(ctx, { chain: CHAIN, address: ADDRESS });
    expect(account.kind).toBe('externally-owned');
    expect(account.exists).toBe(true);
  });
});
