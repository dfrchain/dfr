/**
 * Solana Adapter build 测试（DFR-M3-B01）。
 *
 * 权威来源：ADR-032（blockhash 是排序前提）、adapter-spec §8.2、m3-taskbook B01。
 * 全部离线：用 mock Provider，把链上读数固定下来；decode 回环证明载荷自洽。
 */
import { describe, expect, it } from 'vitest';
import { SolanaAdapter, decodeTransactionPayload } from '@dfr/adapter-solana';
import type { AdapterContext, Chain, ChainId, TransactionRequest } from '@dfr/types';
import { makeContext } from './adapter-contract.js';

const DEVNET = 'solana-devnet' as ChainId;
/** 合法 32 字节公钥：全 1 = 32 个零字节（此处用作可读的占位地址）。 */
const FROM = '11111111111111111111111111111111';
/** 另一个合法地址（32 字节）。 */
const TO = 'So11111111111111111111111111111111111111112';
const BLOCKHASH = 'BM2MpjjG9Wk6fzPVd62cCvYJFmPzZFxPVXX6g8NsqyDZ'; // secret-scan:allow public-blockhash-from-devnet-fixture
const LAST_VALID = 495_317_734;

const chain: Chain = {
  id: DEVNET,
  displayName: 'Solana Devnet',
  family: 'solana',
  network: 'devnet',
  adapter: { id: 'solana', version: '^0.1.0' },
  finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.build'],
};

const handlers = {
  getLatestBlockhash: () => ({ context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID } }),
};

const nativeValue = (amount: string) => ({ asset: { kind: 'native' as const, chain: DEVNET }, amount: amount as never });

/** 只覆盖**存在**的字段：exactOptionalPropertyTypes 下不能用 `{ to: undefined }` 删除。 */
function request(overrides: Partial<TransactionRequest> = {}): TransactionRequest {
  const base: TransactionRequest = {
    chain: DEVNET,
    from: { chain: DEVNET, address: FROM },
    to: { chain: DEVNET, address: TO },
    value: nativeValue('1'),
  };
  return { ...base, ...overrides };
}

function withoutField(field: 'to' | 'value'): TransactionRequest {
  const base = request();
  const copy = { ...base } as Record<string, unknown>;
  delete copy[field];
  return copy as unknown as TransactionRequest;
}

describe('Solana Adapter build（M3-B01）', () => {
  const adapter = new SolanaAdapter({ chain });

  it('声明 transaction.build，且产出可解码的 base64 未签名交易', async () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.build');
    const ctx = makeContext(chain, handlers);
    const unsigned = await adapter.build(ctx, request());

    expect(unsigned.chain).toBe(DEVNET);
    expect(unsigned.meta.encoding).toBe('base64');
    expect(unsigned.meta.recentBlockhash).toBe(BLOCKHASH);
    // Solana 没有 requiresNonce（排序前提是 blockhash）。
    expect(unsigned.meta.requiresNonce).toBeUndefined();

    const decoded = decodeTransactionPayload(unsigned.payload);
    expect(decoded.version).toBe('legacy');
    expect(decoded.signed).toBe(false);
    expect(decoded.recentBlockhash).toBe(BLOCKHASH);
    // fee payer 第一；收款地址第二；system program 在表内。
    expect(decoded.accountKeys[0]).toBe(FROM);
    expect(decoded.accountKeys).toContain(TO);
    expect(decoded.accountKeys).toContain('11111111111111111111111111111111');
    expect(decoded.header.numRequiredSignatures).toBe(1);
    expect(decoded.instructions).toHaveLength(1);
  });

  it('金额按 9 位小数换算为 lamports，且指令数据是小端 u32 枚举 2 + u64 lamports', async () => {
    const ctx = makeContext(chain, handlers);
    const unsigned = await adapter.build(ctx, request({ value: nativeValue('1') }));
    const decoded = decodeTransactionPayload(unsigned.payload);
    const data = Buffer.from(decoded.instructions[0]!.data, 'base64');
    expect(data.length).toBe(12);
    expect(data.readUInt32LE(0)).toBe(2); // SystemInstruction::Transfer
    expect(data.readBigUInt64LE(4)).toBe(1_000_000_000n); // 1 SOL
  });

  it('blockhash 来自链（getLatestBlockhash），不是硬编码', async () => {
    const seen: string[] = [];
    const ctx = makeContext(chain, handlers, (method) => seen.push(method));
    await adapter.build(ctx, request());
    expect(seen).toContain('getLatestBlockhash');
  });

  it('recentBlockhash 写入 meta（供 SequencingStore 记录 lastValidBlockHeight）', async () => {
    const ctx = makeContext(chain, handlers);
    const unsigned = await adapter.build(ctx, request({ value: nativeValue('2') }));
    expect(unsigned.meta.recentBlockhash).toBe(BLOCKHASH);
    expect(unsigned.meta.feeEstimate?.asset).toEqual({ kind: 'native', chain: DEVNET });
    // 基础签名费：5000 lamports × 1 签名者。
    expect(unsigned.meta.feeEstimate?.amount).toBe('5000');
  });

  it('传入 EVM 语义的 nonce → DFR_INVALID_REQUEST（不静默忽略）', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(adapter.build(ctx, request({ nonce: '3' as never }))).rejects.toMatchObject({
      code: 'DFR_INVALID_REQUEST',
    });
  });

  it('缺少 to → DFR_UNSUPPORTED_CAPABILITY（不支持程序部署）', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(adapter.build(ctx, withoutField('to'))).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_CAPABILITY',
    });
  });

  it('非法地址 → DFR_INVALID_ACCOUNT', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.build(ctx, request({ to: { chain: DEVNET, address: '0invalid' } })),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_ACCOUNT' });
  });

  it('非原生资产 / 跨链资产 → DFR_INVALID_ASSET', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      adapter.build(ctx, request({ value: { asset: { kind: 'token', chain: DEVNET, assetId: TO }, amount: '1' as never } })),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_ASSET' });
    await expect(
      adapter.build(ctx, request({ value: { asset: { kind: 'native', chain: 'ethereum-sepolia' as ChainId }, amount: '1' as never } })),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_ASSET' });
  });

  it('缺少金额 → DFR_INVALID_ASSET', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(adapter.build(ctx, withoutField('value'))).rejects.toMatchObject({
      code: 'DFR_INVALID_ASSET',
    });
  });

  it('contract.read 尚未实现 → DFR_UNSUPPORTED_CAPABILITY（fail-closed）', async () => {
    const ctx = makeContext(chain, handlers);
    await expect(
      (adapter as unknown as { readContract(a: AdapterContext, b: unknown): Promise<unknown> }).readContract(ctx, {}),
    ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });
});
