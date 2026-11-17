import { describe, expect, it } from 'vitest';
import { handleBroadcastTransaction } from '../src/handlers/write.js';

const signed = { schemaVersion: '1', chain: 'ethereum-sepolia', unsigned: { schemaVersion: '1', chain: 'ethereum-sepolia', payload: '0x01', meta: {} }, signedPayload: '0x02', expectedHash: '0xhash' };
const context = (key?: string, broadcast: (...args: readonly unknown[]) => Promise<unknown> = async () => ({ transactionId: 'txn_1', status: 'broadcast', txHash: '0xhash', accepted: true, observedAt: '2026-01-01T00:00:00.000Z' })) => ({ requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV', projectId: 'default', signal: new AbortController().signal, ...(key === undefined ? {} : { idempotencyKey: key }), engine: { broadcast } } as unknown as Parameters<typeof handleBroadcastTransaction>[1]);

describe('broadcast endpoint', () => {
  it('缺少 Idempotency-Key 失败', async () => {
    await expect(handleBroadcastTransaction({ transactionId: 'txn_1', signedTransaction: signed }, context())).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });
  it('默认 rebroadcast=false 且返回 202', async () => {
    let options: unknown;
    const result = await handleBroadcastTransaction({ transactionId: 'txn_1', signedTransaction: signed }, context('idem-key', async (input) => { options = (input as { options: unknown }).options; return { transactionId: 'txn_1', status: 'broadcast', txHash: '0xhash', accepted: true, observedAt: '2026-01-01T00:00:00.000Z' }; }));
    expect(result.status).toBe(202);
    expect(options).toMatchObject({ rebroadcast: false, idempotencyKey: 'idem-key' });
  });
});
