/**
 * Solana Adapter broadcast 测试（DFR-M3-C01）。
 *
 * 权威来源：m3-taskbook C01、error-spec §5.1、EVM 版 broadcast 的四条红线。
 * 全部离线：mock Provider 固定 sendTransaction 的返回。
 *
 * 变造一笔真实签名交易做"已签名载荷"：取其 message，把签名段替换为非零，
 * 这样 decode/binding 走真实路径，又不依赖任何私钥。
 */
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import { SolanaAdapter, SolanaBindingError, bindSignedTransaction } from '@dfr/adapter-solana';
import type { Chain, ChainId, SignedTransaction } from '@dfr/types';
import { makeContext } from './adapter-contract.js';
import { createMockProviderRouter } from './mock-provider.js';
import { SOLANA_DEVNET_FIXTURES, SOLANA_DEVNET_LEGACY_SIGNED } from '../../adapters/solana/test/support/devnet-fixtures.js';

const DEVNET = 'solana-devnet' as ChainId;
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

/** 现成的真实签名 legacy 交易（离线 ground truth）。 */
const signedPayload = SOLANA_DEVNET_LEGACY_SIGNED.signedPayloadBase64;
const FEE_PAYER = SOLANA_DEVNET_LEGACY_SIGNED.feePayer;
const TX_HASH = SOLANA_DEVNET_LEGACY_SIGNED.txHash;

function signed(overrides: Partial<SignedTransaction> = {}): SignedTransaction {
  return {
    schemaVersion: '1',
    chain: DEVNET,
    unsigned: { schemaVersion: '1', chain: DEVNET, payload: signedPayload, meta: { encoding: 'base64' } },
    signedPayload,
    expectedHash: TX_HASH,
    ...overrides,
  };
}

describe('Solana broadcast（M3-C01）', () => {
  const adapter = new SolanaAdapter({ chain });

  it('声明 transaction.broadcast', () => {
    expect(adapter.capabilities().capabilities).toContain('transaction.broadcast');
  });

  it('单次提交：sendTransaction 恰好一次，maxRetries:0，non-idempotent-write', async () => {
    const calls: Array<{ method: string; params: unknown; idempotency: string }> = [];
    const ctx = {
      chain: DEVNET,
      network: chain.network,
      providers: createMockProviderRouter({
        chain: DEVNET,
        handlers: { sendTransaction: () => TX_HASH },
        onCall: (method, call) => calls.push({ method, params: call.params, idempotency: call.idempotency }),
      }),
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    const result = await adapter.broadcast(ctx, signed());
    expect(result.accepted).toBe(true);
    expect(result.ref).toEqual({ kind: 'hash', hash: TX_HASH });
    const sends = calls.filter((c) => c.method === 'sendTransaction');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.idempotency).toBe('non-idempotent-write');
    expect((sends[0]!.params as unknown[])[1]).toMatchObject({ maxRetries: 0, skipPreflight: false });
  });

  it('端点返回的签名与载荷重算不一致 → DFR_PROVIDER_INVALID_RESPONSE', async () => {
    const ctx = makeContext(chain, { sendTransaction: () => '1'.repeat(64) });
    await expect(adapter.broadcast(ctx, signed())).rejects.toMatchObject({
      code: 'DFR_PROVIDER_INVALID_RESPONSE',
    });
  });

  it('already processed（真正的 DFR 错误）→ 幂等成功，不抛错', async () => {
    const ctx = makeContext(chain, {
      sendTransaction: () => {
        throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: DEVNET,
          message: 'Transaction already been processed',
          chainError: { message: 'already been processed' },
        });
      },
    });
    const result = await adapter.broadcast(ctx, signed());
    expect(result.accepted).toBe(true);
    expect(result.ref).toEqual({ kind: 'hash', hash: TX_HASH });
  });

  it('非幂等的普通错误原样上抛（不被误判为 already known）', async () => {
    const ctx = makeContext(chain, {
      sendTransaction: () => {
        throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: DEVNET,
          message: 'provider down',
        });
      },
    });
    await expect(adapter.broadcast(ctx, signed())).rejects.toMatchObject({
      code: 'DFR_PROVIDER_UNAVAILABLE',
    });
  });

  it('带记录真值时做完整绑定：fee payer 不符 → 422 DFR_TRANSACTION_REJECTED，且不广播', async () => {
    const calls: string[] = [];
    const ctx = {
      chain: DEVNET,
      network: chain.network,
      providers: createMockProviderRouter({
        chain: DEVNET,
        handlers: { sendTransaction: () => TX_HASH },
        onCall: (m) => calls.push(m),
      }),
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await expect(
      adapter.broadcast(ctx, signed(), {
        expectedFrom: { chain: DEVNET, address: 'So11111111111111111111111111111111111111112' },
        expectedUnsignedPayload: signedPayload,
      }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED', details: { reason: 'sender_mismatch' } });
    expect(calls).not.toContain('sendTransaction');
  });

  it('带记录真值时：expectedHash 不符 → 拒绝', async () => {
    const ctx = makeContext(chain, { sendTransaction: () => TX_HASH });
    await expect(
      adapter.broadcast(ctx, signed({ expectedHash: '2'.repeat(64) }), {
        expectedFrom: { chain: DEVNET, address: FEE_PAYER },
        expectedUnsignedPayload: signedPayload,
      }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
  });

  it('带记录真值时：未签名载荷与签名载荷不是同一笔 → 拒绝（并给出 reason）', async () => {
    const ctx = makeContext(chain, { sendTransaction: () => TX_HASH });
    const other = SOLANA_DEVNET_FIXTURES.find((f) => f.version === 'v0')!;
    await expect(
      adapter.broadcast(ctx, signed(), {
        expectedFrom: { chain: DEVNET, address: FEE_PAYER },
        expectedUnsignedPayload: other.blockPayloadBase64,
      }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED', details: { reason: 'unsigned_payload_mismatch' } });
  });

  it('半个真值（只给 expectedFrom）→ invalid_expectation，不广播', async () => {
    const calls: string[] = [];
    const ctx = {
      chain: DEVNET,
      network: chain.network,
      providers: createMockProviderRouter({
        chain: DEVNET,
        handlers: { sendTransaction: () => TX_HASH },
        onCall: (m) => calls.push(m),
      }),
      signal: new AbortController().signal,
      requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
    };
    await expect(
      adapter.broadcast(ctx, signed(), { expectedFrom: { chain: DEVNET, address: FEE_PAYER } }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED', details: { reason: 'invalid_expectation' } });
    expect(calls).not.toContain('sendTransaction');
  });
});

describe('Solana 签名绑定（bindSignedTransaction，M3-C01）', () => {
  it('真实签名载荷：绑定通过，txHash = 第 0 个签名', () => {
    const result = bindSignedTransaction(signedPayload, {
      from: FEE_PAYER,
      unsignedPayload: signedPayload,
      expectedHash: TX_HASH,
    });
    expect(result.txHash).toBe(TX_HASH);
    expect(result.decoded.signed).toBe(true);
  });

  it('未签名（全零签名）→ not_signed', () => {
    // 把签名段清零：前 1 字节是签名数量（1），其后 64 字节是签名。
    const bytes = Buffer.from(signedPayload, 'base64');
    bytes.fill(0, 1, 65);
    const unsigned = bytes.toString('base64');
    try {
      bindSignedTransaction(unsigned, { from: FEE_PAYER, unsignedPayload: unsigned, expectedHash: TX_HASH });
      throw new Error('expected to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(SolanaBindingError);
      expect((err as SolanaBindingError).reason).toBe('not_signed');
    }
  });
});
