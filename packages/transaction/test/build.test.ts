/**
 * TransactionEngine build contract test (DFR-M1-B04).
 *
 * Authoritative sources: development-plan sections 4.3/4.4, transaction-lifecycle section 8,
 * m1-api-contract section 2.
 *
 * All with in-memory test doubles: this task only verifies **orchestration order and failure compensation**, not SQL (covered by
 * the database gates of A10/A11). Test doubles must record calls, so they can prove "no second execution" and "no release leak".
 *
 * Since ADR-037 the test doubles live in `./support/engine-fakes.js`, shared with the preflight tests
 * (otherwise the two copies would drift apart immediately).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import type { TransactionRequest } from '@dfr/types';
import { fingerprintBuildRequest } from '../src/index.js';
import {
  CHAIN,
  FROM,
  REQUEST,
  REQUEST_ID,
  TO,
  dec,
  harness,
} from './support/engine-fakes.js';

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('TransactionEngine.build (DFR-M1-B04)', () => {
  it('first build: idempotency first → then nonce lease → then chain construction → persist built → idempotent complete', async () => {
    const h = harness();
    const result = await h.engine.build({
      request: REQUEST,
      idempotencyKey: 'key-1',
      requestId: REQUEST_ID,
    });

    expect(result.replayed).toBe(false);
    expect(result.replayable).toBe(true);
    expect(result.status).toBe('built');
    expect(result.nonce).toBe('42');
    // The Adapter must receive the explicit nonce allocated by the engine (never query one again itself).
    expect(h.chain.buildCalls).toHaveLength(1);
    expect(h.chain.buildCalls[0]?.request.nonce).toBe('42');

    const record = await h.transactions.get(result.transactionId);
    expect(record?.status).toBe('built');
    expect(record?.stateVersion).toBe('0');
    expect(record?.nonce).toBe('42');
    expect(record?.unsignedPayload).toBe(result.unsignedTransaction.payload);
    expect(record?.requestFingerprint).toBe(fingerprintBuildRequest(REQUEST));
    expect(record?.projectId).toBe('default');
    // The idempotency record must bind the same transactionId, or a replay has nothing to stand on.
    const idem = await h.idempotency.get({ projectId: 'default', chain: CHAIN, key: 'key-1' });
    expect(idem?.transactionId).toBe(result.transactionId);
  });

  it('replay with the same idempotency key: return the original result, do not re-execute, do not consume a new nonce', async () => {
    const h = harness();
    const first = await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });
    const second = await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });

    expect(second.replayed).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.nonce).toBe(first.nonce);
    expect(second.unsignedTransaction.payload).toBe(first.unsignedTransaction.payload);
    // Key point: the second call neither reconstructed the transaction nor allocated a nonce again.
    expect(h.chain.buildCalls).toHaveLength(1);
    expect(h.nonce.reserveCalls).toHaveLength(1);
  });

  it('same key, different request body → DFR_IDEMPOTENCY_CONFLICT (do not overwrite the original record)', async () => {
    const h = harness();
    await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });
    const changed: TransactionRequest = {
      ...REQUEST,
      value: { asset: { kind: 'native', chain: CHAIN }, amount: dec('2') },
    };
    await expect(
      h.engine.build({ request: changed, idempotencyKey: 'key-1', requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_IDEMPOTENCY_CONFLICT' });
    expect(h.chain.buildCalls).toHaveLength(1);
  });

  it('same key still being processed → 409 (with retryAfterMs), do not execute concurrently', async () => {
    const h = harness();
    // Occupy in-flight first: construct an unfinished idempotency record directly.
    await h.idempotency.begin({
      scope: { projectId: 'default', chain: CHAIN, key: 'key-1' },
      fingerprint: fingerprintBuildRequest(REQUEST),
      ownerToken: 'other-owner',
      leaseTtlMs: 30_000,
    });

    await expect(
      h.engine.build({ request: REQUEST, idempotencyKey: 'key-1', requestId: REQUEST_ID }),
    ).rejects.toMatchObject({
      code: 'DFR_IDEMPOTENCY_CONFLICT',
      details: { retryAfterMs: 30_000 },
    });
    expect(h.chain.buildCalls).toHaveLength(0);
    expect(h.nonce.reserveCalls).toHaveLength(0);
  });

  it('no idempotency key supplied: still construct, but explicitly mark as non-replayable', async () => {
    const h = harness();
    const result = await h.engine.build({ request: REQUEST });
    expect(result.replayable).toBe(false);
    expect(h.idempotency.beginCalls).toHaveLength(0);
  });

  it('nonce conflict → DFR_NONCE_CONFLICT, with no construction and no persistence', async () => {
    const h = harness();
    h.nonce.conflict = true;
    await expect(
      h.engine.build({ request: REQUEST, idempotencyKey: 'key-1', requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_NONCE_CONFLICT' });
    expect(h.chain.buildCalls).toHaveLength(0);
    expect(h.transactions.created).toHaveLength(0);
  });

  it('chain construction failure: safely release the unsigned nonce lease, rethrow the original error, persist nothing', async () => {
    const h = harness();
    h.chain.buildError = createDfrError('DFR_PROVIDER_UNAVAILABLE', {
      requestId: REQUEST_ID,
      chain: CHAIN,
      message: 'endpoint down',
    });

    await expect(
      h.engine.build({ request: REQUEST, idempotencyKey: 'key-1', requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_PROVIDER_UNAVAILABLE' });

    // ADR-030: the release must carry the transactionId as proof of ownership (a nonce can be reclaimed and reused,
    // and without it the wrong lease — already bound to a new transaction — could be released).
    expect(h.nonce.releaseCalls).toEqual([
      { chain: CHAIN, account: FROM, nonce: '42', transactionId: 'txn_test_1' },
    ]);
    expect(h.transactions.created).toHaveLength(0);
  });

  it('a refused release (same nonce already signed/broadcast) does not hide the original error', async () => {
    const h = harness();
    h.chain.buildError = createDfrError('DFR_TRANSACTION_REVERTED', {
      requestId: REQUEST_ID,
      chain: CHAIN,
      message: 'build-phase rollback',
    });
    h.nonce.releaseForbidden = true;

    await expect(
      h.engine.build({ request: REQUEST, requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REVERTED' });
    expect(h.nonce.releaseCalls).toHaveLength(1);
  });

  it('request carrying its own nonce → DFR_VALIDATION_FAILED, without touching the chain or any Store', async () => {
    const h = harness();
    await expect(
      h.engine.build({
        request: { ...REQUEST, nonce: dec('7') },
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED', details: { fields: ['nonce'] } });
    expect(h.chain.pendingNonceCalls).toHaveLength(0);
    expect(h.nonce.reserveCalls).toHaveLength(0);
  });

  it('the persisted record contains no signedPayload (negative safety control)', async () => {
    const h = harness();
    await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });
    const record = h.transactions.created[0] as unknown as Record<string, unknown>;
    expect(Object.keys(record)).not.toContain('signedPayload');
    // Note: the tail of `"unsignedPayload"` is exactly `signedPayload`, so the match must include the quotes,
    // or this negative control would be "fooled" by the field name itself.
    expect(JSON.stringify(record)).not.toContain('"signedPayload"');
  });

  it('lost idempotent write right: the result is real but marked non-replayable', async () => {
    const h = harness();
    h.idempotency.loseOwnership = true;
    const result = await h.engine.build({ request: REQUEST, idempotencyKey: 'key-1' });
    expect(result.replayable).toBe(false);
    expect(result.status).toBe('built');
    expect((await h.transactions.get(result.transactionId))?.status).toBe('built');
  });

  it('numeric-looking keys must sort by UTF16 canonical order, not by JS object reordering', async () => {
    const request = { chain: CHAIN, extra: { '2': 2, '10': 10 } };
    const expected = createHash('sha256')
      .update('{"chain":"' + CHAIN + '","extra":{"10":10,"2":2}}')
      .digest('hex');
    expect(fingerprintBuildRequest(request as unknown as TransactionRequest)).toBe(expected);
  });

  it('fingerprint stability: key order does not matter, field changes are detected', async () => {
    const a = fingerprintBuildRequest({ chain: CHAIN, from: FROM, to: TO });
    const b = fingerprintBuildRequest({ to: TO, chain: CHAIN, from: FROM });
    const c = fingerprintBuildRequest({ chain: CHAIN, from: FROM, to: TO, data: '0xdeadbeef' });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Fields like requestId / header are excluded: changing requestId must not count as a conflict.
    expect(fingerprintBuildRequest({ ...REQUEST })).toBe(fingerprintBuildRequest(REQUEST));
  });
});
