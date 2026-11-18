/**
 * Rebroadcast-path contract test (TODO-012).
 *
 * What the pre-review found: `rebroadcast: true` was **unreachable** in the engine — four docs claimed it was available, but
 * `assertBroadcastable` only admitted `simulated`, and the follow-up used the `sign` event, which `dropped``
 * has no inbound edge for. An executable probe once measured `broadcastCalls=0`.
 *
 * This file locks the rebroadcast path as usable, with negative controls to stop it being loosened by mistake:
 *   1. `dropped` + explicit `rebroadcast: true` → take the `rebroadcast` event, broadcast once, state back to `broadcast`;
 *   2. `dropped` without an explicit `rebroadcast` → reject (the state machine requires the explicit flag, guarding against an implicit second broadcast);
 *   3. a **non-`dropped`** state passing `rebroadcast: true` → reject (rebroadcast must not bypass the state gate);
 *   4. a rebroadcast still calls the Adapter broadcast exactly once (non-idempotent-write is not retried).
 */
import { describe, expect, it } from 'vitest';
import { TransactionEngine } from '../src/index.js';
import { createInMemoryTransactionStores } from '../../../tests/e2e/support/in-memory-transaction-stores.js';

const CHAIN = 'ethereum-sepolia' as never;
const TX = 'txn_rebroadcast_probe' as never;
const HASH = `0x${'aa'.repeat(32)}`;
const UNSIGNED = { schemaVersion: '1', chain: CHAIN, payload: '0x02f8', meta: {} };

function signed() {
  return {
    schemaVersion: '1',
    chain: CHAIN,
    unsigned: UNSIGNED,
    signedPayload: '0x02f8signed',
    expectedHash: HASH,
  } as never;
}

async function harness(status: string, withExpectedHash = true, failBroadcast?: Error) {
  const stores = createInMemoryTransactionStores();
  await stores.transaction.create({
    record: {
      transactionId: TX,
      projectId: 'default',
      chain: CHAIN,
      requestFingerprint: 'f'.repeat(64),
      status,
      stateVersion: '0',
      from: { chain: CHAIN, address: '0x1111111111111111111111111111111111111111' },
      unsignedPayload: UNSIGNED.payload,
      ...(withExpectedHash ? { expectedHash: HASH } : {}),
      nonce: '7',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
  });
  let broadcastCalls = 0;
  const engine = new TransactionEngine({
    stores,
    chain: {
      broadcast: async () => {
        broadcastCalls += 1;
        if (failBroadcast !== undefined) throw failBroadcast;
        return { accepted: true, ref: { kind: 'hash', hash: HASH }, observedAt: new Date().toISOString() };
      },
    } as never,
    newTransactionId: () => TX,
  });
  return { engine, stores, calls: () => broadcastCalls };
}

describe('Rebroadcast path (TODO-012)', () => {
  it('dropped + explicit rebroadcast:true → single broadcast, state back to broadcast, result flagged rebroadcast', async () => {
    const h = await harness('dropped');

    const result = await h.engine.broadcast({
      transactionId: TX,
      signed: signed(),
      options: { rebroadcast: true } as never,
    });

    expect(result.rebroadcast).toBe(true);
    expect(result.status).toBe('broadcast');
    expect(h.calls()).toBe(1);
  });

  it('TX-04: an uncertain rebroadcast error persists unknown; original error survives; no duplicate network send', async () => {
    const networkError = new Error('TX-04 simulated after-send timeout');
    const h = await harness('dropped', true, networkError);
    const attempt = h.engine.broadcast({
      transactionId: TX, signed: signed(), options: { rebroadcast: true } as never,
    });
    await expect(attempt).rejects.toBe(networkError);
    expect(h.calls()).toBe(1);
    const persisted = await h.stores.transaction.get(TX);
    expect(persisted?.status).toBe('unknown');
    expect(persisted?.expectedHash).toBe(HASH);
    expect(persisted?.nonce).toBe('7');
    await expect(h.engine.broadcast({
      transactionId: TX, signed: signed(), options: { rebroadcast: true } as never,
    })).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect(h.calls()).toBe(1);
  });

  it('TX-04: rebroadcast failure CAS transition should never mark failed or dropped', async () => {
    const h = await harness('dropped', true, new Error('rejected by provider after uncertain network delivery'));
    await expect(h.engine.broadcast({
      transactionId: TX, signed: signed(), options: { rebroadcast: true } as never,
    })).rejects.toThrow('rejected by provider');
    expect((await h.stores.transaction.get(TX))?.status).toBe('unknown');
    expect(h.calls()).toBe(1);
  });

  it('dropped without an explicit rebroadcast → reject (guard against an implicit second broadcast)', async () => {
    const h = await harness('dropped');

    await expect(
      h.engine.broadcast({ transactionId: TX, signed: signed() }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    // Key point: a rejection must **not** emit a broadcast.
    expect(h.calls()).toBe(0);
  });

  it.each(['simulated', 'built', 'signed', 'broadcast', 'pending', 'included', 'confirmed'])(
    'a non-dropped state %s passing rebroadcast:true → reject (rebroadcast must not bypass the state gate)',
    async (status) => {
      const h = await harness(status);

      const error = await h.engine
        .broadcast({
          transactionId: TX,
          signed: signed(),
          options: { rebroadcast: true } as never,
        })
        .then(() => undefined, (e: unknown) => e);

      expect(error).toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
      expect(h.calls()).toBe(0);
    },
  );

  it('a rebroadcast whose expectedHash differs from the record → reject with zero broadcasts (no swapping in another transaction via rebroadcast)', async () => {
    const h = await harness('dropped');

    const error = await h.engine
      .broadcast({
        transactionId: TX,
        signed: { ...(signed() as object), expectedHash: `0x${'cc'.repeat(32)}` } as never,
        options: { rebroadcast: true } as never,
      })
      .then(() => undefined, (e: unknown) => e);

    expect(error).toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect((error as { details?: { reason?: string } }).details?.reason).toBe(
      'expected_hash_mismatch',
    );
    expect(h.calls()).toBe(0);
  });

  it('a dropped record missing its original expectedHash must refuse rebroadcast with zero broadcasts', async () => {
    const h = await harness('dropped', false);
    expect((await h.stores.transaction.get(TX))?.expectedHash).toBeUndefined();

    const err = await h.engine.broadcast({
      transactionId: TX,
      signed: signed(),
      options: { rebroadcast: true } as never,
    }).then(() => undefined, (e: unknown) => e);

    expect(err).toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect(h.calls()).toBe(0);
  });

  it('a dropped rebroadcast cannot replace the persisted unsigned payload; reject with zero broadcasts', async () => {
    const h = await harness('dropped');
    const altered = signed() as { unsigned: { payload: string } };
    const error = await h.engine.broadcast({
      transactionId: TX,
      signed: {
        ...altered,
        unsigned: { ...altered.unsigned, payload: `${altered.unsigned.payload}tampered` },
      } as never,
      options: { rebroadcast: true } as never,
    }).then(() => undefined, (e: unknown) => e);

    expect(error).toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
    expect((error as { details?: { reason?: string } }).details?.reason).toBe('unsigned_payload_mismatch');
    expect(h.calls()).toBe(0);
    expect((await h.stores.transaction.get(TX))?.status).toBe('dropped');
  });

  it('concurrent explicit rebroadcasts of the same dropped transaction broadcast at most once (CAS forbids double-send)', async () => {
    const h = await harness('dropped');
    const attempt = () => h.engine.broadcast({
      transactionId: TX,
      signed: signed(),
      options: { rebroadcast: true } as never,
    });
    const outcomes = await Promise.allSettled([attempt(), attempt()]);

    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(h.calls()).toBe(1);
    expect((await h.stores.transaction.get(TX))?.status).toBe('broadcast');
  });

  it('simulated without rebroadcast → still take the first-broadcast path (no regression from the new branch)', async () => {
    const h = await harness('simulated');

    const result = await h.engine.broadcast({ transactionId: TX, signed: signed() });

    expect(result.status).toBe('broadcast');
    expect(h.calls()).toBe(1);
    // A first broadcast must not be flagged as a rebroadcast.
    expect(result.rebroadcast).toBeUndefined();
  });
});
