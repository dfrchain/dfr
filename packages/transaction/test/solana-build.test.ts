/**
 * 引擎的 Solana build 路径（DFR-M3-B03，ADR-033）。
 *
 * 证明"同一套引擎状态机服务两链"：这里**不**改 EVM 的任何断言，只用一组
 * Solana 形态的 chain port + 一个最小 SequencingStore，跑同一套 `engine.build`。
 */
import { describe, expect, it } from 'vitest';
import type { AccountRef, ChainId, DecimalUint, SequencingToken } from '@dfr/types';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';
import type {
  SequencingStore,
  SequencingLease,
  SequencingLeaseRef,
  ReserveSequencingInput,
  ReserveSequencingResult,
  AdvanceSequencingResult,
  ReleaseSequencingResult,
} from '../src/stores.js';
import { TransactionEngine } from '../src/engine.js';
import type { TransactionChainPort } from '../src/engine.js';

const chain = 'solana-devnet' as ChainId;
const from: AccountRef = { chain, address: '11111111111111111111111111111111' };
const to: AccountRef = { chain, address: 'So11111111111111111111111111111111111111112' };
const BLOCKHASH = '1'.repeat(48) + '2345'; // secret-scan:allow public-blockhash-placeholder
const LAST_VALID = 495_317_734;

/** 最小内存 SequencingStore（与 stores.test.ts 的实现同构，供引擎路径使用）。 */
function inMemorySequencing(): SequencingStore {
  const rows = new Map<string, SequencingLease>();
  return {
    async reserve(input: ReserveSequencingInput): Promise<ReserveSequencingResult> {
      const existing = rows.get(input.transactionId);
      if (existing !== undefined) {
        if (existing.status !== 'reserved'
          || existing.chain !== input.chain
          || existing.account.address !== input.account.address
          || existing.token.kind !== 'blockhash'
          || input.token.kind !== 'blockhash'
          || existing.token.value !== input.token.value
          || existing.token.lastValidBlockHeight !== input.token.lastValidBlockHeight) {
          throw new Error('sequencing lease replay is inactive or token/owner differs');
        }
        return { kind: 'reused', lease: existing };
      }
      const lease: SequencingLease = {
        chain: input.chain,
        account: input.account,
        token: input.token,
        transactionId: input.transactionId,
        status: 'reserved',
        expiresAt: '2026-10-06T00:00:00Z' as never,
      };
      rows.set(input.transactionId, lease);
      return { kind: 'reserved', lease };
    },
    async markConsumed(ref: SequencingLeaseRef): Promise<AdvanceSequencingResult> {
      const row = rows.get(ref.transactionId);
      if (row === undefined || (row.status !== 'reserved' && row.status !== 'consumed')) {
        return { kind: 'not_found' };
      }
      const next = { ...row, status: 'consumed' as const };
      rows.set(ref.transactionId, next);
      return { kind: 'updated', lease: next };
    },
    async releaseIfSafe(ref: SequencingLeaseRef): Promise<ReleaseSequencingResult> {
      const row = rows.get(ref.transactionId);
      if (row === undefined) return { kind: 'not_found' };
      if (row.status === 'consumed') {
        return { kind: 'forbidden', lease: row, reason: 'already_consumed' };
      }
      const next = { ...row, status: 'released' as const };
      rows.set(ref.transactionId, next);
      return { kind: 'released', lease: next };
    },
    async releaseExpiredOrphaned(): Promise<number> {
      return 0;
    },
  };
}

function solanaPort(overrides: Partial<TransactionChainPort> = {}): TransactionChainPort {
  return {
    // 关键：Solana 端口**没有** getPendingNonce，只有 getSequencingToken + 注入方法。
    getSequencingToken: async (): Promise<SequencingToken> => ({
      kind: 'blockhash',
      value: BLOCKHASH,
      lastValidBlockHeight: String(LAST_VALID) as DecimalUint,
    }),
    withSequencingToken: (req, token) => {
      if (token.kind !== 'blockhash') throw new Error('expected blockhash');
      return { ...req, recentBlockhash: token.value };
    },
    build: async ({ request }) => {
      // 断言引擎把 blockhash 注入了 build 请求（否则租约与载荷会不一致）。
      if (request.recentBlockhash !== BLOCKHASH) {
        throw new Error(`build 未收到注入的 blockhash：${String(request.recentBlockhash)}`);
      }
      return {
        schemaVersion: '1',
        chain: request.chain,
        payload: 'AQID', // 占位 base64
        meta: { encoding: 'base64', recentBlockhash: request.recentBlockhash },
      };
    },
    simulate: async () => ({ success: true }),
    isSequencingExpired: async () => false,
    ...overrides,
  } as TransactionChainPort;
}

function engine(port: TransactionChainPort, sequencing?: SequencingStore) {
  const stores = createInMemoryTransactionStores();
  return {
    engine: new TransactionEngine({
      stores: { ...stores, ...(sequencing !== undefined ? { sequencing } : {}) },
      chain: port,
      newTransactionId: () => 'txn_sol_build' as never,
    }),
    stores,
  };
}

const REQUEST = {
  chain,
  from,
  to,
  value: { asset: { kind: 'native' as const, chain }, amount: '1' },
};

describe('引擎 Solana build 路径（M3-B03 / ADR-033）', () => {
  it('无 getPendingNonce → 走 sequencing 路径，blockhash 落租约并注入 build', async () => {
    const { engine: eng, stores } = engine(solanaPort(), inMemorySequencing());
    const result = await eng.build({ request: REQUEST as never, idempotencyKey: 'sol-1' });

    expect(result.status).toBe('built');
    expect(result.nonce).toBeUndefined();
    expect(result.sequencingToken).toEqual({
      kind: 'blockhash',
      value: BLOCKHASH,
      lastValidBlockHeight: String(LAST_VALID),
    });
    // 记录里带 sequencingRef，且没有 nonce。
    const record = await stores.transaction.get('txn_sol_build' as never);
    expect(record?.sequencingRef).toEqual({
      kind: 'blockhash',
      value: BLOCKHASH,
      lastValidBlockHeight: String(LAST_VALID),
    });
    expect(record?.nonce).toBeUndefined();
    expect(record?.unsignedPayload).toBe('AQID');
  });

  it('装配了 sequencing 才允许 blockhash 路径；缺失 → fail-closed（不静默走 nonce）', async () => {
    const { engine: eng } = engine(solanaPort()); // 未传 sequencing store
    await expect(eng.build({ request: REQUEST as never })).rejects.toMatchObject({
      code: 'DFR_CONFIGURATION_ERROR',
    });
  });

  it('build 失败时释放 blockhash 租约（不留下永久占用的排序前提）', async () => {
    const store = inMemorySequencing();
    const released: string[] = [];
    const original = store.releaseIfSafe.bind(store);
    store.releaseIfSafe = (ref) => {
      released.push(ref.transactionId);
      return original(ref);
    };
    const { engine: eng } = engine(
      solanaPort({ build: async () => { throw new Error('provider boom'); } }),
      store,
    );
    await expect(eng.build({ request: REQUEST as never })).rejects.toThrow('provider boom');
    expect(released).toEqual(['txn_sol_build']);
  });

  it('B45: signing commits the Solana sequencing lease as consumed before any RPC broadcast', async () => {
    const sequencing = inMemorySequencing();
    const order: string[] = [];
    const markConsumed = sequencing.markConsumed.bind(sequencing);
    sequencing.markConsumed = async (ref) => {
      order.push('consumed');
      return markConsumed(ref);
    };
    const port = solanaPort({
      broadcast: async () => {
        order.push('broadcast');
        return {
          ref: { kind: 'hash', hash: 'SolanaTestSignature' },
          status: 'broadcast', accepted: true, providerId: 'local-test' as never,
          observedAt: '2026-10-23T00:00:00.000Z' as never,
        };
      },
    });
    const { engine: eng } = engine(port, sequencing);
    const built = await eng.build({ request: REQUEST as never });
    await eng.simulate({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    const result = await eng.broadcast({
      transactionId: built.transactionId,
      signed: {
        schemaVersion: '1',
        chain,
        unsigned: built.unsignedTransaction,
        signedPayload: 'AQIDBAU=',
        expectedHash: 'SolanaTestSignature',
        signerRef: 'external:test',
      },
    });
    expect(result.accepted).toBe(true);
    expect(order).toEqual(['consumed', 'broadcast']);
    const released = await sequencing.releaseIfSafe({
      chain, account: from, transactionId: built.transactionId, tokenValue: BLOCKHASH,
    });
    expect(released.kind).toBe('forbidden');
  });

  it('B45: a missing/expired sequencing lease blocks network broadcast after durable signing CAS', async () => {
    const sequencing = inMemorySequencing();
    sequencing.markConsumed = async () => ({ kind: 'not_found' });
    let networkCalls = 0;
    const port = solanaPort({
      broadcast: async () => {
        networkCalls += 1;
        throw new Error('must never broadcast');
      },
    });
    const { engine: eng, stores } = engine(port, sequencing);
    const built = await eng.build({ request: REQUEST as never });
    await eng.simulate({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    await expect(eng.broadcast({
      transactionId: built.transactionId,
      signed: {
        schemaVersion: '1',
        chain,
        unsigned: built.unsignedTransaction,
        signedPayload: 'AQIDBAU=',
        expectedHash: 'SolanaTestSignature',
        signerRef: 'external:test',
      },
    })).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect(networkCalls).toBe(0);
    expect((await stores.transaction.get(built.transactionId))?.status).toBe('signed');
  });

  it('B45: sequencing storage error after signed CAS fails closed without sending', async () => {
    const sequencing = inMemorySequencing();
    sequencing.markConsumed = async () => { throw new Error('sequencing DB temporarily unavailable'); };
    let networkCalls = 0;
    const { engine: eng, stores } = engine(solanaPort({
      broadcast: async () => {
        networkCalls += 1;
        throw new Error('network should not be reached');
      },
    }), sequencing);
    const built = await eng.build({ request: REQUEST as never });
    await eng.simulate({
      transactionId: built.transactionId, unsignedTransaction: built.unsignedTransaction,
    });
    await expect(eng.broadcast({
      transactionId: built.transactionId,
      signed: {
        schemaVersion: '1', chain, unsigned: built.unsignedTransaction,
        signedPayload: 'AQIDBAU=', expectedHash: 'SolanaTestSignature',
        signerRef: 'external:test',
      },
    })).rejects.toThrow('sequencing DB temporarily unavailable');
    expect(networkCalls).toBe(0);
    expect((await stores.transaction.get(built.transactionId))?.status).toBe('signed');
  });

  it('EVM 路径不受影响：有 getPendingNonce 时仍走 NonceStore', async () => {
    const { engine: eng, stores } = engine({
      getPendingNonce: async () => '7' as never,
      // 同时提供 sequencing 端口方法，证明分派依据是 **token.kind** 而不是方法存在性。
      getSequencingToken: async () => ({ kind: 'nonce', value: '7' as never }),
      withSequencingToken: (req, token) => ({ ...req, nonce: token.value as never }),
      build: async ({ request }) => ({
        schemaVersion: '1',
        chain: request.chain,
        payload: '0x02f8',
        meta: { encoding: 'hex', requiresNonce: request.nonce ?? ('0' as never) },
      }),
      simulate: async () => ({ success: true }),
    } as TransactionChainPort, inMemorySequencing());
    const result = await eng.build({ request: REQUEST as never });
    expect(result.nonce).toBe('7');
    expect(result.sequencingToken).toEqual({ kind: 'nonce', value: '7' });
    const record = await stores.transaction.get(result.transactionId);
    expect(record?.nonce).toBe('7');
    expect(record?.sequencingRef).toEqual({ kind: 'nonce', value: '7' });
  });
});
