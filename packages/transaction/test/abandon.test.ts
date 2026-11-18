/**
 * TransactionEngine.abandon contract test (ADR-037, option A).
 *
 * Authoritative source: `docs/adr/ADR-037-abandoned-built-transaction-reclaim.md`.
 *
 * The most important negative control: **`signed` and above can never be voided** — otherwise the nonce of a signed/broadcast transaction would be
 * reclaimed, breaking the funds-safety constraints of ADR-018/019.
 */
import { describe, expect, it } from 'vitest';
import type { TransitionTransactionInput } from '../src/index.js';
import { harness, REQUEST, REQUEST_ID } from './support/engine-fakes.js';

describe('TransactionEngine.abandon (ADR-037, option A)', () => {
  it('B37: a concurrent signer winning after read must not lose its nonce', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    const originalGet = h.transactions.get.bind(h.transactions);
    let injected = false;
    h.transactions.get = async (id) => {
      const old = await originalGet(id);
      if (!injected && id === built.transactionId && old?.status === 'built') {
        injected = true;
        const moved = await h.transactions.transition({
          transactionId: old.transactionId,
          expectedStatus: 'built', expectedVersion: old.stateVersion,
          toStatus: 'signed', reason: 'sign',
        });
        expect(moved.kind).toBe('applied');
      }
      return old;
    };
    await expect(h.engine.abandon({ transactionId: built.transactionId })).rejects.toBeDefined();
    expect(h.nonce.releaseCalls).toEqual([]);
    expect((await originalGet(built.transactionId))?.status).toBe('signed');
  });

  it('B37: manual abandon must commit terminal CAS BEFORE releasing the nonce', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    const operations: string[] = [];
    const oldTransition = h.transactions.transition.bind(h.transactions);
    h.transactions.transition = async (input) => {
      operations.push('CAS');
      return oldTransition(input);
    };
    const oldRelease = h.nonce.releaseIfSafe.bind(h.nonce);
    h.nonce.releaseIfSafe = async (ref) => {
      operations.push('release');
      expect((await h.transactions.get(built.transactionId))?.status).toBe('abandoned');
      return oldRelease(ref);
    };
    expect((await h.engine.abandon({ transactionId: built.transactionId })).leaseReleased).toBe(true);
    expect(operations).toEqual(['CAS', 'release']);
  });

  it('voiding built: first transition to terminal abandoned, then safely release the lease', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, requestId: REQUEST_ID });
    expect(built.status).toBe('built');

    const result = await h.engine.abandon({
      transactionId: built.transactionId,
      requestId: REQUEST_ID,
    });

    expect(result.status).toBe('abandoned');
    expect(result.leaseReleased).toBe(true);
    expect(result.nonce).toBe('42');
    // The release must carry the transactionId (ADR-030's proof of ownership).
    expect(h.nonce.releaseCalls).toEqual([
      expect.objectContaining({ nonce: '42', transactionId: built.transactionId }),
    ]);
    // The record is genuinely terminal.
    const record = await h.transactions.get(built.transactionId);
    expect(record?.status).toBe('abandoned');
  });

  it('voiding simulated: equally voidable (both are "unsigned")', async () => {
    const h = harness();
    h.chain.allowSimulate = true;
    const built = await h.engine.build({ request: REQUEST });
    await h.engine.simulate({
      transactionId: built.transactionId,
      unsignedTransaction: built.unsignedTransaction,
    });
    expect((await h.transactions.get(built.transactionId))?.status).toBe('simulated');

    const result = await h.engine.abandon({ transactionId: built.transactionId });
    expect(result.status).toBe('abandoned');
    expect(result.leaseReleased).toBe(true);
  });

  it('idempotent: calling again after abandoned returns 200, without releasing twice', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    await h.engine.abandon({ transactionId: built.transactionId });
    const releasesAfterFirst = h.nonce.releaseCalls.length;

    const second = await h.engine.abandon({ transactionId: built.transactionId });

    expect(second.status).toBe('abandoned');
    expect(second.leaseReleased).toBe(false);
    expect(h.nonce.releaseCalls).toHaveLength(releasesAfterFirst);
  });

  it('★ negative control: a signed transaction **cannot be voided** (never reclaim a signed nonce)', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    // Manually push the record to signed (via an allowed state-machine edge), simulating "the caller already signed".
    const record = (await h.transactions.get(built.transactionId))!;
    await h.transactions.transition({
      transactionId: record.transactionId,
      expectedStatus: 'built',
      expectedVersion: record.stateVersion,
      toStatus: 'signed',
      reason: 'sign',
    } as TransitionTransactionInput);

    await expect(
      h.engine.abandon({ transactionId: built.transactionId }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });

    // Key point: **not a single release happened**.
    expect(h.nonce.releaseCalls).toEqual([]);
    // The state is still signed; it was not changed to abandoned.
    expect((await h.transactions.get(built.transactionId))?.status).toBe('signed');
  });

  it('AUTH-03: a restricted-chain API key cannot void another chain's record by transaction ID', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, projectId: 'project-A' });
    await expect(h.engine.abandon({
      transactionId: built.transactionId,
      requesterProjectId: 'project-A',
      authorizedChains: ['solana-devnet' as never],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(h.nonce.releaseCalls).toHaveLength(0);
    expect((await h.transactions.get(built.transactionId))?.status).toBe('built');
  });

  it('AUTH-03: a transaction outside the requesting project cannot be voided even when the chain is authorized', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, projectId: 'project-A' });
    await expect(h.engine.abandon({
      transactionId: built.transactionId,
      requesterProjectId: 'project-B',
      authorizedChains: ['ethereum-sepolia' as never],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
    expect(h.nonce.releaseCalls).toHaveLength(0);
    expect((await h.transactions.get(built.transactionId))?.status).toBe('built');
  });

  it('AUTH-03: voiding is still allowed safely within an authorized chain and project, staying idempotent', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, projectId: 'project-A' });
    const allowed = {
      transactionId: built.transactionId,
      requesterProjectId: 'project-A',
      authorizedChains: ['ethereum-sepolia' as never],
    };
    expect((await h.engine.abandon(allowed)).leaseReleased).toBe(true);
    const releases = h.nonce.releaseCalls.length;
    expect((await h.engine.abandon(allowed)).leaseReleased).toBe(false);
    expect(h.nonce.releaseCalls).toHaveLength(releases);
  });

  it('AUTH-03: a voided transaction does not expose its idempotent response to an unauthorized key', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST, projectId: 'project-A' });
    await h.engine.abandon({ transactionId: built.transactionId });
    await expect(h.engine.abandon({
      transactionId: built.transactionId,
      requesterProjectId: 'project-A',
      authorizedChains: ['solana-devnet' as never],
    })).rejects.toMatchObject({ code: 'DFR_PROJECT_SCOPE_DENIED' });
  });

  it('unknown transaction → DFR_TRANSACTION_NOT_FOUND', async () => {
    const h = harness();
    await expect(
      h.engine.abandon({ transactionId: 'txn_nope' as never }),
    ).rejects.toMatchObject({ code: 'DFR_TRANSACTION_NOT_FOUND' });
  });

  it('when the release is refused (theoretically unreachable), still advance to the terminal state: no "forever built"', async () => {
    const h = harness();
    const built = await h.engine.build({ request: REQUEST });
    h.nonce.releaseForbidden = true;

    const result = await h.engine.abandon({ transactionId: built.transactionId });

    expect(result.leaseReleased).toBe(false);
    // The record still enters the terminal state — otherwise a built record would remain that no sweep can ever handle.
    expect((await h.transactions.get(built.transactionId))?.status).toBe('abandoned');
  });
});
