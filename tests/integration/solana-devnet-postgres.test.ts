/**
* TX-07 / issue #22 门禁 3：Solana devnet 写链 × **真实 PostgreSQL Store** × **生产 TransactionEngine**。
*
* 本文件的 `010aae5` 版本驱动的是
* `DfrCore.buildTransaction / broadcastTransaction`——那是 M1 **端口路径**
* （`packages/core/src/core.ts`：Capability 路由 + Adapter 调用，不落库、不经状态机）。
* TX-07 的全部持久化行为（租约 reserve、签名 CAS、markConsumed 先于广播、B43 预发送
* 过期检查、记录状态机）只存在于 `TransactionEngine`（`packages/transaction/src/engine.ts`）；
* 端口路径根本不进入引擎，build 之后 `sequencing_leases` 零行落库，两个场景都在第一个
* TX-07 断言处失败（第四轮实测记录，见 EVIDENCE 门禁 3 完成附录）。引擎本身未被质疑——
* 其离线套件与门禁 1–2 的 B45 证据仍然成立。本版按 Gateway 的生产装配
* （`apps/gateway/src/main.ts` 的 composition root）重写场景：
*
* stores = createPostgresTransactionRuntime 的真实 PG Store（transaction / idempotency /
* nonce / sequencing / tracker），指向本文件自建的 throwaway 数据库；
* chain = createCoreTransactionChainPort(core)（Gateway 自己的端口实现，
* 由 `@dfr/gateway` 导出，与 main.ts 同一函数）；
* core = DfrCore（链访问门面：Registry + Solana/EVM Adapter，devnet RPC）。
* 注意：DfrCore 构造函数在 milestone ≥ M1 时强制要求完整的持久化
* transactionStores（core.ts 构造校验），因此门面与引擎共享同一份
* runtime.stores；这不改变路径归属——本文件从不调用 Core 的端口路径
* 方法（buildTransaction / broadcastTransaction），落库只经引擎发生；
* engine = new TransactionEngine({ stores, chain})。
*
* 步骤映射（旧端口路径 → 本版引擎路径）：
*
* core.buildTransaction(req) → engine.build({ request, idempotencyKey})
* 返回 transactionId / sequencingToken /
* unsignedTransaction；记录落库 `built`、租约落库
* `reserved`（按 transactionId 直查，不再需要旧版
* 的集合差定位租约）。
* （旧版无此步） → engine.simulate({ transactionId, unsignedTransaction})
* 引擎广播的前置条件：assertBroadcastable 只接受
* `simulated`（`built` 直广播会被
* DFR_TRANSACTION_REJECTED / simulation_required
* 拒绝）。这是引擎真实流程的一部分，不是测试便利。
* core.broadcastTransaction(signed) → engine.broadcast({ transactionId, signed})
* 引擎内部顺序：sign CAS 落库 → markConsumed 落库 →
* B43 预发送过期检查（读 Store 里的 token，不读客户端
* 回显）→ 端口广播 → broadcast.accepted 落库（tx_hash）。
* 广播被接受时 consumed 早已落库——B45 的顺序契约。
* core.observeConfirmation 轮询 → engine.confirm({ chain, txHash, minFinality,
* timeoutMs})（tracker lease 支撑的引擎确认路径，
* 与 Gateway 同构），断言 reached。
* core.getTransaction 查无此笔 → 原始 JSON-RPC `getTransaction` 按签名直查
* （不经 DFR 代码，证据独立性更强）。
*
* 场景 2 的时序映射：引擎要求先模拟才可广播，而模拟必须趁 blockhash 新鲜（过期
* blockhash 的模拟会被节点以 blockhash not found 拒绝、记录转 `reverted` 后广播
* 不可达），因此顺序是 build → simulate（新鲜）→ 等链高越过落库 token 的
* lastValidBlockHeight → 外部签名 → engine.broadcast。等待发生在 simulate 与
* broadcast 之间，正是 B43 要防的窗口（签名方慢于 blockhash 有效期）；引擎的预发送
* 检查在 markConsumed **之后**、端口广播**之前**执行，所以过期时租约已 consumed、
* 记录经 broadcast.rejected 落 `failed`，且零网络发送。
*
 * 场景 1 的 confirm 重试（第五轮首跑后的记录性适配）：首跑中广播真实落链并
 * finalized，但紧随其后的 engine.confirm 因 RPC 可见性滞后抛
 * DFR_TRANSACTION_NOT_FOUND 而中止（Core.observeConfirmation 对空观测抛错；
 * ConfirmationTracker 前台 trackUntil 不吞该错误、立即上抛，后台
 * runBackground 则 catch 后重试）。场景因此只对该错误码、在总预算内重试
 * confirm 调用本身，桥接 RPC 可见性窗口；任何断言均未改变。该引擎行为在
 * EVIDENCE 门禁 3 中作为发现项单独报告，不在本文件里被掩盖成"已修复"。
 *
 * F-2 后续（2026-11-05 第九轮）：所有者裁决修复 F-2——
 * ConfirmationTracker 前台 trackUntil 现对
 * DFR_TRANSACTION_NOT_FOUND 按「链上尚不可见」处理并继续轮询
 * 至截止（仅容忍该错误码，其余错误仍立即上抛），与 runBackground
 * 语义一致。上文所述 confirm 重试桥接已移除，场景 1 恢复为对
 * engine.confirm 的单次直接调用（总预算 120s 不变），断言不变。
 *
 * 场景 1 的 confirm 结论（第五轮实测发现，详见 EVIDENCE 门禁 3 第五轮附录）：
 * engine.confirm 对 solana-devnet 当前**无法收敛**——registry 对该链的
 * finality levels 只声明 [processed, confirmed]（chains.yaml：devnet 的
 * finalized 与 confirmed 不可区分的刻意声明），而 Adapter 观测按
 * finalized → confirmed 顺序取最强档，evaluateFinality 对
 * observed=finalized 做 commitment 反查后因 levels 不含 finalized 判
 * unsupported_commitment、reached=false（与 required 无关）。交易落链十余秒
 * 进入 finalized 可见后，confirm 永远达不到 reached。这不是本测试的装配
 * 问题（探针已对两笔 finalized 交易在 Core 与 Engine 两层确定性复现）。
 * 本文件保持 confirm 断言不变（reached 必须为 true），让场景 1 在该缺陷
 * 修复前如实失败；修复属生产代码，不在本测试的边界内。
 *
 * F-1 后续（2026-11-05 第六轮）：ADR-031 已经所有者裁决修订，
 * evaluateFinality 改为单调语义（观测反查的 commitment 按序达到/超过
 * required 即达标，不再受 levels 准入闸门限制），本文件与该修复一并
 * 落地 main。场景 1 的 confirm 断言不变，现预期端到端收敛
 * （reached=true）；上段保留为发现当时的记录。
 *
* 默认跳过。需要**四重**显式开启（缺一即整文件 skip，零网络、零落库）：
*
* DFR_RUN_SOLANA_WRITE=1 \
* DFR_SOLANA_KEYPAIR=/path/to/funded-devnet-id.json \
*./scripts/db-test.sh tests/integration/solana-devnet-postgres.test.ts
*
* （`db-test.sh` 负责导出 `DFR_TRANSACTION_*_DATABASE_URL` 并管理测试容器；
* 本文件在该 DSN 指向的服务器上自建独立数据库，用完即删。）
*
* 签名由**外部**完成（support/solana-signer 用本地测试账户扮演外部签名者）；
* 服务端从不接触私钥（ADR-007/009）。只记录非敏感证据（txHash / finality）。
* devnet 执行需要仓库所有者单独的测试网授权——本文件被写好不等于被授权运行。
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
* 从拥有 pg 依赖的 storage-postgres 包加载驱动（与 m1-write-path 同一手法）：
* @dfr/tests 刻意不直接依赖 pg。Client 的类型从 runMigrations 的签名反推，
* 保证与迁移运行器要求的客户端形状逐字一致。
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
    // DfrCore 在 milestone ≥ M1 时强制要求完整 transactionStores（构造校验，
    // core.ts），与 Gateway 同样地把同一份持久化 Store 交给它；场景的全部
    // 落库断言仍只经 TransactionEngine 发生（本文件不调用 Core 端口路径）。
    transactionStores: runtime.stores,
  });
}

/**
* 按 Gateway 生产装配（apps/gateway/src/main.ts）构造引擎：真实 PG Store
* 全量注入（含 tracker——confirm 路径缺它 fail-closed；含 sequencing——
* Solana 路径缺它 fail-closed），链访问经 Gateway 自己的
* `createCoreTransactionChainPort` 接到 Core/Adapter。
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

/** 自转 0 SOL 的引擎请求：只验证链路与落库契约，不动资金（仅付手续费）。 */
function selfTransferRequest(from: string): TransactionRequest {
  const account: AccountRef = { chain: DEVNET, address: from };
  return {
    chain: DEVNET,
    from: account,
    to: account,
    value: { asset: { kind: 'native', chain: DEVNET }, amount: '0' as DecimalUint },
  };
}

/** 用外部 keypair 给未签名载荷（带零签名槽位）填写真实签名。与 D02 同一实现。 */
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

/** 引擎路径下 transactionId 已知，按主键直查本次 build 的那一条租约。 */
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
  if (typeof data.result !== 'number') throw new Error('getBlockHeight 未返回数值结果');
  return BigInt(data.result);
}

/** 原始 JSON-RPC 按签名查交易（不经 DFR 代码）：查无此笔是"从未上链"的独立证据。 */
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
    throw new Error(`拒绝在非测试库 "${rows[0]!.db}" 上执行（库名必须以 _test 结尾）`);
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

describe.skipIf(!ENABLED)('Solana devnet × PostgreSQL Store × TransactionEngine（TX-07 / issue #22 门禁 3）', () => {
  it('引擎路径：build 落 reserved 租约并绑定 blockhash → simulate → 外部签名 → consumed 先于广播落库 → confirm 收敛', async () => {
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
      // 引擎返回的排序前提与载荷 blockhash 必须是同一个（ADR-033 注入契约）。
      expect(built.sequencingToken).toEqual({
        kind: 'blockhash',
        value: blockhash,
        lastValidBlockHeight: expect.any(String),
      });

      // TX-07 证据 1：租约已落真实 PG（按 transactionId 直查），status=reserved，
      // 且 token 与载荷的 blockhash 逐字一致（租约 ↔ 载荷绑定）；交易记录已落库为 built。
      const lease = await leaseRow(txnId);
      expect(lease).toBeDefined();
      expect(lease!.status).toBe('reserved');
      expect(lease!.token_value).toBe(blockhash);
      expect((await recordRow(txnId))?.status).toBe('built');

      // 引擎广播前置：simulate 把记录推进到 simulated（built 直广播会被
      // assertBroadcastable 以 simulation_required 拒绝）。
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

      // TX-07 证据 2：广播被接受时，markConsumed 早已落库（引擎内的持久化顺序
      // sign CAS → markConsumed → 预发送检查 → 端口广播）；记录推进 broadcast
      // 且 tx_hash 落库。consumed 租约随后被 sweep 也不可回收。
      expect(await leaseStatus(txnId)).toBe('consumed');
      const record = await recordRow(txnId);
      expect(record?.status).toBe('broadcast');
      expect(record?.tx_hash).toBe(txHash);

      // finality：走引擎的 confirm（tracker lease 支撑的确认路径，与 Gateway
      // 同构），要求至少 confirmed 并在超时前 reached。F-2 修复后前台
      // trackUntil 已容忍广播后可见性窗口内的 DFR_TRANSACTION_NOT_FOUND
      // 并轮询至截止（见文件头"F-2 后续"段），此处单次直接调用，总预算
      // 仍为 120s；reached / finality 断言不变。
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

      // 只记录非敏感证据。
      console.log(
        `TX-07 devnet evidence: txHash=${txHash} finality=${confirmation.finality} lease=consumed record=broadcast`,
      );
    } finally {
      engine.close();
    }
  }, 300_000);

  it('引擎路径：blockhash 过期后再广播：预发送 fail-closed、记录落 failed、载荷从未上链、consumed 不可回收', async () => {
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
      // 权威过期线是落库 token 的 lastValidBlockHeight，不是客户端回显。
      const lastValid = BigInt(lease!.last_valid_block_height);

      // 模拟必须趁 blockhash 新鲜时完成：引擎广播只接受 simulated 记录；
      // 过期后再模拟会被节点以 blockhash not found 拒绝并把记录推入 reverted。
      const simulated = await engine.simulate({
        transactionId: txnId,
        unsignedTransaction: built.unsignedTransaction,
      });
      expect(simulated.status).toBe('simulated');

      // 等链高越过 lastValidBlockHeight（devnet blockhash 有效期约 150 个块高）。
      // 等待位于 simulate 与 broadcast 之间——正是 B43 要防的窗口。
      const deadline = Date.now() + 420_000;
      for (; ;) {
        if (await currentBlockHeight() > lastValid) break;
        if (Date.now() > deadline) throw new Error('等待 blockhash 过期超时（链高未越过 lastValid）');
        await delay(5_000);
      }

      const signedPayload = signUnsigned(built.unsignedTransaction.payload, keypair.sign);
      const txHash = base58Encode(splitSignatures(fromBase64(signedPayload, 'payload')).signatures[0]!);

      // B43 预发送检查必须 fail-closed：错误码 DFR_BLOCKHASH_EXPIRED。
      // 该检查在引擎内 markConsumed 之后、端口广播之前执行，因此本次调用
      // 不产生任何网络发送（下方原始 RPC 查无此笔即是证明）。
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

      // 持久化事实：签名已落 CAS 且 markConsumed 已执行（租约 consumed——
      // 这个 blockhash 确实被一笔签名交易用掉了）；记录经 broadcast.rejected
      // 落 failed 并留下错误码；链上按签名原始 RPC 直查必须查无此笔（从未真发）。
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
