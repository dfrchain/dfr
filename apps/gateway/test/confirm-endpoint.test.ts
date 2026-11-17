import { describe, expect, it } from 'vitest';
import { handleConfirmTransaction } from '../src/handlers/write.js';
import { matchRoute } from '../src/routes.js';

const requestId = 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV' as never;
const txHash = `0x${'a'.repeat(64)}`;
const confirmation = {
  ref: { kind: 'hash', hash: txHash },
  status: 'included',
  finality: 'included',
  blockRef: { kind: 'number', number: '100' },
  confirmations: '2',
  requiredFinality: 'finalized',
  reached: false,
};

function context(confirm?: (input: unknown) => Promise<unknown>) {
  return {
    requestId,
    projectId: 'default',
    signal: new AbortController().signal,
    ...(confirm !== undefined ? { engine: { confirm } } : {}),
  } as unknown as Parameters<typeof handleConfirmTransaction>[2];
}

describe('confirm endpoint', () => {
  it('路由元数据保留 write 闸门与 transaction.read scope，并从 path 解出 txHash', () => {
    expect(matchRoute('POST', `/v1/transactions/${txHash}/confirm`)).toEqual({
      handler: 'confirmTransaction',
      routeClass: 'write',
      capability: 'transaction.read',
      txHash,
    });
  });

  it('限制 timeout 上界并将 txHash/requestId 传给引擎，返回 200 封套', async () => {
    let received: unknown;
    const result = await handleConfirmTransaction(
      txHash,
      { chain: 'ethereum-sepolia', minFinality: 'finalized', timeoutMs: 60_000 },
      context(async (input) => { received = input; return confirmation; }),
    );
    expect(received).toMatchObject({
      chain: 'ethereum-sepolia',
      txHash,
      minFinality: 'finalized',
      timeoutMs: 60_000,
      requestId,
    });
    expect(result).toEqual({ status: 200, body: { confirmation, requestId } });
  });

  it.each([0, 999, 600001, 1.5, Number.NaN])('拒绝非法 timeoutMs=%s', async (timeoutMs) => {
    await expect(handleConfirmTransaction(
      txHash,
      { chain: 'ethereum-sepolia', timeoutMs },
      context(async () => confirmation),
    )).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('拒绝非法 finality 目标与空哈希', async () => {
    await expect(handleConfirmTransaction(
      txHash,
      { chain: 'ethereum-sepolia', minFinality: 'unknown' },
      context(async () => confirmation),
    )).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
    await expect(handleConfirmTransaction(
      '',
      { chain: 'ethereum-sepolia' },
      context(async () => confirmation),
    )).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('未装配交易引擎时 fail-closed', async () => {
    await expect(handleConfirmTransaction(
      txHash,
      { chain: 'ethereum-sepolia' },
      context(),
    )).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });
});
