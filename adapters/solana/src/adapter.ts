/**
 * @dfr/adapter-solana —— Solana Adapter（M2 只读，ADR-025/027/028）。
 *
 * 范围：getInfo / capabilities / getBalance（lamports）/ getBlock（以 slot 定位）。
 * 写路径（build/simulate/broadcast）属 M3，本 Adapter 不声明这些能力，
 * 因此 Core 会在能力闸门处 fail-closed。
 *
 * 与 EVM Adapter 同构：Adapter 只做链语义与编解码，不选择 Provider、不访问数据库。
 */
import { createDfrError, isDfrError } from '@dfr/errors';
import type {
  AdapterCapabilities,
  AdapterContext,
  Balance,
  Block,
  BlockCapability,
  BlockRef,
  Chain,
  ChainAdapter,
  ChainId,
  ChainInfo,
  GetBalanceRequest,
  BalanceCapability,
  TransactionQueryCapability,
  Transaction,
  TransactionRef,
  Receipt,
  SequencingTokenExpiryMethod,
  CapabilityId,
  DecimalUint,
  Iso8601,
  SequencingToken,
  SequencingTokenReadMethod,
  EnsureSequencingTokenMethod,
  AccountRef,
  BuildCapability,
  TransactionRequest,
  UnsignedTransaction,
  UnsignedTransactionMeta,
  SimulationCapability,
  SimulationOptions,
  SimulationResult,
  BroadcastCapability,
  BroadcastOptions,
  BroadcastResult,
  SignedTransaction,
  ProviderHandle,
  ChainConfirmationObservation,
  ConfirmationObservationReadMethod,
  Commitment,
} from '@dfr/types';
import { assertSolanaAddress, assertSolanaSignature, isSolanaSignature } from './address.js';
import { COMMITMENT_TO_FINALITY_STATE } from '@dfr/types';
import {
  compileMessage,
  decodeTransactionPayload,
  encodeUnsignedTransaction,
  SolanaCodecError,
} from './transaction-codec.js';
import { bindSignedTransaction, SolanaBindingError } from './signed-transaction.js';
import {
  rpcOn,
  type SolanaRpcAccountInfo,
  type SolanaRpcBlock,
  type SolanaRpcTransaction,
} from './rpc.js';

function isUnsignedTransaction(
  value: TransactionRequest | UnsignedTransaction,
): value is UnsignedTransaction {
  return 'payload' in value;
}

/** 按能力获取句柄后发起一次只读调用（单次调用场景，与 EVM 的 evmCall 同构）。 */
async function evmStyleCall<T>(
  ctx: AdapterContext,
  capability: CapabilityId,
  method: string,
  params: readonly unknown[],
): Promise<T> {
  const handle = await ctx.providers.acquire({ capability });
  return rpcOn<T>(handle, ctx, method, params);
}

/**
 * 本 Adapter **实际实现**的能力（真相）。Registry 是允许清单，启动时校验 registry ⊆ adapter。
 *
 * 注意不含 `event.subscribe`：按 ADR-025，该能力是**部署级**（由 Core 的事件总线提供），
 * 不由 Adapter 实现。`transaction.read` 需要 getTransaction，当前 M2 只读范围先只声明
 * balance / block，待 B04 补齐后再加入清单与 registry。
 */
export const SOLANA_IMPLEMENTED_CAPABILITIES: readonly CapabilityId[] = [
  'account.balance',
  'block.read',
  'transaction.read',
  // M3-A02/B01：写路径构建（codec 见 transaction-codec.ts）。
  'transaction.build',
  // M3-B02：只读链上模拟。
  'transaction.simulate',
  // M3-C01：单次广播。
  'transaction.broadcast',
];

const LAMPORTS_DECIMALS = 9;

/** System Program（11111111111111111111111111111111 = 32 个零字节）。 */
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/** 广播超时：单次提交，失败即抛出，绝不重发。 */
const BROADCAST_TIMEOUT_MS = 30_000;

/** 端点说"已经有了"的模式（幂等成功）。 */
const ALREADY_KNOWN_PATTERNS = ['already been processed', 'already processed', 'already in'] as const;

export interface SolanaAdapterOptions {
  readonly chain: Chain;
  readonly version?: string;
}

export class SolanaAdapter
  implements
    ChainAdapter,
    BalanceCapability,
    BlockCapability,
    TransactionQueryCapability,
    SequencingTokenExpiryMethod,
    SequencingTokenReadMethod,
    EnsureSequencingTokenMethod,
    BuildCapability,
    SimulationCapability,
    BroadcastCapability,
    ConfirmationObservationReadMethod
{
  readonly family = 'solana' as const;
  readonly version: string;
  readonly specVersion = '0.1' as const;

  private readonly chain: Chain;

  constructor(options: SolanaAdapterOptions) {
    this.chain = options.chain;
    this.version = options.version ?? '0.1.0';
  }

  capabilities(): AdapterCapabilities {
    return {
      specVersion: '0.1',
      chain: this.chain.id,
      network: this.chain.network,
      capabilities: SOLANA_IMPLEMENTED_CAPABILITIES,
    };
  }

  /* ------------------------------ getInfo ------------------------------ */

  async getInfo(ctx: AdapterContext): Promise<ChainInfo> {
    this.assertChain(ctx.chain, ctx);
    // 复用同一句柄：slot 与版本必须来自同一端点。
    const handle = await ctx.providers.acquire({ capability: 'block.read' });
    const [slotResult, version, blockhash] = await Promise.all([
      rpcOn<number>(handle, ctx, 'getSlot', [{ commitment: 'confirmed' }]),
      rpcOn<{ 'solana-core'?: string }>(handle, ctx, 'getVersion', []),
      rpcOn<{ readonly context?: { readonly slot?: number }; readonly value?: { readonly blockhash?: string } }>(
        handle,
        ctx,
        'getLatestBlockhash',
        [{ commitment: 'confirmed' }],
      ).catch(() => undefined),
    ]);

    const info: ChainInfo = {
      chain: this.chain.id,
      network: this.chain.network,
      family: 'solana',
      slot: String(slotResult) as DecimalUint,
      observedAt: new Date().toISOString() as Iso8601,
    };
    if (version?.['solana-core'] !== undefined) info.nodeVersion = String(version['solana-core']);
    // getLatestBlockhash 返回 { context, value: { blockhash, lastValidBlockHeight } }
    const latest = blockhash as { readonly value?: { readonly blockhash?: string } } | undefined;
    if (typeof latest?.value?.blockhash === 'string') info.latestBlockHash = latest.value.blockhash;
    return info;
  }

  /* ----------------------------- getBalance ---------------------------- */

  async getBalance(ctx: AdapterContext, req: GetBalanceRequest): Promise<Balance> {
    this.assertChain(req.account.chain, ctx);
    assertSolanaAddress(req.account.address, this.chain.id, ctx.requestId);

    const asset = req.asset ?? { kind: 'native', chain: this.chain.id };
    if (asset.kind !== 'native') {
      // SPL token 余额需要 getTokenAccountBalance + 关联账户推导；M2 只读范围不做。
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'M2 只支持原生 SOL 余额；SPL token 余额需要额外的代币账户解析',
        chain: this.chain.id,
        details: { capability: 'account.balance' },
      });
    }
    if (asset.chain !== this.chain.id) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'asset.chain 与请求链不一致',
        chain: this.chain.id,
      });
    }

    const commitment = this.commitmentOf(req.consistency);
    const accountInfo = await evmStyleCall<SolanaRpcAccountInfo>(ctx, 'account.balance', 'getAccountInfo', [
      req.account.address,
      { commitment, encoding: 'base64' },
    ]);

    // 账户不存在时 lamports 视为 0（Solana 语义：未初始化账户余额为 0），不报 not found。
    const lamports = accountInfo.value?.lamports ?? 0;
    return {
      account: req.account.address,
      asset,
      amount: String(lamports) as DecimalUint,
      decimals: LAMPORTS_DECIMALS,
    };
  }

  /* ------------------------------ getBlock ----------------------------- */

  async getBlock(ctx: AdapterContext, ref: BlockRef): Promise<Block | null> {
    this.assertChain(ctx.chain, ctx);
    const { slot } = this.slotOf(ref, ctx);
    const commitment = ref.kind === 'tag' && ref.commitment !== undefined ? ref.commitment : 'confirmed';
    const handle = await ctx.providers.acquire({ capability: 'block.read' });
    const rpc = await rpcOn<SolanaRpcBlock | null>(handle, ctx, 'getBlock', [
      Number(slot),
      { commitment, encoding: 'json', transactionDetails: 'none', rewards: false },
    ]);
    if (rpc === null || rpc.blockhash == null) return null;

    const block: Block = {
      chain: this.chain.id,
      slot: String(slot) as DecimalUint,
      hash: rpc.blockhash,
      observedAt: new Date().toISOString() as Iso8601,
    };
    if (rpc.previousBlockhash != null) block.parentHash = rpc.previousBlockhash;
    if (rpc.blockTime != null) block.timestamp = String(rpc.blockTime) as DecimalUint;
    if (rpc.signatures != null) block.transactionCount = rpc.signatures.length;
    return block;
  }

  /* --------------------------- getTransaction -------------------------- */

  /**
   * Solana 交易查询（M2-B04）。
   *
   * 与 EVM 的差异（如实反映，不强行套用 EVM 字段）：
   * - 标识是**签名**（base58，64 字节），不是 keccak 哈希；
   * - 没有 nonce、没有"单一 to/value"（账户列表 + 指令模型），因此不填这些字段；
   * - 费用是 meta.fee（lamports）；
   * - 状态由 meta.err 决定：null = 成功，非 null = 执行失败。
   */
  async getTransaction(ctx: AdapterContext, ref: TransactionRef): Promise<Transaction | null> {
    this.assertChain(ctx.chain, ctx);
    if (ref.kind !== 'hash') {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'Solana 只支持按交易签名（signature）查询',
        chain: this.chain.id,
      });
    }
    assertSolanaSignature(ref.hash, this.chain.id, ctx.requestId);

    const rpc = await evmStyleCall<SolanaRpcTransaction | null>(
      ctx,
      'transaction.read',
      'getTransaction',
      [ref.hash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }],
    );
    if (rpc === null) return null;

    const transaction: Transaction = {
      schemaVersion: '1',
      ref: { kind: 'hash', hash: ref.hash },
      chain: this.chain.id,
      status: rpc.meta?.err == null ? 'included' : 'failed',
      observedAt: new Date().toISOString() as Iso8601,
    };
    if (rpc.slot != null) transaction.blockRef = { kind: 'slot', slot: String(rpc.slot) as DecimalUint };
    if (rpc.meta?.fee != null) {
      transaction.fee = { asset: { kind: 'native', chain: this.chain.id }, amount: String(rpc.meta.fee) as DecimalUint };
    }
    const signer = rpc.transaction?.message?.accountKeys?.[0];
    if (typeof signer === 'string') transaction.from = { chain: this.chain.id, address: signer };
    if (rpc.meta?.err != null) {
      transaction.error = createDfrError('DFR_TRANSACTION_REVERTED', {
        requestId: ctx.requestId,
        message: 'Solana 交易执行失败',
        chain: this.chain.id,
      });
    }
    return transaction;
  }

  /**
   * Solana 回执：computeUnitsConsumed 是"消耗的计算资源"，语义与 EVM 的 gasUsed 不同
   * （没有 gas price），因此只填 gasUsed 与费用，不伪造计价方式。
   */
  async getReceipt(ctx: AdapterContext, ref: TransactionRef): Promise<Receipt | null> {
    this.assertChain(ctx.chain, ctx);
    if (ref.kind !== 'hash') return null;
    // 软校验：非法签名视为"不存在"，不抛错（回执是可选信息）。
    if (!isSolanaSignature(ref.hash)) return null;

    const rpc = await evmStyleCall<SolanaRpcTransaction | null>(
      ctx,
      'transaction.read',
      'getTransaction',
      [ref.hash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }],
    );
    if (rpc === null || rpc.meta == null) return null;

    const receipt: Receipt = {
      ref: { kind: 'hash', hash: ref.hash },
      chain: this.chain.id,
      success: rpc.meta.err == null,
    };
    if (rpc.slot != null) receipt.blockRef = { kind: 'slot', slot: String(rpc.slot) as DecimalUint };
    if (rpc.meta.computeUnitsConsumed != null) {
      receipt.gasUsed = String(rpc.meta.computeUnitsConsumed) as DecimalUint;
    }
    if (rpc.meta.fee != null) {
      receipt.effectiveFee = {
        asset: { kind: 'native', chain: this.chain.id },
        amount: String(rpc.meta.fee) as DecimalUint,
      };
    }
    return receipt;
  }

  /* ------------------------------ helpers ------------------------------ */

  /**
   * `BlockRef` → slot（ADR-027）。
   *
   * - `slot`：Solana 的规范定位；
   * - `hash`：定义为 **blockhash**（base58），需先按 blockhash 查到 slot；
   * - `number` / `tag`：Solana 不适用 → fail-closed（对应的镜像行为是 EVM 对 `slot` 的处理）。
   */
  private slotOf(ref: BlockRef, ctx: AdapterContext): { slot: bigint | number } {
    if (ref.kind === 'slot') return { slot: BigInt(ref.slot) };
    if (ref.kind === 'tag') {
      // 仅支持 latest/confirmed/finalized 语义 → 由调用方先用 getSlot 解析。
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'Solana 的 getBlock 需要明确的 slot 或 blockhash；tag 定位请先用 getSlot 解析',
        chain: this.chain.id,
        details: { capability: 'block.read' },
      });
    }
    if (ref.kind === 'hash') {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: '按 blockhash 定位需要先解析为 slot；M2 只支持 slot 定位',
        chain: this.chain.id,
        details: { capability: 'block.read' },
      });
    }
    // kind === 'number'
    throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
      requestId: ctx.requestId,
      message: 'Solana 不使用区块高度（number）；请用 slot 定位',
      chain: this.chain.id,
      details: { capability: 'block.read' },
    });
  }

  private commitmentOf(
    hint: GetBalanceRequest['consistency'],
  ): 'processed' | 'confirmed' | 'finalized' {
    if (hint?.mode === 'finalized') return 'finalized';
    if (hint?.mode === 'best-effort') return 'processed';
    return 'confirmed';
  }

  /**
   * 判定一个 Solana 排序前提（recent blockhash）是否已过期（M3-A01，ADR-032）。
   *
   * 判据是**区块高度**，不是时间：`getBlockHeight()` 一旦超过 token 的
   * `lastValidBlockHeight`，该 blockhash 就不再被链接受（实测 devnet 有效窗口
   * 约 166 个 block，≈60–90 秒）。这正是"链特定过期语义必须在 Adapter"的落点；
   * Store 只存 `lastValidBlockHeight`，从不自行判断。
   *
   * 这是非 Capability 的内部协调方法（与 `getPendingNonce` 同理）：不进
   * `CapabilityId` / `capabilities()`，不能被 Gateway 直接路由。EVM **不实现**它
   * （nonce 不会过期），Core 缺失时按"永不过期"处理。
   */
  async isSequencingExpired(ctx: AdapterContext, token: SequencingToken): Promise<boolean> {
    this.assertChain(ctx.chain, ctx);
    if (token.kind !== 'blockhash') {
      // EVM 的 nonce token 不该走到 Solana Adapter：fail-closed 而不是猜一个答案。
      throw createDfrError('DFR_INVALID_REQUEST', {
        requestId: ctx.requestId,
        message: 'Solana Adapter 只接受 blockhash 排序前提；nonce 语义属于 EVM',
        chain: this.chain.id,
        details: { capability: 'transaction.build' },
      });
    }
    // JSDoc 已声明这是安全通信（只读、不涉及签名材料）。
    const handle = await ctx.providers.acquire({ capability: 'block.read' });
    const height = await rpcOn<number>(handle, ctx, 'getBlockHeight', [{ commitment: 'confirmed' }]);
    // 十进制字符串比较：两者都可能超出 JS 安全整数范围（禁 number 契约）。
    return BigInt(String(height)) > BigInt(token.lastValidBlockHeight);
  }

  /* ------------------------------- build ------------------------------- */

  /**
   * 构建一笔未签名 Solana 交易（M3-B01）。
   *
   * 与 EVM build 的关键差异：Solana **没有账户 nonce**，排序前提是 recent blockhash，
   * 由 Adapter 从链上取（`getLatestBlockhash`）——这正是"链特定前提在 Adapter"。
   * 因此 `req.nonce` 对 Solana 无意义：出现即 fail-closed（不静默忽略，避免调用方
   * 以为 nonce 生效了）。blockhash 同时写入 `meta.recentBlockhash` 供上层
   * `SequencingStore` 承载其 `lastValidBlockHeight`。
   *
   * 范围（M3-B01）：原生 SOL 转账（System Program `Transfer`，指令枚举值 2）。
   * SPL token / 任意指令 / ALT / durable nonce 不在本卡范围，显式 fail-closed。
   */
  /**
   * 取本链当前的**排序前提**（ADR-032/033）：recent blockhash + 链上有效期。
   *
   * 这是非 Capability 的内部协调方法（与 EVM 的 `getPendingNonce` 对位）：引擎走
   * blockhash 路径时先调它，把 token 交给 `SequencingStore.reserve` 落租约，
   * 再用 `withSequencingToken` 把**同一个** blockhash 注入 build——保证租约与载荷一致。
   */
  async getSequencingToken(ctx: AdapterContext, account: AccountRef): Promise<SequencingToken> {
    this.assertChain(account.chain, ctx);
    const handle = await ctx.providers.acquire({ capability: 'transaction.build' });
    const latest = await rpcOn<{
      readonly value?: { readonly blockhash?: string; readonly lastValidBlockHeight?: number };
    }>(handle, ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = latest.value?.blockhash;
    const lastValidBlockHeight = latest.value?.lastValidBlockHeight;
    if (typeof blockhash !== 'string' || blockhash.length === 0 || lastValidBlockHeight == null) {
      throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
        requestId: ctx.requestId,
        message: 'getLatestBlockhash 未返回可用的 blockhash / lastValidBlockHeight',
        chain: this.chain.id,
        details: { capability: 'transaction.build' },
      });
    }
    return {
      kind: 'blockhash',
      value: blockhash,
      lastValidBlockHeight: String(lastValidBlockHeight) as DecimalUint,
    };
  }

  /** 把引擎分配的 blockhash 注入请求（ADR-033）；形状不符即 fail-closed。 */
  withSequencingToken(req: TransactionRequest, token: SequencingToken): TransactionRequest {
    if (token.kind !== 'blockhash') {
      throw createDfrError('DFR_INVALID_REQUEST', {
        requestId: 'req_sequencing_token_shape' as never,
        message: 'Solana 的排序前提必须是 blockhash token',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'sequencingRef' },
      });
    }
    return { ...req, recentBlockhash: token.value };
  }

  async build(ctx: AdapterContext, req: TransactionRequest): Promise<UnsignedTransaction> {
    this.assertChain(req.chain, ctx);
    this.assertChain(req.from.chain, ctx);
    assertSolanaAddress(req.from.address, this.chain.id, ctx.requestId);
    if (req.to === undefined) {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'Solana build 需要明确的收款地址（to）；本卡不支持合约/程序部署',
        chain: this.chain.id,
        details: { capability: 'transaction.build', reason: 'missing-to' },
      });
    }
    this.assertChain(req.to.chain, ctx);
    assertSolanaAddress(req.to.address, this.chain.id, ctx.requestId);
    if (req.nonce !== undefined) {
      // Solana 无账户 nonce。EVM 语义的 nonce 传进来必须显式失败，不能装作没看见。
      throw createDfrError('DFR_INVALID_REQUEST', {
        requestId: ctx.requestId,
        message: 'Solana 不使用账户 nonce；排序前提是 recent blockhash（由 Adapter 取）',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'nonce' },
      });
    }

    const lamports = this.transferLamports(req, ctx);
    // 排序前提：引擎（经 SequencingStore）已注入则原样使用；否则（直接调用 Adapter 的
    // 路径，如契约测试）现场取一个。绝不硬编码。
    let blockhash = req.recentBlockhash;
    if (blockhash === undefined || blockhash.length === 0) {
      const token = await this.getSequencingToken(ctx, req.from);
      if (token.kind !== 'blockhash') throw new Error('unreachable: Solana token 必须是 blockhash');
      blockhash = token.value;
    }

    // System Program 的 Transfer 指令：u32 小端指令枚举 2 + u64 小端 lamports。
    const data = new Uint8Array(12);
    data[0] = 2;
    new DataView(data.buffer).setBigUint64(4, lamports, true);

    const intent = {
      feePayer: req.from.address,
      blockhash,
      instructions: [
        {
          programId: SYSTEM_PROGRAM_ID,
          accounts: [
            { pubkey: req.from.address, isSigner: true, isWritable: true },
            { pubkey: req.to.address, isSigner: false, isWritable: true },
          ],
          data: Buffer.from(data).toString('base64'),
        },
      ],
    };
    const encoded = encodeUnsignedTransaction(intent);
    const message = compileMessage(intent);

    const meta: UnsignedTransactionMeta = {
      encoding: 'base64',
      // Solana 的排序前提（ADR-032）：写进 meta 供 SequencingStore 记录时效。
      recentBlockhash: blockhash,
      feeEstimate: {
        asset: { kind: 'native', chain: this.chain.id },
        // 费用由签名者数量与 compute budget 决定；精确值需 simulate（B02）。
        // 这里给出 Solana 的**基础签名费**（5000 lamports × 签名者数），不虚构 compute 费。
        amount: String(5_000 * message.numRequiredSignatures) as DecimalUint,
      },
      warnings: [
        '费用仅含基础签名费（5000 lamports × 签名者数），未含 compute 费用；精确费用由 simulate 给出',
      ],
    };
    return { schemaVersion: '1', chain: this.chain.id, payload: encoded.payload, meta };
  }

  /** 原生 SOL 金额 → lamports（`Amount.amount` 已是十进制字符串，按法定小数位换算）。 */
  private transferLamports(req: TransactionRequest, ctx: AdapterContext): bigint {
    if (req.value === undefined) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'Solana 转账必须提供金额（value）',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'value' },
      });
    }
    const asset = req.value.asset;
    if (asset.kind !== 'native' || asset.chain !== this.chain.id) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'build 的原生金额必须使用本链原生资产',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'value' },
      });
    }
    if (!/^[0-9]+$/u.test(req.value.amount)) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: '金额必须是十进制字符串',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'value' },
      });
    }
    const lamports = BigInt(req.value.amount) * 10n ** BigInt(LAMPORTS_DECIMALS);
    // Solana 的 lamports 是 u64。
    if (lamports > (2n ** 64n - 1n)) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: '金额超出 Solana u64 lamports 上限',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'value' },
      });
    }
    return lamports;
  }

  /* ------------------------------ simulate ------------------------------ */

  /**
   * 只读链上模拟（M3-B02）。
   *
   * Solana 用 `simulateTransaction`：返回 `err`（执行失败原因）、`logs`、`unitsConsumed`、
   * `fee`。语义与 EVM 对齐：**执行回滚不抛 5xx**，而是归一化为
   * `{ success:false, revertReason }`，由 Transaction Engine 落为 `reverted` 并封锁广播。
   *
   * 与 EVM 的输入形状一致地支持两种调用：
   *   - 载荷路径（`UnsignedTransaction`）：直接模拟该载荷；`options.from` 不适用
   *     （Solana 的 fee payer 已编译进 message），给了也不改变结果。
   *   - 请求路径（`TransactionRequest`）：先构建再模拟（build 会取 blockhash）。
   *
   * `sigVerify:false` 的原因：外部签名交易在**客户端**签名，服务端只做模拟，
   * 没有也不需要签名材料；Solana 允许 sigVerify:false 下模拟（签名视为通过）。
   */
  async simulate(
    ctx: AdapterContext,
    req: TransactionRequest | UnsignedTransaction,
    _options?: SimulationOptions,
  ): Promise<SimulationResult> {
    const warnings: string[] = [];
    let payload: string;
    if (isUnsignedTransaction(req)) {
      this.assertChain(req.chain, ctx);
      if (req.meta.encoding !== undefined && req.meta.encoding !== 'base64') {
        throw createDfrError('DFR_UNSUPPORTED_VERSION', {
          requestId: ctx.requestId,
          message: 'Solana simulate 只接受 base64 载荷',
          chain: this.chain.id,
          details: { capability: 'transaction.simulate', encoding: req.meta.encoding },
        });
      }
      payload = req.payload;
      // Solana 的发送方（fee payer）已编译进 message；请求路径才需要 from。
      warnings.push('载荷路径不校验发送方余额之外的角色；fee payer 已由载荷决定');
    } else {
      const built = await this.build(ctx, req);
      payload = built.payload;
    }

    const handle = await ctx.providers.acquire({ capability: 'transaction.simulate' });
    const simulated = await rpcOn<{
      readonly value?: {
        readonly err?: unknown;
        readonly logs?: readonly string[] | null;
        readonly unitsConsumed?: number | null;
        readonly fee?: number | null;
      };
    }>(handle, ctx, 'simulateTransaction', [
      payload,
      { sigVerify: false, replaceRecentBlockhash: false, encoding: 'base64', commitment: 'confirmed' },
    ]);

    const value = simulated.value;
    if (value === undefined) {
      throw createDfrError('DFR_PROVIDER_UNAVAILABLE', {
        requestId: ctx.requestId,
        message: 'simulateTransaction 未返回结果',
        chain: this.chain.id,
        details: { capability: 'transaction.simulate' },
      });
    }
    if (value.err != null) {
      const reason = this.describeSolanaError(value.err);
      // `BlockhashNotFound` 语义上是"排序前提已过期，需要重新 build"，而不是程序回滚。
      // 精确分类（该错误码 / 重试语义）由 C03 定义；这里只显式标注，避免被当成普通 revert。
      const extra =
        reason.includes('BlockhashNotFound')
          ? ['blockhash 可能已过期：应按 C03 语义重新 build，而不是标记为 reverted']
          : [];
      return this.revertedSimulation(reason, [...warnings, ...extra]);
    }
    const result: SimulationResult = { success: true };
    if (value.unitsConsumed != null) {
      result.estimatedCost = String(value.unitsConsumed) as DecimalUint;
    }
    if (value.fee != null) {
      result.estimatedFee = {
        asset: { kind: 'native', chain: this.chain.id },
        amount: String(value.fee) as DecimalUint,
      };
    }
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  /** Solana 的执行错误（`err` 可为对象或字符串）→ 已脱敏的原因文本。 */
  private describeSolanaError(err: unknown): string {
    if (typeof err === 'string') return err;
    try {
      const encoded = JSON.stringify(err);
      return encoded === undefined ? 'Solana 交易执行失败' : encoded;
    } catch {
      return 'Solana 交易执行失败';
    }
  }

  private revertedSimulation(reason: string, warnings: readonly string[]): SimulationResult {
    const result: SimulationResult = { success: false, revertReason: reason };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  /* ------------------------------ broadcast ------------------------------ */

  /**
   * 单次广播已签名交易（M3-C01）。
   *
   * 四条与 EVM 对齐的红线（资金安全优先于便利）：
   *   1. **恰好一次**：`idempotency: 'non-idempotent-write'`，Provider Manager 绝不自动重试，
   *      失败也不切换端点重发；
   *   2. **广播前本地校验**：签名载荷与记录真值（from / 未签名载荷 / expectedHash）绑定不符
   *      一律在 `acquire()` 之前拒绝 → `DFR_TRANSACTION_REJECTED`，**不发出广播**；
   *   3. **already known 是幂等成功**（error-spec §5.1）；
   *   4. 端点返回的签名必须与载荷重算一致，否则 `DFR_PROVIDER_INVALID_RESPONSE`。
   *
   * `maxRetries:0`：绝不把"重试"交给节点——重试策略是状态机的职责（C03），不是传输层。
   */
  async broadcast(
    ctx: AdapterContext,
    signed: SignedTransaction,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult> {
    this.assertChain(signed.chain, ctx);

    // --- 本地校验（不花 RPC、不 acquire）---
    const txHash = this.verifyBroadcastBinding(ctx, signed, options);

    // --- 单次调用 ---
    const handle = await ctx.providers.acquire({ capability: 'transaction.broadcast' });
    let returned: string;
    try {
      returned = await handle.request<string>(
        {
          method: 'sendTransaction',
          params: [
            signed.signedPayload,
            {
              encoding: 'base64',
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              // 重试是状态机职责（C03）；这里绝不自动重试。
              maxRetries: 0,
            },
          ],
          idempotency: 'non-idempotent-write',
          timeoutMs: BROADCAST_TIMEOUT_MS,
        },
        {
          requestId: ctx.requestId,
          ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
          ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
          signal: ctx.signal,
        },
      );
    } catch (err) {
      if (this.isAlreadyKnown(err)) return this.broadcastAccepted(handle, txHash, options);
      // blockhash 过期（M3-C03）：该签名载荷永远不会上链，重发无意义。
      // 归一化为**专门的**错误码 + 可执行提示；绝不自动重新签名（签名属外部）。
      if (this.isBlockhashExpired(err)) {
        throw createDfrError('DFR_BLOCKHASH_EXPIRED', {
          requestId: ctx.requestId,
          message: 'Solana blockhash 已过期：该签名载荷不会被接受，请重新 build 后再签名',
          chain: this.chain.id,
          details: { method: 'sendTransaction', action: 'rebuild' },
          ...(isDfrError(err) ? { cause: err } : {}),
        });
      }
      // 其它失败原样上抛：是否回退状态由 TransactionEngine 决定（C03）。
      throw err;
    }

    if (typeof returned !== 'string' || !isSolanaSignature(returned) || returned !== txHash) {
      throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
        requestId: ctx.requestId,
        message: '广播端点返回的签名与签名载荷不一致',
        provider: handle.id,
        chain: this.chain.id,
        details: { method: 'sendTransaction' },
      });
    }

    return this.broadcastAccepted(handle, txHash, options);
  }

  /** 广播成功（含 already-known 幂等成功）的唯一构造点。 */
  private broadcastAccepted(
    handle: ProviderHandle,
    txHash: string,
    options?: BroadcastOptions,
  ): BroadcastResult {
    const result: BroadcastResult = {
      ref: { kind: 'hash', hash: txHash },
      status: 'broadcast',
      accepted: true,
      providerId: handle.id,
      observedAt: new Date().toISOString() as Iso8601,
    };
    if (options?.rebroadcast === true) result.rebroadcast = true;
    return result;
  }

  /**
   * 广播前的本地绑定校验，返回由签名载荷重算的交易哈希。
   *
   * 有记录真值时（引擎会带上 `expectedFrom` + `expectedUnsignedPayload`）做完整绑定；
   * 否则只做 Adapter 能独立证明的部分（已签名 + expectedHash）。任何失败都在
   * `acquire()` 之前抛出，因此**不会发出广播**。
   */
  private verifyBroadcastBinding(
    ctx: AdapterContext,
    signed: SignedTransaction,
    options: BroadcastOptions | undefined,
  ): string {
    const hasFrom = options?.expectedFrom !== undefined;
    const hasUnsigned = options?.expectedUnsignedPayload !== undefined;
    if (hasFrom !== hasUnsigned) {
      throw this.broadcastRejected(ctx, 'invalid_expectation');
    }
    if (hasFrom && hasUnsigned) {
      try {
        const binding = bindSignedTransaction(signed.signedPayload, {
          from: options!.expectedFrom!.address,
          unsignedPayload: options!.expectedUnsignedPayload!,
          expectedHash: signed.expectedHash,
        });
        return binding.txHash;
      } catch (err) {
        if (err instanceof SolanaBindingError) throw this.broadcastRejected(ctx, err.reason, err);
        throw err;
      }
    }
    // 无记录真值：只做 Adapter 能独立证明的部分。
    let decoded;
    try {
      decoded = decodeTransactionPayload(signed.signedPayload);
    } catch (err) {
      throw this.broadcastRejected(ctx, err instanceof SolanaCodecError ? err.reason : 'invalid_payload', err);
    }
    if (!decoded.signed) throw this.broadcastRejected(ctx, 'not_signed');
    const txHash = decoded.signatures[0];
    if (txHash === undefined || txHash !== signed.expectedHash) {
      throw this.broadcastRejected(ctx, 'expected_hash_mismatch');
    }
    return txHash;
  }

  /** 广播前的本地拒绝：统一 422 `DFR_TRANSACTION_REJECTED`，不泄漏签名原文。 */
  private broadcastRejected(ctx: AdapterContext, reason: string, cause?: unknown): Error {
    return createDfrError('DFR_TRANSACTION_REJECTED', {
      requestId: ctx.requestId,
      message: `签名载荷未通过广播前校验（${reason}）`,
      chain: this.chain.id,
      details: { reason },
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  /**
   * 端点是否在说"blockhash 找不到/已过期"（M3-C03）。
   *
   * Solana 在 blockhash 过期（超出 `lastValidBlockHeight`）时以 "Blockhash not found"
   * 拒绝交易；这是**可证明不可自愈**的拒绝，必须与普通 revert/超时区分开。
   */
  private isBlockhashExpired(err: unknown): boolean {
    const message = this.errorText(err).toLowerCase();
    return (
      message.includes('blockhash not found') ||
      message.includes('blockhashnotfound') ||
      message.includes('blockhash expired') ||
      message.includes('blockhash has expired')
    );
  }

  /** 从任意错误里取出可匹配的文本（DFR 错误优先用 chainError.message，避免泄漏原文）。 */
  private errorText(err: unknown): string {
    if (isDfrError(err)) return `${err.chainError?.message ?? ''} ${err.message}`;
    return err instanceof Error ? err.message : String(err);
  }

  /** 端点是否在说"这笔交易我已经有了"（幂等成功）。 */
  private isAlreadyKnown(err: unknown): boolean {
    if (!isDfrError(err)) return false;
    const message = `${err.chainError?.message ?? ''}`.toLowerCase();
    return ALREADY_KNOWN_PATTERNS.some((pattern) => message.includes(pattern));
  }

  /**
   * 单次只读确认观测（M3-C02）。
   *
   * 用 `getTransaction` 带上 Solana 的 commitment：`processed` / `confirmed` / `finalized`
   * （ADR-031 的三级）。返回的 `finality` 是**由 commitment 映射**到 DFR 观测域（不是
   * 用确认数派生，Solana 没有 EVM 意义上的"确认数"）。
   *
   * 语义：
   *   - 查不到（`null`）→ `null`（上层保持 unknown，不假装状态）；
   *   - 执行失败（`meta.err != null`）→ status `reverted`，finality 仍按 commitment 报告；
   *   - 否则 status 取 commitment 对应档位（processed→included / confirmed / finalized）。
   *
   * 只读：绝不广播、不重发、不写状态。
   */
  async observeConfirmation(
    ctx: AdapterContext,
    req: { readonly txHash: string },
  ): Promise<ChainConfirmationObservation | null> {
    this.assertChain(ctx.chain, ctx);
    assertSolanaSignature(req.txHash, this.chain.id, ctx.requestId);
    return await this.observeConfirmationAt(ctx, req.txHash);
  }

  private async observeConfirmationAt(
    ctx: AdapterContext,
    txHash: string,
  ): Promise<ChainConfirmationObservation | null> {
    const handle = await ctx.providers.acquire({ capability: 'transaction.read' });
    let lastTx: SolanaRpcTransaction | null = null;
    let lastCommitment: Commitment = 'confirmed';
    for (const commitment of ['finalized', 'confirmed', 'processed'] as const) {
      let tx: SolanaRpcTransaction | null;
      try {
        tx = await rpcOn<SolanaRpcTransaction | null>(handle, ctx, 'getTransaction', [
          txHash,
          { commitment, maxSupportedTransactionVersion: 0, encoding: 'json' },
        ]);
      } catch (err) {
        // 部分集群（含 devnet）的 getTransaction 不支持 `processed`
        // （"Method does not support commitment below `confirmed`"）。
        // 这不是"查不到"，而是"该档位不可用"——按档位不可用跳过，绝不当作失败或 null 结论。
        if (isDfrError(err) && /commitment below/i.test(this.errorText(err))) continue;
        throw err;
      }
      if (tx !== null) {
        lastTx = tx;
        lastCommitment = commitment;
        break;
      }
    }
    if (lastTx === null) return null;

    const finality = COMMITMENT_TO_FINALITY_STATE[lastCommitment];
    // 执行失败（reverted）优先于最终性档位：状态仍是事实，finality 照实报告。
    // 注意：`getTransaction` 不返回区块哈希，因此 canonicalBlockHash 不伪造（留空）。
    const status: Transaction['status'] =
      lastTx.meta?.err != null
        ? 'reverted'
        : lastCommitment === 'finalized'
          ? 'finalized'
          : lastCommitment === 'confirmed'
            ? 'confirmed'
            : 'included';
    return {
      status,
      finality,
      ...(lastTx.slot != null
        ? { blockRef: { kind: 'slot', slot: String(lastTx.slot) as DecimalUint } as BlockRef }
        : {}),
    };
  }

  /**
   * `event.subscribe` 是**部署级**能力（ADR-025），由 Core 的事件总线提供，Adapter 不实现。
   * 与 EVM 同构：存在但立即抛，不静默降级。
   */
  subscribe(ctx: AdapterContext, _filter: unknown): AsyncIterable<never> {
    const error = createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
      requestId: ctx.requestId,
      message: 'event.subscribe 是部署级能力，由 Core 的事件总线提供',
      chain: ctx.chain,
      details: { capability: 'event.subscribe' },
    });
    return {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return { next: (): Promise<IteratorResult<never>> => Promise.reject(error) };
      },
    };
  }

  /** `contract.read`（只读程序调用）尚未实现：fail-closed，不静默降级。 */
  readContract(ctx: AdapterContext, _req: unknown): Promise<never> {
    return Promise.reject(
      createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'Solana 只读程序调用（contract.read）尚未实现',
        chain: this.chain.id,
        details: { capability: 'contract.read' },
      }),
    );
  }

  private assertChain(chain: ChainId, ctx: AdapterContext): void {
    if (chain !== this.chain.id) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `请求链 ${chain} 与 Adapter 绑定的链 ${this.chain.id} 不一致`,
        chain: this.chain.id,
      });
    }
  }
}
