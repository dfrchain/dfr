/**
 * M1 真实持久化写路径集成验收（DFR-M1-C00）。
 *
 * 与 `tests/integration/m1-storage.integration.test.ts`（A14，只直接测四个 Store）
 * 的区别：这里用**生产** `TransactionEngine` + 真实 PostgreSQL Store + 链端口替身，
 * 跑完整的 `build` 编排。B10 在准备这条路径时发现并实测复现：
 *
 *   Error: reserve: 交易 txn_… 不存在   （PostgresNonceStore.reserve）
 *
 * 根因是引擎顺序 `reserve → chain.build → create` 与 `nonce_leases.transaction_id`
 * 外键（要求交易行先存在）互相矛盾。本用例是该缺陷的回归闸门：
 * 修复前必须 RED，修复后必须 GREEN。
 *
 * 链上 RPC 用替身（离线、确定性）；数据库是真的，因为要验证的正是存储层顺序契约。
 * 需要 `DFR_TRANSACTION_DATABASE_URL`，因此只在 `pnpm test:db` 中运行。
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { TransactionEngine } from '@dfr/transaction';
import { createDfrError } from '@dfr/errors';
import type { ChainId, DecimalUint, TransactionRequest } from '@dfr/types';
import { createPostgresTransactionRuntime } from '../../packages/storage-postgres/src/index.js';

const DATABASE_URL = process.env['DFR_TRANSACTION_DATABASE_URL'];
const ENABLED = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;
const CHAIN = 'ethereum-sepolia' as ChainId;

type Runtime = Awaited<ReturnType<typeof createPostgresTransactionRuntime>>;
const opened: Runtime[] = [];

async function openRuntime(): Promise<Runtime> {
  const runtime = await createPostgresTransactionRuntime({ databaseUrl: DATABASE_URL! });
  opened.push(runtime);
  return runtime;
}

afterEach(async () => {
  while (opened.length > 0) {
    const runtime = opened.pop();
    if (runtime !== undefined) await runtime.close();
  }
});

/** 链端口替身：只回答 build 所需的三件事，绝不联网。 */
function stubChain() {
  return {
    getPendingNonce: async (): Promise<DecimalUint> => '7' as DecimalUint,
    build: async ({ request }: { request: TransactionRequest }): Promise<never | never> =>
      ({
        schemaVersion: '1',
        chain: request.chain,
        payload: '0x02f86b0180808080942222222222222222222222222222222222222280c0',
        meta: { encoding: 'hex', requiresNonce: request.nonce },
      }) as never,
    simulate: async () => ({ success: true, gasUsed: '21000' as DecimalUint }),
  };
}

describe.skipIf(!ENABLED)('M1 真实持久化写路径（DFR-M1-C00）', () => {
  it('B37: two real PostgreSQL pools — concurrent sign wins manual abandon CAS without nonce release', async () => {
    const first = await openRuntime();
    const second = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const transactionId = `txn_b37_signed_${suffix}` as never;
    const account = { chain: CHAIN, address: `0x${suffix.padEnd(40, '0').slice(0, 40)}` };
    const lease = await first.stores.nonce.reserve({
      chain: CHAIN, account, transactionId, chainPendingNonce: '7' as DecimalUint, leaseTtlMs: 120_000,
    });
    expect(lease.kind).toBe('reserved');
    await first.stores.transaction.create({
      record: {
        transactionId, projectId: 'default', chain: CHAIN, requestFingerprint: 'f'.repeat(64),
        status: 'simulated', stateVersion: '0' as DecimalUint, from: account,
        nonce: lease.lease.nonce, sequencingRef: { kind: 'nonce', value: lease.lease.nonce },
        unsignedPayload: '0x02f8', payloadEncoding: 'hex',
        createdAt: new Date().toISOString() as never,
        updatedAt: new Date().toISOString() as never,
      },
    });
    let releaseCalls = 0;
    let injected = false;
    const primaryStore = first.stores.transaction;
    const transaction = {
      create: primaryStore.create.bind(primaryStore),
      get: async (id: typeof transactionId) => {
        const stale = await primaryStore.get(id);
        if (!injected && stale?.transactionId === transactionId) {
          injected = true;
          const moved = await second.stores.transaction.transition({
            transactionId, expectedStatus: 'simulated', expectedVersion: stale.stateVersion,
            toStatus: 'signed', reason: 'sign',
          });
          expect(moved.kind).toBe('applied');
        }
        return stale;
      },
      getByHash: primaryStore.getByHash.bind(primaryStore),
      transition: primaryStore.transition.bind(primaryStore),
      listRecoverable: primaryStore.listRecoverable.bind(primaryStore),
    };
    const originalNonce = first.stores.nonce;
    const nonce = {
      reserve: originalNonce.reserve.bind(originalNonce),
      releaseIfSafe: async (ref: Parameters<typeof originalNonce.releaseIfSafe>[0]) => {
        releaseCalls += 1;
        return originalNonce.releaseIfSafe(ref);
      },
      markBroadcast: originalNonce.markBroadcast.bind(originalNonce),
      markConsumed: originalNonce.markConsumed.bind(originalNonce),
      releaseExpiredOrphaned: originalNonce.releaseExpiredOrphaned.bind(originalNonce),
    };
    const engine = new TransactionEngine({
      stores: { transaction, idempotency: first.stores.idempotency, nonce },
      chain: stubChain() as never,
    });
    try {
      await expect(engine.abandon({ transactionId })).rejects.toBeDefined();
      expect(releaseCalls).toBe(0);
      expect((await second.stores.transaction.get(transactionId))?.status).toBe('signed');
      const same = await second.stores.nonce.reserve({
        chain: CHAIN, account, transactionId,
        chainPendingNonce: '7' as DecimalUint, leaseTtlMs: 120_000,
      });
      expect(same.kind).toBe('reused');
      expect(same.lease.nonce).toBe('7');
    } finally {
      engine.close();
    }
  });

  it('TX-02: one RPC rejects a signed hash; real PostgreSQL keeps unknown and refuses nonce release', async () => {
    const first = await openRuntime();
    const second = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const transactionId = `txn_tx02_rejected_${suffix}` as never;
    const expectedHash = `0x${suffix.padEnd(64, 'e')}`;
    const account = { chain: CHAIN, address: `0x${suffix.padEnd(40, '0').slice(0, 40)}` };
    const payload = '0x02f8';
    const lease = await first.stores.nonce.reserve({
      chain: CHAIN, account, transactionId,
      chainPendingNonce: '7' as DecimalUint, leaseTtlMs: 120_000,
    });
    expect(lease.kind).toBe('reserved');
    await first.stores.transaction.create({
      record: {
        transactionId, projectId: 'default', chain: CHAIN,
        requestFingerprint: 'f'.repeat(64),
        status: 'simulated', stateVersion: '0' as DecimalUint,
        from: account, nonce: lease.lease.nonce,
        sequencingRef: { kind: 'nonce', value: lease.lease.nonce },
        unsignedPayload: payload, payloadEncoding: 'hex',
        createdAt: new Date().toISOString() as never,
        updatedAt: new Date().toISOString() as never,
      },
    });
    const network = {
      ...stubChain(),
      broadcast: async () => {
        throw createDfrError('DFR_INSUFFICIENT_FUNDS', {
          requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
          chain: CHAIN, message: 'one peer refused the signed hash',
        });
      },
      observe: async () => ({ kind: 'absent' as const }),
    };
    const engine = new TransactionEngine({ stores: first.stores, chain: network as never });
    try {
      await expect(engine.broadcast({
        transactionId,
        signed: {
          schemaVersion: '1', chain: CHAIN,
          unsigned: { schemaVersion: '1', chain: CHAIN, payload, meta: {} },
          signedPayload: '0x02signed', expectedHash,
        } as never,
      })).rejects.toMatchObject({ code: 'DFR_INSUFFICIENT_FUNDS' });

      const persisted = await second.stores.transaction.get(transactionId);
      expect(persisted?.status).toBe('unknown');
      expect(persisted?.expectedHash).toBe(expectedHash);
      const refused = await second.stores.nonce.releaseIfSafe({
        chain: CHAIN, account, nonce: lease.lease.nonce, transactionId,
      });
      expect(refused.kind).toBe('forbidden');
      const old = await second.stores.nonce.reserve({
        chain: CHAIN, account, transactionId,
        chainPendingNonce: '7' as DecimalUint, leaseTtlMs: 120_000,
      });
      expect(old.kind).toBe('reused');
      expect(old.lease.nonce).toBe(lease.lease.nonce);
    } finally {
      engine.close();
    }
  });

  it('B37: manual abandon commits first, then safely releases/reuses an unsigned nonce on real PostgreSQL', async () => {
    const first = await openRuntime();
    const second = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const account = { chain: CHAIN, address: `0x${suffix.padEnd(40, '0').slice(0, 40)}` };
    const request: TransactionRequest = {
      chain: CHAIN,
      from: account,
      to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
      value: { asset: { kind: 'native', chain: CHAIN }, amount: '17' as DecimalUint },
    };
    const firstEngine = new TransactionEngine({
      stores: { transaction: first.stores.transaction, idempotency: first.stores.idempotency, nonce: first.stores.nonce },
      chain: stubChain() as never,
    });
    const secondEngine = new TransactionEngine({
      stores: { transaction: second.stores.transaction, idempotency: second.stores.idempotency, nonce: second.stores.nonce },
      chain: stubChain() as never,
    });
    try {
      const built = await firstEngine.build({ request });
      const abandoned = await firstEngine.abandon({ transactionId: built.transactionId });
      expect(abandoned.leaseReleased).toBe(true);
      expect((await second.stores.transaction.get(built.transactionId))?.status).toBe('abandoned');
      const after = await secondEngine.build({ request });
      expect(after.nonce).toBe(built.nonce);
      expect(after.transactionId).not.toBe(built.transactionId);
    } finally {
      firstEngine.close();
      secondEngine.close();
    }
  });

  it('engine.build 在真实 Postgres 上成功落库 built，且 nonce 与租约一致', async () => {
    const runtime = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const request: TransactionRequest = {
      chain: CHAIN,
      from: { chain: CHAIN, address: `0x${suffix.padEnd(40, '0').slice(0, 40)}` },
      to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
      value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' as DecimalUint },
    };

    const engine = new TransactionEngine({
      stores: {
        transaction: runtime.stores.transaction,
        idempotency: runtime.stores.idempotency,
        nonce: runtime.stores.nonce,
      },
      chain: stubChain() as never,
    });

    const built = await engine.build({
      request,
      idempotencyKey: `c00-${suffix}`,
      projectId: 'default',
    });

    expect(built.nonce).toBe('7');
    expect(built.unsignedTransaction.payload.startsWith('0x02')).toBe(true);

    const record = await runtime.stores.transaction.get(built.transactionId);
    expect(record?.status).toBe('built');
    expect(record?.nonce).toBe('7');

    // 租约必须与记录同账户同 nonce —— 外键被移除后，这条不变式由 create 的
    // fail-closed 校验 + 本断言共同守住。
    const lease = await runtime.stores.nonce.reserve({
      chain: CHAIN,
      account: request.from,
      transactionId: built.transactionId,
      chainPendingNonce: '7' as DecimalUint,
      leaseTtlMs: 60_000,
    });
    expect(lease.kind).toBe('reused');
  });

  it.each(['accepted', 'timeout'] as const)(
    'B27 两 Engine + 两 PostgreSQL Pool 同时重播 dropped（Adapter %s），只发出一次',
    async (outcome) => {
      const first = await openRuntime();
      const second = await openRuntime();
      const suffix = randomUUID().replaceAll('-', '');
      const transactionId = `txn_b27_replay_${suffix}` as never;
      const expectedHash = `0x${suffix.padEnd(64, 'a')}`;
      const unsignedPayload = '0x02f8';
      await first.stores.transaction.create({
        record: {
          transactionId,
          projectId: 'default',
          chain: CHAIN,
          requestFingerprint: 'f'.repeat(64),
          status: 'dropped',
          stateVersion: '0' as DecimalUint,
          from: { chain: CHAIN, address: `0x${suffix.padEnd(40, '0').slice(0, 40)}` },
          unsignedPayload,
          expectedHash,
          createdAt: new Date().toISOString() as never,
          updatedAt: new Date().toISOString() as never,
        },
      });

      let broadcastCalls = 0;
      const fakeAdapter = {
        broadcast: async () => {
          broadcastCalls += 1;
          if (outcome === 'timeout') throw new Error('B27 simulated network timeout');
          return {
            accepted: true,
            ref: { kind: 'hash', hash: expectedHash },
            observedAt: new Date().toISOString(),
          };
        },
      };
      const makeEngine = (runtime: Runtime) => new TransactionEngine({
        stores: {
          transaction: runtime.stores.transaction,
          idempotency: runtime.stores.idempotency,
          nonce: runtime.stores.nonce,
        },
        chain: fakeAdapter as never,
      });
      const engines = [makeEngine(first), makeEngine(second)];
      const attempt = (i: number) => engines[i % 2]!.broadcast({
        transactionId,
        signed: {
          schemaVersion: '1',
          chain: CHAIN,
          unsigned: { schemaVersion: '1', chain: CHAIN, payload: unsignedPayload, meta: {} },
          signedPayload: '0x02f8signed',
          expectedHash,
        } as never,
        options: { rebroadcast: true } as never,
      });

      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => attempt(i)));
      expect(broadcastCalls, '同一已签名交易不能向链端口广播两次').toBe(1);
      if (outcome === 'accepted') {
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      } else {
        expect(results.every((r) => r.status === 'rejected')).toBe(true);
        expect(results.some((r) => r.status === 'rejected'
          && r.reason instanceof Error
          && r.reason.message === 'B27 simulated network timeout')).toBe(true);
      }
      // TX-04: a timed-out rebroadcast is UNKNOWN, not a confirmed accepted
      // broadcast; successful rebroadcast still persists 'broadcast'.
      expect((await second.stores.transaction.get(transactionId))?.status)
        .toBe(outcome === 'timeout' ? 'unknown' : 'broadcast');
      expect((await first.stores.transaction.get(transactionId))?.expectedHash).toBe(expectedHash);
      await expect(attempt(0)).rejects.toMatchObject({ code: 'DFR_TRANSACTION_REJECTED' });
      expect(broadcastCalls, '并发完成后不得自动或显式重复广播').toBe(1);
      engines.forEach((engine) => engine.close());
    },
  );

  it.each(['active', 'expired'] as const)(
    'TX-05/B38: expired idempotency owner cannot create a second transaction (old nonce lease %s)',
    async (nonceLeaseMode) => {
      const first = await openRuntime();
      const second = await openRuntime();
      const suffix = randomUUID().replaceAll('-', '');
      const key = `b36-idem-${suffix}`;
      const request: TransactionRequest = {
        chain: CHAIN,
        from: { chain: CHAIN, address: `0x${suffix.padEnd(40, '0').slice(0, 40)}` },
        to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
        value: { asset: { kind: 'native', chain: CHAIN }, amount: '99' as DecimalUint },
      };
      let allowSlow!: () => void;
      let beganSlow!: () => void;
      const entered = new Promise<void>((resolve) => { beganSlow = resolve; });
      const resume = new Promise<void>((resolve) => { allowSlow = resolve; });
      const slowChain = {
        ...stubChain(),
        build: async ({ request: chainRequest }: { request: TransactionRequest }) => {
          beganSlow();
          await resume;
          return (stubChain().build({ request: chainRequest }) as Promise<never>);
        },
      };
      const engineOne = new TransactionEngine({
        stores: first.stores, chain: slowChain as never,
        newTransactionId: () => `txn_tx05_old_${suffix}` as never,
      });
      const engineTwo = new TransactionEngine({
        stores: second.stores, chain: stubChain() as never,
        newTransactionId: () => `txn_tx05_new_${suffix}` as never,
      });
      // Load the driver from the storage package that owns the pg dependency;
      // the integration-tests package deliberately does not depend on pg.
      const { Pool: SqlPool } = createRequire(
        new URL('../../packages/storage-postgres/package.json', import.meta.url),
      )('pg') as { Pool: new (config: object) => {
        query(sql: string, params?: readonly unknown[]): Promise<{ rows: { id: string }[] }>;
        end(): Promise<void>;
      } };
      const inspector = new SqlPool({ connectionString: DATABASE_URL!, max: 2 });
      try {
        const oldAttempt = engineOne.build({ request, idempotencyKey: key });
        const oldSettled = oldAttempt.then(
          (value) => ({ kind: 'fulfilled' as const, value }),
          (reason: unknown) => ({ kind: 'rejected' as const, reason }),
        );
        await entered; // Old executor has reserved nonce and is still building.
        await inspector.query(
          `UPDATE transaction_data.idempotency_records
             SET lease_expires_at=clock_timestamp() - INTERVAL '1 second'
           WHERE project_id='default' AND chain_id=$1 AND key=$2`,
          [CHAIN, key],
        );
        if (nonceLeaseMode === 'expired') {
          // Old Engine is blocked inside its Adapter after reserving nonce 7.
          // A takeover before the periodic orphan sweep must reclaim 7 inline
          // once the old reservation TTL has genuinely expired.
          await inspector.query(
            `UPDATE transaction_data.nonce_leases
                SET expires_at=clock_timestamp() - INTERVAL '1 second'
              WHERE transaction_id=$1`,
            [`txn_tx05_old_${suffix}`],
          );
        }
        const next = await engineTwo.build({ request, idempotencyKey: key });
        expect(next.nonce).toBe(nonceLeaseMode === 'expired' ? '7' : '8');
        allowSlow();
        const old = await oldSettled;
        expect(old.kind, 'old owner must not create another transaction after takeover').toBe('rejected');
        const { rows } = await inspector.query(
          `SELECT id FROM transaction_data.transactions WHERE id IN ($1,$2)`,
          [`txn_tx05_old_${suffix}`, `txn_tx05_new_${suffix}`],
        );
        expect(rows.map((row) => row.id)).toEqual([next.transactionId]);
        const replay = await engineOne.build({ request, idempotencyKey: key });
        expect(replay.transactionId).toBe(next.transactionId);
        expect(replay.replayed).toBe(true);
      } finally {
        allowSlow?.();
        await inspector.end();
        engineOne.close();
        engineTwo.close();
      }
    },
  );

  it('TX-05: a committed transaction pointer is replayed even before original owner completes idempotency', async () => {
    const runtime = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const key = `b36-half-committed-${suffix}`;
    const request: TransactionRequest = {
      chain: CHAIN,
      from: { chain: CHAIN, address: `0x${suffix.padEnd(40, '1').slice(0, 40)}` },
      to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
      value: { asset: { kind: 'native', chain: CHAIN }, amount: '11' as DecimalUint },
    };
    const fingerprint = (await import('@dfr/transaction')).fingerprintBuildRequest(request);
    const scope = { projectId: 'default', chain: CHAIN, key };
    const claim = await runtime.stores.idempotency.begin({
      scope, fingerprint, ownerToken: 'owner-A', leaseTtlMs: 120_000,
    });
    expect(claim.kind).toBe('acquired');
    const transactionId = `txn_tx05_half_${suffix}` as never;
    const nonce = await runtime.stores.nonce.reserve({
      chain: CHAIN, account: request.from, transactionId,
      chainPendingNonce: '7' as DecimalUint, leaseTtlMs: 120_000,
    });
    expect(nonce.kind).toBe('reserved');
    const created = await runtime.stores.transaction.create({
      record: {
        transactionId, projectId: 'default', chain: CHAIN,
        requestFingerprint: fingerprint, status: 'built' as const, stateVersion: '0' as DecimalUint,
        from: request.from, nonce: nonce.lease.nonce,
        sequencingRef: { kind: 'nonce', value: nonce.lease.nonce },
        unsignedPayload: '0x02f8', payloadEncoding: 'hex',
        createdAt: new Date().toISOString() as never,
        updatedAt: new Date().toISOString() as never,
      },
      idempotencyClaim: { scope, ownerToken: 'owner-A' },
    });
    expect(created.kind).toBe('created');
    const recovered = await runtime.stores.idempotency.begin({
      scope, fingerprint, ownerToken: 'owner-B', leaseTtlMs: 120_000,
    });
    expect(recovered.kind).toBe('replayed');
    if (recovered.kind === 'replayed') expect(recovered.record.transactionId).toBe(transactionId);
    const orphanOld = await runtime.stores.idempotency.complete({
      scope, ownerToken: 'owner-A', statusCode: 201, transactionId,
    });
    expect(orphanOld.kind).toBe('lost_ownership');
  });

  it('TX-05: forged or expired idempotency owners cannot insert a transaction or bind a pointer', async () => {
    const runtime = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const scope = { projectId: 'default', chain: CHAIN, key: `b36-forged-${suffix}` };
    const request: TransactionRequest = {
      chain: CHAIN,
      from: { chain: CHAIN, address: `0x${suffix.padEnd(40, 'b').slice(0, 40)}` },
      to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
      value: { asset: { kind: 'native', chain: CHAIN }, amount: '33' as DecimalUint },
    };
    const fingerprint = (await import('@dfr/transaction')).fingerprintBuildRequest(request);
    await runtime.stores.idempotency.begin({
      scope, fingerprint, ownerToken: 'real-owner', leaseTtlMs: 60000,
    });
    const transactionId = `txn_tx05_fake_${suffix}` as never;
    const lease = await runtime.stores.nonce.reserve({
      chain: CHAIN, account: request.from, transactionId,
      chainPendingNonce: '7' as DecimalUint, leaseTtlMs: 60000,
    });
    expect(lease.kind).toBe('reserved');
    const record = {
      transactionId, projectId: 'default', chain: CHAIN,
      requestFingerprint: fingerprint, status: 'built' as const, stateVersion: '0' as DecimalUint,
      from: request.from, nonce: lease.lease.nonce,
      sequencingRef: { kind: 'nonce' as const, value: lease.lease.nonce },
      unsignedPayload: '0x02f8', payloadEncoding: 'hex' as const,
      createdAt: new Date().toISOString() as never,
      updatedAt: new Date().toISOString() as never,
    };
    await expect(runtime.stores.transaction.create({
      record, idempotencyClaim: { scope, ownerToken: 'forged-owner' },
    })).rejects.toThrow(/idempotency lease/u);
    await expect(runtime.stores.transaction.create({
      record: { ...record, requestFingerprint: '0'.repeat(64) },
      idempotencyClaim: { scope, ownerToken: 'real-owner' },
    })).rejects.toThrow(/idempotency lease/u);
    const { Pool: SqlPool } = createRequire(
      new URL('../../packages/storage-postgres/package.json', import.meta.url),
    )('pg') as { Pool: new (config: object) => {
      query(sql: string, params?: readonly unknown[]): Promise<{ rows: { id: string }[] }>;
      end(): Promise<void>;
    } };
    const inspector = new SqlPool({ connectionString: DATABASE_URL!, max: 1 });
    try {
      await inspector.query(
        `UPDATE transaction_data.idempotency_records
           SET lease_expires_at=clock_timestamp() - INTERVAL '1 second'
         WHERE project_id=$1 AND chain_id=$2 AND key=$3`,
        [scope.projectId, scope.chain, scope.key],
      );
      await expect(runtime.stores.transaction.create({
        record, idempotencyClaim: { scope, ownerToken: 'real-owner' },
      })).rejects.toThrow(/idempotency lease/u);
    } finally {
      await inspector.end();
    }
    expect(await runtime.stores.transaction.get(transactionId)).toBeNull();
    expect((await runtime.stores.idempotency.get(scope))?.transactionId).toBeUndefined();
  });

  it('幂等重放不推进 nonce 水位（同 key 返回同一 transactionId）', async () => {
    const runtime = await openRuntime();
    const suffix = randomUUID().replaceAll('-', '');
    const request: TransactionRequest = {
      chain: CHAIN,
      from: { chain: CHAIN, address: `0x${suffix.padEnd(40, '1').slice(0, 40)}` },
      to: { chain: CHAIN, address: '0x2222222222222222222222222222222222222222' },
      value: { asset: { kind: 'native', chain: CHAIN }, amount: '1000' as DecimalUint },
    };
    const engine = new TransactionEngine({
      stores: {
        transaction: runtime.stores.transaction,
        idempotency: runtime.stores.idempotency,
        nonce: runtime.stores.nonce,
      },
      chain: stubChain() as never,
    });

    const first = await engine.build({ request, idempotencyKey: `c00-r-${suffix}` });
    const replay = await engine.build({ request, idempotencyKey: `c00-r-${suffix}` });
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.nonce).toBe(first.nonce);
  });
});
