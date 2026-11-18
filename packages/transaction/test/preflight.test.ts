/**
 * TransactionEngine.preflight contract test (ADR-037, option B).
 *
 * Authoritative source: `docs/adr/ADR-037-abandoned-built-transaction-reclaim.md`.
 *
 * The core assertion of this test is **zero side effects**: preflight must
 *   - not reserve a nonce (`nonce.reserveCalls` is empty);
 *   - not create a transaction record (`transactions.created` is empty);
 *   - not write the idempotency table (`idempotency.beginCalls` is empty);
 *   - not move the nonce watermark / not produce any reclaimable state.
 *
 * Why this matters: the cause ADR-037 measured is exactly "callers using build for preflight",
 * burning one nonce per build. If preflight also took a nonce, it would be pointless.
 */
import { describe, expect, it } from 'vitest';
import { dec, harness, REQUEST, REQUEST_ID } from './support/engine-fakes.js';

describe('TransactionEngine.preflight (ADR-037, option B)', () => {
  it('zero side effects: no nonce reserve, no record created, no idempotency-table write', async () => {
    const h = harness();
    h.chain.allowSimulate = true;

    const result = await h.engine.preflight({ request: REQUEST, requestId: REQUEST_ID });

    // Core assertion: all three side effects are **exactly zero**.
    expect(h.nonce.reserveCalls).toEqual([]);
    expect(h.transactions.created).toEqual([]);
    expect(h.idempotency.beginCalls).toEqual([]);

    // But it did read the parameters, construct the payload, and run the simulation.
    expect(h.chain.pendingNonceCalls).toHaveLength(1);
    expect(h.chain.buildCalls).toHaveLength(1);
    expect(h.chain.simulateCalls).toHaveLength(1);
    expect(result.simulation.success).toBe(true);
    expect(result.requestId).toBe(REQUEST_ID);
  });

  it('10 repeated calls still have zero side effects (exactly what callers used to do with build)', async () => {
    const h = harness();
    h.chain.allowSimulate = true;

    for (let i = 0; i < 10; i += 1) {
      await h.engine.preflight({ request: REQUEST });
    }

    expect(h.nonce.reserveCalls).toEqual([]);
    expect(h.transactions.created).toEqual([]);
    expect(h.chain.buildCalls).toHaveLength(10);
  });

  it('read-only fetch of the pending nonce and report observedNonce (no lease persisted)', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    h.chain.pendingNonce = dec('7');

    const result = await h.engine.preflight({ request: REQUEST });

    expect(result.observedNonce).toBe('7');
    // The request passed to the Adapter carries that nonce (otherwise no payload could be constructed), but there is **no** lease.
    expect(h.chain.buildCalls[0]!.request.nonce).toBe('7');
    expect(h.nonce.reserveCalls).toEqual([]);
  });

  it('a simulation revert does not throw: return with success=false (deliberately different from the 422 semantics of simulate)', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    h.chain.simulateResult = { success: false, revertReason: 'insufficient output amount' };

    const result = await h.engine.preflight({ request: REQUEST });

    expect(result.simulation.success).toBe(false);
    expect(result.simulation.revertReason).toBe('insufficient output amount');
    // Still no side effects — a failure must not leave a record either.
    expect(h.transactions.created).toEqual([]);
    expect(h.nonce.reserveCalls).toEqual([]);
  });

  it('reject a caller-supplied nonce (same discipline as build, avoiding bypassing server-side allocation)', async () => {
    const h = harness();
    h.chain.allowSimulate = true;

    await expect(
      h.engine.preflight({ request: { ...REQUEST, nonce: dec('5') } }),
    ).rejects.toMatchObject({ code: 'DFR_VALIDATION_FAILED' });

    // Validation comes before any chain call.
    expect(h.chain.pendingNonceCalls).toEqual([]);
    expect(h.chain.buildCalls).toEqual([]);
  });

  it('missing ordering-precondition read capability → fail-closed (no silent downgrade)', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    // `getPendingNonce` is a prototype method; `delete instance.x` cannot remove it;
    // it must be shadowed with `Object.defineProperty` (otherwise this case would pass vacuously).
    Object.defineProperty(h.chain, 'getPendingNonce', { value: undefined, configurable: true });

    await expect(h.engine.preflight({ request: REQUEST })).rejects.toMatchObject({
      code: 'DFR_UNSUPPORTED_CAPABILITY',
    });
    // Validation comes before any chain call.
    expect(h.chain.buildCalls).toEqual([]);
  });
});

describe('TransactionEngine.preflight: revert during the gas-estimation phase (caught on a real chain, 2026-10-07)', () => {
  it('★ build-phase revert → return 200 + success=false, **do not throw**', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    // On a real chain, a transaction doomed to revert reverts at `eth_estimateGas`, so build throws.
    h.chain.buildRevert = 'RecomputeMismatch';

    const result = await h.engine.preflight({ request: REQUEST });

    expect(result.simulation.success).toBe(false);
    expect(result.simulation.revertReason).toBe('RecomputeMismatch');
    // Honest: when it reverts, **do not** return a fabricated preview payload.
    expect(result.unsignedTransaction).toBeUndefined();
    // Still zero side effects.
    expect(h.transactions.created).toEqual([]);
    expect(h.nonce.reserveCalls).toEqual([]);
  });

  it('non-revert errors (Provider unavailable, etc.) keep being thrown — no downgrade, no guessing', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    h.chain.buildError = new Error('provider down');

    await expect(h.engine.preflight({ request: REQUEST })).rejects.toThrow('provider down');
  });
});
