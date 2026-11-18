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
  it('route metadata keeps the write gate and transaction.read scope, and extracts txHash from the path', () => {
    expect(matchRoute('POST', `/v1/transactions/${txHash}/confirm`)).toEqual({
      handler: 'confirmTransaction',
      routeClass: 'write',
      capability: 'transaction.read',
      txHash,
    });
  });

  it('caps the timeout upper bound and passes txHash/requestId to the engine, returning a 200 envelope', async () => {
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

  it.each([0, 999, 600001, 1.5, Number.NaN])('rejects illegal timeoutMs=%s', async (timeoutMs) => {
    await expect(handleConfirmTransaction(
      txHash,
      { chain: 'ethereum-sepolia', timeoutMs },
      context(async () => confirmation),
    )).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });
  });

  it('rejects an illegal finality target and an empty hash', async () => {
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

  it('fails closed when the transaction engine is not assembled', async () => {
    await expect(handleConfirmTransaction(
      txHash,
      { chain: 'ethereum-sepolia' },
      context(),
    )).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
  });
});
