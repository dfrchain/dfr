/**
* TX-07 / issue #22 gate 3: Solana devnet write-to-chain x **real PostgreSQL Store** x **production TransactionEngine**.
*
* The `010aae5` version of this file drove
* `DfrCore.buildTransaction / broadcastTransaction` -- that is the M1 **port path**
* (`packages/core/src/core.ts`: capability routing + Adapter calls, no persistence, no state machine).
* All of TX-07's persistence behavior (lease reserve, signing CAS, markConsumed before broadcast, B43 pre-send
* expiry checks, record state machine) exists only in the `TransactionEngine` (`packages/transaction/src/engine.ts`);
* the port path never enters the engine, so after build there are zero rows in `sequencing_leases`, and both scenarios fail at the first
* TX-07 assertion (fourth-round live-test record, see the EVIDENCE gate 3 completion appendix). The engine itself was not in doubt --
* its offline suite and the B45 evidence for gates 1-2 still stand. This version rewrites the scenarios following the Gateway's production assembly
* (`apps/gateway/src/main.ts` composition root):
*
* stores = the real PG Store from createPostgresTransactionRuntime (transaction / idempotency /
* nonce / sequencing / tracker), pointing at the throwaway database this file creates itself;
* chain = createCoreTransactionChainPort(core) (the Gateway's own port implementation,
* exported by `@dfr/gateway`, the same function as in main.ts);
* core = DfrCore (chain-access facade: Registry + Solana/EVM Adapter, devnet RPC).
* Note: the DfrCore constructor requires complete persistent
* transactionStores when milestone >= M1 (core.ts constructor check), so the facade and the engine share the same
* runtime.stores; this does not change which path owns what -- this file never calls Core's port-path
* methods (buildTransaction / broadcastTransaction); persistence happens only through the engine;
* engine = new TransactionEngine({ stores, chain}).
*
* Step mapping (old port path → this version's engine path):
*
* core.buildTransaction(req) → engine.build({ request, idempotencyKey})
* returns transactionId / sequencingToken /
* unsignedTransaction; the record is persisted as `built` and the lease is persisted as
* `reserved` (looked up directly by transactionId, no longer needing the old version's
* set-difference lease lookup).
* (no such step in the old version) → engine.simulate({ transactionId, unsignedTransaction})
* Precondition for engine broadcast: assertBroadcastable only accepts
* `simulated` (`built` broadcast directly would be
* DFR_TRANSACTION_REJECTED / simulation_required
* rejected). This is part of the engine's real flow, not a test convenience.
* core.broadcastTransaction(signed) → engine.broadcast({ transactionId, signed})
* Engine internal order: sign CAS persisted → markConsumed persisted →
* B43 pre-send expiry check (reads the token from the Store, not the client
* echo) → port broadcast → broadcast.accepted persisted (tx_hash).
* By the time a broadcast is accepted, consumed is already persisted -- the B45 ordering contract.
* core.observeConfirmation polls → engine.confirm({ chain, txHash, minFinality,
* timeoutMs}) (the engine confirmation path backed by the tracker lease,
* isomorphic to the Gateway), asserting reached.
* core.getTransaction finds nothing → raw JSON-RPC `getTransaction` looks it up directly by signature
* (without going through DFR code, so the evidence is more independent).
*
* Scenario 2 timing map: the engine requires simulation before broadcast, and simulation must happen while the blockhash is fresh (an expired
* blockhash simulation is rejected by the node with blockhash not found and the record moves to `reverted`, after which broadcast
* is unreachable), so the order is build → simulate (fresh) → wait for the chain height to pass the persisted token's
* lastValidBlockHeight → external signing → engine.broadcast. The wait happens between simulate and
* broadcast -- exactly the window B43 guards against (the signer being slower than the blockhash lifetime); the engine's pre-send
* check runs **after** markConsumed and **before** the port broadcast, so when it expires the lease is already consumed,
* the record lands in `failed` via broadcast.rejected, with zero network sends.
*
 * Scenario 1 confirm retry (a recorded adaptation after the fifth round's first run): in the first run the broadcast really landed on-chain and
 * finalized, but the engine.confirm right after it threw
 * DFR_TRANSACTION_NOT_FOUND and aborted because of RPC visibility lag (Core.observeConfirmation throws on empty observations;
 * ConfirmationTracker foreground trackUntil does not swallow that error and rethrows immediately, while the background
 * runBackground catches and retries). So the scenario retried the confirm call itself, only for that error code and within the total budget,
 * bridging the RPC visibility window; no assertion changed. That engine behavior is reported separately as a finding in
 * EVIDENCE gate 3, not papered over in this file as "fixed".
 *
 * F-2 follow-up (2026-11-05 ninth round): the owner ruled to fix F-2 --
 * ConfirmationTracker foreground trackUntil now treats
 * DFR_TRANSACTION_NOT_FOUND as "not yet visible on-chain" and keeps polling
 * until the deadline (tolerating only that error code; other errors still rethrow immediately), consistent with runBackground
 * semantics. The confirm retry bridge described above has been removed; scenario 1 is back to a single direct call to
 * engine.confirm (total budget still 120s), with the assertions unchanged.
 *
 * Scenario 1 confirm conclusion (fifth-round live-test finding, see the EVIDENCE gate 3 fifth-round appendix):
 * engine.confirm currently **cannot converge** for solana-devnet -- the registry declares only [processed, confirmed] as the
 * finality levels for that chain (chains.yaml: a deliberate declaration that devnet's
 * finalized and confirmed are indistinguishable), while Adapter observations take the strongest tier in
 * finalized → confirmed order, and evaluateFinality reverse-looks-up the commitment for
 * observed=finalized and rules it unsupported_commitment because levels do not include finalized,
 * so reached=false (regardless of required). More than ten seconds after the transaction lands on-chain and
 * becomes visible as finalized, confirm can never reach reached. This is not an assembly problem in this test
 * (a probe deterministically reproduced it for two finalized transactions at both the Core and Engine layers).
 * This file keeps the confirm assertion unchanged (reached must be true), so scenario 1 fails honestly until that defect
 * is fixed; the fix belongs to production code, outside this test's scope.
 *
 * F-1 follow-up (2026-11-05 sixth round): ADR-031 has been revised by owner ruling;
 * evaluateFinality now uses monotonic semantics (a reverse-looked-up commitment counts once it reaches/exceeds
 * required in order, no longer limited by the levels admission gate), and this file lands on main together with that fix.
 * Scenario 1's confirm assertion is unchanged, and is now expected to converge end to end
 * (reached=true); the paragraph above is kept as the record of the finding at the time.
 *
* Skipped by default. Requires **four** explicit enables (missing any one skips the whole file, zero network, zero persistence):
*
* DFR_RUN_SOLANA_WRITE=1 \
* DFR_SOLANA_KEYPAIR=/path/to/funded-devnet-id.json \
*./scripts/db-test.sh tests/integration/solana-devnet-postgres.test.ts
*
* (`db-test.sh` exports `DFR_TRANSACTION_*_DATABASE_URL` and manages the test containers;
* this file creates its own database on the server that DSN points to, and deletes it when done.)
*
* Signing is done **externally** (support/solana-signer uses a local test account to play the external signer);
* the server never touches private keys (ADR-007/009). Only non-sensitive evidence is recorded (txHash / finality).
* Running on devnet needs a separate testnet authorization from the repo owner -- this file being written does not mean it is authorized to run.
*/
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DfrCore } from '@dfr/core';
import { SolanaAdapter, base58Encode, fromBase64, splitSignatures } from '@dfr/adapter-solana';
import { EvmAdapter } from '@dfr/adapter-evm';
import { ChainRegistry } from '@dfr/registry';
import { TransactionEngine } from '@dfr/transaction';
import { createCoreTransactionChainPort } from '@dfr/gateway';
import type {
  AccountRef,
  ChainId,
  DecimalUint,
  TransactionRequest,
} from '@dfr/types';
import {
  createPostgresTransactionRuntime,
  loadMigrations,
  runMigrations,
} from '../../packages/storage-postgres/src/index.js';
import type { PostgresTransactionRuntime } from '../../packages/storage-postgres/src/index.js';
import { loadSolanaKeypair } from './support/solana-signer.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'packages', 'storage-postgres', 'migrations');

/**
* Load the driver from the storage-postgres package, which owns the pg dependency (same technique as m1-write-path):
* @dfr/tests deliberately does not depend on pg directly. The Client type is inferred from runMigrations' signature,
* guaranteeing it matches the client shape the migration runner requires, word for word.
*/
type PgClient = Parameters<typeof runMigrations>[0]['client'];
const { Client: PgClient } = createRequire(
  new URL('../../packages/storage-postgres/package.json', import.meta.url),
)('pg') as {
  Client: new (config: { connectionString: string }) => PgClient;
};

const WRITE_ENABLED =
  process.env['DFR_RUN_SOLANA_WRITE'] === '1' &&
  typeof process.env['DFR_SOLANA_KEYPAIR'] === 'string' &&
  process.env['DFR_SOLANA_KEYPAIR'].length > 0;
const ADMIN_DSN = process.env['DFR_TRANSACTION_MIGRATION_DATABASE_URL'];
const RUNTIME_DSN = process.env['DFR_TRANSACTION_DATABASE_URL'];
const DB_ENABLED =
  typeof ADMIN_DSN === 'string' &&
  ADMIN_DSN.length > 0 &&
  typeof RUNTIME_DSN === 'string' &&
  RUNTIME_DSN.length > 0;
const ENABLED = WRITE_ENABLED && DB_ENABLED;

const DEVNET = 'solana-devnet' as ChainId;
const RPC =
  process.env['DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL'] ?? 'https://api.devnet.solana.com';
const PRIVATE_DB = 'dfr_t_solana_pg_test';
const SCHEMA = 'transaction_data';

let admin: PgClient;
let inspector: PgClient;
let runtime: PostgresTransactionRuntime;

function runtimeDsnFor(database: string): string {
  return RUNTIME_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

function adminDsnFor(database: string): string {
  return ADMIN_DSN!.replace(/\/[^/]*$/u, `/${database}`);
}

function makeCore(): DfrCore {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: RPC,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://1rpc.io/sepolia',
    },
  });
  return new DfrCore({
    registry,
    adapters: [
      { id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) },
      { id: 'solana', version: '0.1.0', create: (chain) => new SolanaAdapter({ chain }) },
    ],
    milestone: 'M2',
    // DfrCore requires complete transactionStores when milestone >= M1 (constructor check,
    // core.ts), handing it the same persistent Store as the Gateway does; all of the scenario's
    // persistence assertions still happen only through the TransactionEngine (this file does not call Core's port path).
    transactionStores: runtime.stores,
  });
}

/**
* Build the engine following the Gateway's production assembly (apps/gateway/src/main.ts): real PG Store
* fully injected (including tracker -- the confirm path is fail-closed without it; including sequencing --
* the Solana path is fail-closed without it), with chain access going through the Gateway's own
* `createCoreTransactionChainPort` to Core/Adapter.
*/
function makeEngine(core: DfrCore): TransactionEngine {
  return new TransactionEngine({
    stores: {
      transaction: runtime.stores.transaction,
      idempotency: runtime.stores.idempotency,
      nonce: runtime.stores.nonce,
      ...(runtime.stores.sequencing !== undefined
        ? { sequencing: runtime.stores.sequencing }
        : {}),
      tracker: runtime.stores.tracker,
    },
    chain: createCoreTransactionChainPort(core),
  });
}

/** Engine request self-transferring 0 SOL: only verifies the chain and persistence contracts, moves no funds (only pays fees). */
function selfTransferRequest(from: string): TransactionRequest {
  const account: AccountRef = { chain: DEVNET, address: from };
  return {
    chain: DEVNET,
    from: account,
    to: account,
    value: { asset: { kind: 'native', chain: DEVNET }, amount: '0' as DecimalUint },
  };
}

/** Fill a real signature into the unsigned payload (with zero signature slots) using an external keypair. Same implementation as D02. */
function signUnsigned(payloadBase64: string, sign: (m: Uint8Array) => Uint8Array): string {
  const bytes = fromBase64(payloadBase64, 'payload');
  const { signatures, messageBytes } = splitSignatures(bytes);
  const sig = sign(messageBytes);
  const out = Buffer.alloc(1 + signatures.length * 64 + messageBytes.length);
  out[0] = signatures.length;
  signatures.forEach((slot, index) => {
    const value = index === 0 ? sig : slot;
    Buffer.from(value).copy(out, 1 + index * 64);
  });
  Buffer.from(messageBytes).copy(out, 1 + signatures.length * 64);
  return out.toString('base64');
}

interface LeaseRow {
  transaction_id: string;
  token_value: string;
  last_valid_block_height: string;
  status: string;
}

/** Under the engine path the transactionId is known, so look up this build's lease directly by primary key. */
async function leaseRow(transactionId: string): Promise<LeaseRow | undefined> {
  const { rows } = await inspector.query<LeaseRow>(
    `SELECT transaction_id, token_value,
last_valid_block_height::text AS last_valid_block_height, status
FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`,
    [transactionId],
  );
  return rows[0];
}

async function leaseStatus(transactionId: string): Promise<string | undefined> {
  const { rows } = await inspector.query<{ status: string }>(
    `SELECT status FROM ${SCHEMA}.sequencing_leases WHERE transaction_id = $1`,
    [transactionId],
  );
  return rows[0]?.status;
}

async function recordRow(
  transactionId: string,
): Promise<{ status: string; tx_hash: string | null; error_code: string | null } | undefined> {
  const { rows } = await inspector.query<{
    status: string;
    tx_hash: string | null;
    error_code: string | null;
  }>(
    `SELECT status, tx_hash, error_code FROM ${SCHEMA}.transactions WHERE id = $1`,
    [transactionId],
  );
  return rows[0];
}

async function currentBlockHeight(): Promise<bigint> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight', params: [] }),
  });
  const data = (await response.json()) as { result?: number };
  if (typeof data.result !== 'number') throw new Error('getBlockHeight did not return a numeric result');
  return BigInt(data.result);
}

/** Raw JSON-RPC transaction lookup by signature (without going through DFR code): not finding it is independent evidence of "never landed on-chain". */
async function rpcGetTransaction(signature: string): Promise<unknown> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        signature,
        { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ],
    }),
  });
  const data = (await response.json()) as { result?: unknown };
  return data.result ?? null;
}

beforeAll(async () => {
  if (!ENABLED) return;
  admin = new PgClient({ connectionString: ADMIN_DSN });
  await admin.connect();
  const { rows } = await admin.query<{ db: string }>('SELECT current_database() AS db');
  if (!/_test$/u.test(rows[0]!.db)) {
    throw new Error(`refusing to run on a non-test database "${rows[0]!.db}" (the database name must end with _test)`);
  }

  await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${PRIVATE_DB}`);

  const setup = new PgClient({ connectionString: adminDsnFor(PRIVATE_DB) });
  await setup.connect();
  await runMigrations({ client: setup, migrations: loadMigrations(migrationsDir) });
  await setup.end();

  runtime = await createPostgresTransactionRuntime({
    databaseUrl: runtimeDsnFor(PRIVATE_DB),
  });
  inspector = new PgClient({ connectionString: adminDsnFor(PRIVATE_DB) });
  await inspector.connect();
}, 120_000);

afterAll(async () => {
  if (!ENABLED) return;
  if (runtime) await runtime.close();
  if (inspector) await inspector.end();
  if (admin) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { rows } = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1`,
        [PRIVATE_DB],
      );
      if (rows[0]!.count === '0') break;
      await delay(10);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${PRIVATE_DB}`);
    await admin.end();
  }
}, 60_000);

describe.skipIf(!ENABLED)('Solana devnet × PostgreSQL Store × TransactionEngine (TX-07 / issue #22 gate 3)', () => {
  it('engine path: build persists a reserved lease bound to the blockhash → simulate → external signing → consumed persisted before broadcast → confirm converges', async () => {
    const engine = makeEngine(makeCore());
    const keypair = loadSolanaKeypair(process.env['DFR_SOLANA_KEYPAIR']!);
    const from = base58Encode(keypair.publicKeyBytes);
    try {
      const built = await engine.build({
        request: selfTransferRequest(from),
        idempotencyKey: 'issue22-gate3-engine-happy',
      });
      expect(built.status).toBe('built');
      expect(built.replayed).toBe(false);
      const txnId = built.transactionId;
      const blockhash = built.unsignedTransaction.meta.recentBlockhash;
      expect(blockhash).toBeTruthy();
      // The sequencing precondition returned by the engine must be the same as the payload's blockhash (ADR-033 injection contract).
      expect(built.sequencingToken).toEqual({
        kind: 'blockhash',
        value: blockhash,
        lastValidBlockHeight: expect.any(String),
      });

      // TX-07 evidence 1: the lease is persisted in real PG (looked up directly by transactionId), status=reserved,
      // and the token matches the payload's blockhash word for word (lease ↔ payload binding); the transaction record is persisted as built.
      const lease = await leaseRow(txnId);
      expect(lease).toBeDefined();
      expect(lease!.status).toBe('reserved');
      expect(lease!.token_value).toBe(blockhash);
      expect((await recordRow(txnId))?.status).toBe('built');

      // Engine broadcast precondition: simulate advances the record to simulated (a built record broadcast directly would be
      // rejected by assertBroadcastable with simulation_required).
      const simulated = await engine.simulate({
        transactionId: txnId,
        unsignedTransaction: built.unsignedTransaction,
      });
      expect(simulated.status).toBe('simulated');
      expect((await recordRow(txnId))?.status).toBe('simulated');

      const signedPayload = signUnsigned(built.unsignedTransaction.payload, keypair.sign);
      const txHash = base58Encode(splitSignatures(fromBase64(signedPayload, 'payload')).signatures[0]!);

      const broadcast = await engine.broadcast({
        transactionId: txnId,
        signed: {
          schemaVersion: '1',
          chain: DEVNET,
          unsigned: built.unsignedTransaction,
          signedPayload,
          expectedHash: txHash,
          signerRef: 'external:local-test-keypair',
        },
      });
      expect(broadcast.accepted).toBe(true);
      expect(broadcast.status).toBe('broadcast');
      expect(broadcast.txHash).toBe(txHash);

      // TX-07 evidence 2: by the time the broadcast is accepted, markConsumed is already persisted (the persistence order inside the engine:
      // sign CAS → markConsumed → pre-send check → port broadcast); the record advances to broadcast
      // with tx_hash persisted. A consumed lease cannot be reclaimed even if swept afterwards.
      expect(await leaseStatus(txnId)).toBe('consumed');
      const record = await recordRow(txnId);
      expect(record?.status).toBe('broadcast');
      expect(record?.tx_hash).toBe(txHash);

      // finality: go through the engine's confirm (the tracker-lease-backed confirmation path,
      // isomorphic to the Gateway), requiring at least confirmed and reached before the timeout. After the F-2 fix, foreground
      // trackUntil already tolerates DFR_TRANSACTION_NOT_FOUND within the post-broadcast visibility window
      // and polls until the deadline (see the "F-2 follow-up" section in the file header); here it is a single direct call, with the total budget
      // still 120s; the reached / finality assertions are unchanged.
      const confirmation = await engine.confirm({
        chain: DEVNET,
        txHash,
        minFinality: 'confirmed',
        timeoutMs: 120_000,
      });
      expect(confirmation).toBeDefined();
      expect(confirmation.reached).toBe(true);
      expect(['confirmed', 'finalized']).toContain(confirmation.finality);

      await runtime.stores.sequencing!.releaseExpiredOrphaned({ limit: 100 });
      expect(await leaseStatus(txnId)).toBe('consumed');

      // Only record non-sensitive evidence.
      console.log(
        `TX-07 devnet evidence: txHash=${txHash} finality=${confirmation.finality} lease=consumed record=broadcast`,
      );
    } finally {
      engine.close();
    }
  }, 300_000);

  it('engine path: broadcast after the blockhash expires: pre-send fail-closed, record lands in failed, payload never lands on-chain, consumed cannot be reclaimed', async () => {
    const engine = makeEngine(makeCore());
    const keypair = loadSolanaKeypair(process.env['DFR_SOLANA_KEYPAIR']!);
    const from = base58Encode(keypair.publicKeyBytes);
    try {
      const built = await engine.build({
        request: selfTransferRequest(from),
        idempotencyKey: 'issue22-gate3-engine-expiry',
      });
      const txnId = built.transactionId;
      const lease = await leaseRow(txnId);
      expect(lease).toBeDefined();
      expect(lease!.status).toBe('reserved');
      // The authoritative expiry line is the persisted token's lastValidBlockHeight, not the client echo.
      const lastValid = BigInt(lease!.last_valid_block_height);

      // Simulation must complete while the blockhash is fresh: engine broadcast only accepts simulated records;
      // simulating after expiry is rejected by the node with blockhash not found and pushes the record into reverted.
      const simulated = await engine.simulate({
        transactionId: txnId,
        unsignedTransaction: built.unsignedTransaction,
      });
      expect(simulated.status).toBe('simulated');

      // Wait for the chain height to pass lastValidBlockHeight (a devnet blockhash is valid for about 150 blocks).
      // The wait sits between simulate and broadcast -- exactly the window B43 guards against.
      const deadline = Date.now() + 420_000;
      for (; ;) {
        if (await currentBlockHeight() > lastValid) break;
        if (Date.now() > deadline) throw new Error('timed out waiting for the blockhash to expire (chain height did not pass lastValid)');
        await delay(5_000);
      }

      const signedPayload = signUnsigned(built.unsignedTransaction.payload, keypair.sign);
      const txHash = base58Encode(splitSignatures(fromBase64(signedPayload, 'payload')).signatures[0]!);

      // The B43 pre-send check must be fail-closed: error code DFR_BLOCKHASH_EXPIRED.
      // That check runs inside the engine after markConsumed and before the port broadcast, so this call
      // produces no network sends at all (the raw RPC lookup below finding nothing is the proof).
      await expect(
        engine.broadcast({
          transactionId: txnId,
          signed: {
            schemaVersion: '1',
            chain: DEVNET,
            unsigned: built.unsignedTransaction,
            signedPayload,
            expectedHash: txHash,
            signerRef: 'external:local-test-keypair',
          },
        }),
      ).rejects.toMatchObject({ code: 'DFR_BLOCKHASH_EXPIRED' });

      // Persistence facts: the signature is already in CAS and markConsumed has run (the lease is consumed --
      // this blockhash was indeed used by a signed transaction); the record lands in failed via broadcast.rejected
      // leaving the error code; a raw RPC lookup on-chain by signature must find nothing (it was never actually sent).
      expect(await leaseStatus(txnId)).toBe('consumed');
      const record = await recordRow(txnId);
      expect(record?.status).toBe('failed');
      expect(record?.error_code).toBe('DFR_BLOCKHASH_EXPIRED');
      expect(await rpcGetTransaction(txHash)).toBeNull();

      await runtime.stores.sequencing!.releaseExpiredOrphaned({ limit: 100 });
      expect(await leaseStatus(txnId)).toBe('consumed');

      console.log(
        `TX-07 devnet expiry evidence: txHash=${txHash} rejected=DFR_BLOCKHASH_EXPIRED lease=consumed record=failed`,
      );
    } finally {
      engine.close();
    }
  }, 600_000);
});
