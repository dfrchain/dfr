/**
 * Solana Adapter simulate 测试（DFR-M3-B02）。
 *
 * 权威来源：m3-taskbook B02、adapter-spec §8.2、EVM 版 simulate 的语义（对齐）。
 * 全部离线：mock Provider 固定 simulateTransaction 的返回。
 */
import { describe, expect, it } from 'vitest';
import { SolanaAdapter } from '@dfr/adapter-solana';
import type { Chain, ChainId, TransactionRequest, UnsignedTransaction } from '@dfr/types';
import { makeContext } from './adapter-contract.js';

const DEVNET = 'solana-devnet' as ChainId;
const FEE_PAYER = '11111111111111111111111111111111';
const TO = 'So11111111111111111111111111111111111111112';
const BLOCKHASH = 'BM2MpjjG9Wk6fzPVd62cCvYJFmPzZFxPVXX6g8NsqyDZ'; // secret-scan:allow public-blockhash-from-devnet-fixture

const chain: Chain = {
  id: DEVNET,
  displayName: 'Solana Devnet',
  family: 'solana',
  network: 'devnet',
  adapter: { id: 'solana', version: '^0.1.0' },
  finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.build', 'transaction.simulate'],
};

const baseHandlers = {
  getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }),
};

const okResult = () => ({ value: { err: null, logs: ['Program 11111111111111111111111111111111 invoke [1]'], unitsConsumed: 150, fee: 5000 } });
const revertResult = () => ({ value: { err: { InstructionError: [0, 'Custom'] }, logs: [], unitsConsumed: 0, fee: 5000 } });

const request = (): TransactionRequest => ({
  chain: DEVNET,
  from: { chain: DEVNET, address: FEE_PAYER },
  to: { chain: DEVNET, address: TO },
  value: { asset: { kind: 'native', chain: DEVNET }, amount: '0' },
} as never);

describe('Solana Adapter simulate（M3-B02）', () => {
  const adapter = new SolanaAdapter({ chain });

  it('声明 transaction.simulate，且成功路径返回 unitsConsumed / fee', async () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.simulate');
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult });
    const result = await adapter.simulate(ctx, request());
    expect(result.success).toBe(true);
    expect(result.estimatedCost).toBe('150');
    expect(result.estimatedFee).toEqual({ asset: { kind: 'native', chain: DEVNET }, amount: '5000' });
  });

  it('请求路径先 build 再模拟（一次 getLatestBlockhash）', async () => {
    const seen: string[] = [];
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult }, (m) => seen.push(m));
    await adapter.simulate(ctx, request());
    expect(seen).toContain('getLatestBlockhash');
    expect(seen).toContain('simulateTransaction');
  });

  it('执行回滚不抛 5xx，而是 success:false + revertReason', async () => {
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: revertResult });
    const result = await adapter.simulate(ctx, request());
    expect(result.success).toBe(false);
    expect(result.revertReason).toContain('InstructionError');
    // 回滚路径不报 estimatedCost（没有可通过的交易）。
    expect(result.estimatedCost).toBeUndefined();
  });

  it('载荷路径：直接模拟给定 base64 载荷（不再取 blockhash）', async () => {
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult });
    const built = await adapter.build(ctx, request());
    const seen: string[] = [];
    const ctx2 = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult }, (m) => seen.push(m));
    const result = await adapter.simulate(ctx2, built);
    expect(result.success).toBe(true);
    expect(seen).toEqual(['simulateTransaction']); // 未再 build
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it('载荷路径拒绝非 base64 编码（fail-closed）', async () => {
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: okResult });
    const unsigned = {
      schemaVersion: '1',
      chain: DEVNET,
      payload: 'deadbeef',
      meta: { encoding: 'hex' },
    } as UnsignedTransaction;
    await expect(adapter.simulate(ctx, unsigned)).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_VERSION',
    });
  });

  it('BlockhashNotFound → success:false 并提示需重新 build（C03 交接）', async () => {
    const ctx = makeContext(chain, {
      ...baseHandlers,
      simulateTransaction: () => ({ value: { err: 'BlockhashNotFound', logs: [], unitsConsumed: 0, fee: null } }),
    });
    const result = await adapter.simulate(ctx, request());
    expect(result.success).toBe(false);
    expect(result.revertReason).toBe('BlockhashNotFound');
    expect(result.warnings?.some((w) => w.includes('重新 build'))).toBe(true);
  });

  it('simulateTransaction 缺值 → DFR_PROVIDER_UNAVAILABLE（不假装成功）', async () => {
    const ctx = makeContext(chain, { ...baseHandlers, simulateTransaction: () => ({}) });
    await expect(adapter.simulate(ctx, request())).rejects.toMatchObject({
      code: 'DFR_PROVIDER_UNAVAILABLE',
    });
  });

  it('contract.read 尚未实现 → DFR_UNSUPPORTED_CAPABILITY', async () => {
    const ctx = makeContext(chain, baseHandlers);
    await expect(
      (adapter as unknown as { readContract(a: unknown, b: unknown): Promise<unknown> }).readContract(ctx, {}),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });
});
