/**
 * EVM Adapter（DFR-008，M0 只读）。
 *
 * 范围（见 ADR-010）：getInfo / getBalance / getBlock / getTransaction / getReceipt。
 * 不签名、不广播、不托管私钥；build / simulate / broadcast 属 M1，
 * 本 Adapter 不声明这些能力，因此相关请求返回 DFR_UNSUPPORTED_CAPABILITY。
 *
 * Adapter 不持有端点或凭证：所有链访问都经 `ctx.providers.acquire()`。
 */
import { createDfrError, isDfrError, newRequestId } from '@dfr/errors';
import type {
  AccountRef,
  AdapterCapabilities,
  AdapterContext,
  Balance,
  Block,
  BroadcastOptions,
  BroadcastResult,
  ChainEvent,
  ContractReadRequest,
  EventFilter,
  SignedTransaction,
  SimulationOptions,
  SimulationResult,
  BroadcastObservation,
  BroadcastObservationRequest,
  ChainConfirmationObservation,
  ConfirmationObservationReadMethod,
  TransactionRequest,
  UnsignedTransaction,
  BlockCapability,
  BlockRef,
  CapabilityId,
  Chain,
  ChainAdapter,
  ChainId,
  ChainInfo,
  DecimalUint,
  FinalityPolicy,
  FinalityState,
  GetBalanceRequest,
  PendingNonceReadMethod,
  SequencingTokenReadMethod,
  EnsureSequencingTokenMethod,
  SequencingToken,
  ProviderHandle,
  Receipt,
  Transaction,
  TransactionQueryCapability,
  TransactionRef,
  ChainLog,
  Account,
  AccountCodeCapability,
  ContractLogsCapability,
  ContractLogsRequest,
  ContractReadCapability,
  ContractReadResult,
  BalanceCapability,
  Iso8601,
  AssetRef,
  Amount,
  UnsignedTransactionMeta,
} from '@dfr/types';
import { assertEvmAddress, assertEvmTxHash, isEvmTxHash } from './address.js';
import { decimalUintToHex, hexToDecimalUint } from './hex.js';
import {
  evmCall,
  rpcOn,
  type RpcBlock,
  type RpcLog,
  type RpcFeeHistory,
  type RpcReceipt,
  type RpcTransaction,
} from './rpc.js';
import { bindSignedTransaction, parseSignedTransaction } from './signed-transaction.js';
import { decodeFunctionResult, encodeFunctionData, getAbiItem, parseAbi } from 'viem';
import {
  decodeTransactionPayload,
  encodeUnsignedTransaction,
  EvmCodecError,
  type EvmTransactionType,
  type EvmUnsignedIntent,
  type EvmUnsignedPayload,
} from './transaction-codec.js';

/** 原生资产的精度固定为 18（ETH / 各 EVM L2 原生币）。 */
const NATIVE_DECIMALS = 18;

/**
 * 广播超时（M1-C02）。
 *
 * 比只读的 10s 略长：广播在端点排队/入 mempool 的耗时高于普通查询。
 * 超时**不等于失败**（m1-api-contract 第 5 节）：由 C03 按 expectedHash 查询后
 * 分类为 included / unknown，绝不自动重发。
 */
const BROADCAST_TIMEOUT_MS = 15_000;

/**
 * 端点把"这笔交易我已经有了"表达为 JSON-RPC 错误时的消息特征。
 *
 * 放在 Adapter 而不是 Provider：Provider 只做传输，不理解链语义（AGENTS.md 第 3 节）。
 * 上游 message 已由 Provider 放进 `chainError.message`（脱敏后），这里只做分类。
 */
const ALREADY_KNOWN_PATTERNS = [
  'already known',
  'already exists',
  'already imported',
  'known transaction',
] as const;

/** M0 只读能力集合（与 chains.yaml 的 M0 条目一致，registry ⊆ adapter）。 */
export const EVM_M0_CAPABILITIES: readonly CapabilityId[] = [
  'account.balance',
  'block.read',
  'transaction.read',
];

/**
 * Adapter 当前**已实现**的能力集合（能力真相，adapter-spec 第 3 章规则 7）。
 *
 * Capability 只能增加：B02 增加 `transaction.build`；后续任务落地 simulate /
 * broadcast 时在此追加。注册表（chains.yaml）是"允许清单"，它必须是本集合的子集，
 * 反向不成立——所以本集合可以先于 chains.yaml 的 M1 条目存在。
 */
export const EVM_IMPLEMENTED_CAPABILITIES: readonly CapabilityId[] = [
  ...EVM_M0_CAPABILITIES,
  'transaction.build',
  'transaction.simulate',
  // M1-C02：广播单次调用。M1-C05（Gateway 端点）与 C03（引擎状态流）才是
  // 对外暴露写路径的地方；能力真相在这里，Registry 是否启用另算（registry ⊆ adapter）。
  'transaction.broadcast',
  // ADR-034：事件日志查询（BEX 链上核对）。与 contract.read（eth_call）并列。
  'contract.logs',
  // ADR-035：只读合约调用（eth_call）。
  'contract.read',
  // ADR-036：账户存在性 / 合约判定（eth_getCode）。
  'account.code',
];

/** `eth_getLogs` 的保守默认跨度（ADR-034）；按链可用 `maxBlockRange` 覆盖。 */
const DEFAULT_MAX_BLOCK_RANGE = '2000' as DecimalUint;

/** M1 build 支持允许的交易类型（ADR-016 §5）。 */
const SUPPORTED_TRANSACTION_TYPES: readonly EvmTransactionType[] = [
  'legacy',
  'eip2930',
  'eip1559',
];

/** 规范十进制：无前导零（`0` 除外）、无符号、无小数。 */
const DECIMAL_UINT_RE = /^(?:0|[1-9][0-9]*)$/;

/** 区分 simulate 的两种输入（载荷路径没有发送方，必须显式提示）。 */
function isUnsignedTransaction(
  value: TransactionRequest | UnsignedTransaction,
): value is UnsignedTransaction {
  return 'payload' in value;
}

/** simulate 归一化后的调用意图。 */
interface SimulationCall {
  /** 发送方；未构造载荷时未知（不伪造）。 */
  readonly from?: string;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  /** 已构造载荷固定的 gas 上限；请求路径未知时用 estimateGas 推导。 */
  readonly gas?: bigint;
  /** 每 gas 价格上限，用于估算费用。 */
  readonly feePerGas?: bigint;
}

export interface EvmAdapterOptions {
  /** 该 Adapter 实例绑定的链；`externalChainId` 用于 eth_chainId 一致性校验。 */
  chain: Chain;
  /** Adapter 实现版本（semver）。 */
  version?: string;
  /**
   * build 产出的交易类型，默认 `eip1559`。
   *
   * 只影响 build 的编码与费用获取方式；解析路径（codec）对三类都支持。
   */
  transactionType?: EvmTransactionType;
  /**
   * 单次 `eth_getLogs` 允许的最大区块跨度（ADER-034），十进制字符串。
   *
   * 省略时默认一个**保守**值（见 `DEFAULT_MAX_BLOCK_RANGE`）；显式传入用于按链标定。
   */
  maxBlockRange?: DecimalUint;
}

export class EvmAdapter
  implements
    ChainAdapter,
    BalanceCapability,
    BlockCapability,
    TransactionQueryCapability,
    ConfirmationObservationReadMethod,
    PendingNonceReadMethod,
    SequencingTokenReadMethod,
    EnsureSequencingTokenMethod,
    ContractLogsCapability,
    ContractReadCapability,
    AccountCodeCapability
{
  readonly family = 'evm' as const;
  readonly version: string;
  readonly specVersion = '0.1' as const;

  private readonly chain: Chain;
  private readonly transactionType: EvmTransactionType;
  private readonly maxBlockRange: DecimalUint;

  constructor(options: EvmAdapterOptions) {
    this.chain = options.chain;
    this.version = options.version ?? '0.1.0';
    this.maxBlockRange = options.maxBlockRange ?? DEFAULT_MAX_BLOCK_RANGE;

    const type = options.transactionType ?? 'eip1559';
    if (!SUPPORTED_TRANSACTION_TYPES.includes(type)) {
      throw createDfrError('DFR_CONFIGURATION_ERROR', {
        requestId: newRequestId(),
        message: `不支持的交易类型 "${String(type)}"；M1 只支持 legacy / eip2930 / eip1559`,
      });
    }
    this.transactionType = type;
  }

  capabilities(): AdapterCapabilities {
    return {
      specVersion: '0.1',
      chain: this.chain.id,
      network: this.chain.network,
      capabilities: EVM_IMPLEMENTED_CAPABILITIES,
    };
  }

  /* ------------------------------ getInfo ------------------------------ */

  async getInfo(ctx: AdapterContext): Promise<ChainInfo> {
    this.assertChain(ctx.chain, ctx);
    const expected = this.expectedChainId(ctx);

    // 复用同一个 Provider 句柄：chainId 校验必须与高度/区块来自同一端点才有意义。
    const handle = await ctx.providers.acquire({ capability: 'block.read' });
    const [chainIdHex, heightHex, block, nodeVersion] = await Promise.all([
      rpcOn<string>(handle, ctx, 'eth_chainId', []),
      rpcOn<string>(handle, ctx, 'eth_blockNumber', []),
      rpcOn<RpcBlock | null>(handle, ctx, 'eth_getBlockByNumber', ['latest', false]),
      rpcOn<string>(handle, ctx, 'web3_clientVersion', []).catch(() => undefined),
    ]);

    // fail-closed：链 ID 不一致说明端点指错了网络（adapter-spec 8.1）。
    if (BigInt(chainIdHex) !== BigInt(expected)) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `Provider 返回的 chainId 与注册表不一致（期望 ${expected}）`,
        chain: this.chain.id,
        details: { expectedChainId: expected },
      });
    }

    const info: ChainInfo = {
      chain: this.chain.id,
      network: this.chain.network,
      family: 'evm',
      height: hexToDecimalUint(heightHex),
      observedAt: new Date().toISOString() as Iso8601,
    };
    if (block?.hash != null) info.latestBlockHash = block.hash;
    if (block?.baseFeePerGas != null) info.baseFeePerGas = hexToDecimalUint(block.baseFeePerGas);
    if (typeof nodeVersion === 'string') info.nodeVersion = nodeVersion;
    return info;
  }

  /* ----------------------------- getBalance ---------------------------- */

  async getBalance(ctx: AdapterContext, req: GetBalanceRequest): Promise<Balance> {
    this.assertChain(req.account.chain, ctx);
    assertEvmAddress(req.account.address, this.chain.id, ctx.requestId);

    const asset = req.asset ?? { kind: 'native', chain: this.chain.id };
    if (asset.kind !== 'native') {
      // ERC-20 余额需要 eth_call；M0 未声明 contract.read（见 chains.yaml M0 条目）。
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'M0 只支持原生资产余额；代币余额需要 contract.read 能力',
        chain: this.chain.id,
        details: { capability: 'contract.read' },
      });
    }
    if (asset.chain !== this.chain.id) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'asset.chain 与请求链不一致',
        chain: this.chain.id,
      });
    }

    const blockTag = this.balanceBlockParam(req, ctx);
    const amountHex = await evmCall<string>(ctx, 'account.balance', 'eth_getBalance', [
      req.account.address,
      blockTag,
    ]);

    const balance: Balance = {
      account: req.account.address,
      asset,
      amount: hexToDecimalUint(amountHex),
      decimals: NATIVE_DECIMALS,
    };
    return balance;
  }

  /* ------------------------------ getBlock ----------------------------- */

  async getBlock(ctx: AdapterContext, ref: BlockRef): Promise<Block | null> {
    this.assertChain(ctx.chain, ctx);
    const param = this.blockParam(ref, ctx);
    const handle = await ctx.providers.acquire({ capability: 'block.read' });
    const rpc = await rpcOn<RpcBlock | null>(handle, ctx, 'eth_getBlockByNumber', [param, false]);
    if (rpc === null || rpc.hash == null || rpc.number == null) return null;

    const number = hexToDecimalUint(rpc.number);
    const block: Block = {
      chain: this.chain.id,
      number,
      hash: rpc.hash,
      observedAt: new Date().toISOString() as Iso8601,
      finality: await this.deriveFinality(ctx, handle, ref, number),
    };
    if (rpc.parentHash != null) block.parentHash = rpc.parentHash;
    if (rpc.timestamp != null) block.timestamp = hexToDecimalUint(rpc.timestamp);
    if (rpc.transactions != null) block.transactionCount = rpc.transactions.length;
    if (rpc.baseFeePerGas != null) block.baseFeePerGas = hexToDecimalUint(rpc.baseFeePerGas);
    return block;
  }

  /* --------------------------- getTransaction -------------------------- */

  async getTransaction(ctx: AdapterContext, ref: TransactionRef): Promise<Transaction | null> {
    this.assertChain(ctx.chain, ctx);
    if (ref.kind !== 'hash') {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'EVM 只支持按交易哈希查询',
        chain: this.chain.id,
      });
    }
    assertEvmTxHash(ref.hash, this.chain.id, ctx.requestId);

    const rpc = await evmCall<RpcTransaction | null>(
      ctx,
      'transaction.read',
      'eth_getTransactionByHash',
      [ref.hash],
    );
    if (rpc === null) return null;

    const transaction: Transaction = {
      schemaVersion: '1',
      ref: { kind: 'hash', hash: rpc.hash },
      chain: this.chain.id,
      // 状态是生命周期的唯一事实来源（审计修正 A-09）。
      status: rpc.blockNumber == null ? 'pending' : 'included',
      from: { chain: this.chain.id, address: rpc.from },
    };
    if (rpc.to != null) transaction.to = { chain: this.chain.id, address: rpc.to };
    if (rpc.blockNumber != null) {
      transaction.blockRef = { kind: 'number', number: hexToDecimalUint(rpc.blockNumber) };
    }
    if (rpc.value != null) transaction.value = this.nativeAmount(rpc.value);
    if (rpc.gasPrice != null && rpc.gas != null) {
      transaction.fee = this.nativeAmount(
        (BigInt(rpc.gasPrice) * BigInt(rpc.gas)).toString(10),
      );
    }
    if (rpc.nonce != null) transaction.nonce = hexToDecimalUint(rpc.nonce);
    transaction.observedAt = new Date().toISOString() as Iso8601;
    return transaction;
  }

  /** 单次确认观测；轮询/超时由 TransactionTracker 控制。 */
  async observeConfirmation(
    ctx: AdapterContext,
    req: { readonly txHash: string },
  ): Promise<ChainConfirmationObservation | null> {
    this.assertChain(ctx.chain, ctx);
    assertEvmTxHash(req.txHash, this.chain.id, ctx.requestId);
    const handle = await ctx.providers.acquire({ capability: 'transaction.read' });
    const observedChainId = await rpcOn<string>(handle, ctx, 'eth_chainId', []);
    if (this.quantity(observedChainId, 'eth_chainId', ctx) !== BigInt(this.expectedChainId(ctx))) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: 'Provider 返回的 chainId 与注册表不一致，拒绝确认交易',
        chain: this.chain.id,
        details: { expectedChainId: this.expectedChainId(ctx) },
      });
    }
    const tx = await rpcOn<RpcTransaction | null>(handle, ctx, 'eth_getTransactionByHash', [req.txHash]);
    if (tx === null) return null;
    if (typeof tx.hash !== 'string' || tx.hash.toLowerCase() !== req.txHash.toLowerCase()) return null;
    if (tx.blockNumber == null) {
      return { status: 'pending', finality: 'submitted' };
    }
    if (typeof tx.blockHash !== 'string' || !isEvmTxHash(tx.blockHash)) return null;

    // An indexed transaction alone does not establish successful execution.
    // Bind the receipt and canonical header before advancing any lifecycle.
    const receipt = await rpcOn<RpcReceipt | null>(
      handle, ctx, 'eth_getTransactionReceipt', [req.txHash],
    );
    if (receipt === null || typeof receipt.transactionHash !== 'string'
      || receipt.transactionHash.toLowerCase() !== req.txHash.toLowerCase()
      || typeof receipt.blockHash !== 'string' || !isEvmTxHash(receipt.blockHash)
      || receipt.blockHash.toLowerCase() !== tx.blockHash.toLowerCase()
      || typeof receipt.blockNumber !== 'string'
      || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber)
      || !/^0x[0-9a-f]+$/i.test(tx.blockNumber)
      || BigInt(receipt.blockNumber) !== BigInt(tx.blockNumber)
      || (receipt.status !== '0x0' && receipt.status !== '0x1')) return null;
    const canonical = await rpcOn<RpcBlock | null>(handle, ctx, 'eth_getBlockByNumber', [tx.blockNumber, false]);
    if (canonical === null || typeof canonical.hash !== 'string' || !isEvmTxHash(canonical.hash)
      || canonical.hash.toLowerCase() !== tx.blockHash.toLowerCase()
      || typeof canonical.number !== 'string' || !/^0x[0-9a-f]+$/i.test(canonical.number)
      || BigInt(canonical.number) !== BigInt(tx.blockNumber)) return null;

    const number = hexToDecimalUint(tx.blockNumber);
    const blockRef: BlockRef = { kind: 'number', number };
    const finality = await this.deriveFinality(ctx, handle, blockRef, number);
    const latest = await rpcOn<RpcBlock | null>(handle, ctx, 'eth_getBlockByNumber', ['latest', false]);
    if (typeof latest?.number !== 'string' || !/^0x[0-9a-f]+$/i.test(latest.number)
      || BigInt(latest.number) < BigInt(number)) return null;
    // Detect a reorg occurring while finality and head were being read.
    const rechecked = await rpcOn<RpcBlock | null>(handle, ctx, 'eth_getBlockByNumber', [tx.blockNumber, false]);
    if (typeof rechecked?.hash !== 'string' || rechecked.hash.toLowerCase() !== tx.blockHash.toLowerCase()
      || typeof rechecked.number !== 'string' || !/^0x[0-9a-f]+$/i.test(rechecked.number)
      || BigInt(rechecked.number) !== BigInt(number)) return null;
    const confirmations = (BigInt(latest.number) - BigInt(number) + 1n).toString(10) as DecimalUint;
    let status: ChainConfirmationObservation['status'] = 'included';
    if (receipt.status === '0x0') status = 'reverted';
    else if (finality === 'confirmed') status = 'confirmed';
    else if (finality === 'finalized') status = 'finalized';
    return {
      status,
      finality,
      blockRef,
      canonicalBlockHash: tx.blockHash,
      confirmations,
    };
  }

  async getReceipt(ctx: AdapterContext, ref: TransactionRef): Promise<Receipt | null> {
    this.assertChain(ctx.chain, ctx);
    if (ref.kind !== 'hash') return null;
    assertEvmTxHash(ref.hash, this.chain.id, ctx.requestId);

    const rpc = await evmCall<RpcReceipt | null>(
      ctx,
      'transaction.read',
      'eth_getTransactionReceipt',
      [ref.hash],
    );
    if (rpc === null) return null;

    const receipt: Receipt = {
      ref: { kind: 'hash', hash: rpc.transactionHash },
      chain: this.chain.id,
      // EVM receipt.status: "0x1" 成功，"0x0" 失败。
      success: rpc.status == null ? true : BigInt(rpc.status) === 1n,
    };
    if (rpc.blockNumber != null) {
      receipt.blockRef = { kind: 'number', number: hexToDecimalUint(rpc.blockNumber) };
    }
    if (rpc.gasUsed != null) receipt.gasUsed = hexToDecimalUint(rpc.gasUsed);
    if (rpc.effectiveGasPrice != null && rpc.gasUsed != null) {
      receipt.effectiveFee = this.nativeAmount(
        (BigInt(rpc.effectiveGasPrice) * BigInt(rpc.gasUsed)).toString(10),
      );
    }
    return receipt;
  }


  /* ---------------------------- pending nonce --------------------------- */

  /**
   * 读链上 pending nonce（DFR-M1-B07 的 nonce 协调入口）。
   *
   * 不是对外 Capability：`transaction.build` 需要一个"链上没有未确认交易时下一个
   * nonce"作为 NonceStore 租约起点，但 Gateway 不得直接路由本方法，因此它不进
   * `capabilities()`（adapter-spec 第 3 章规则 7）。
   *
   * 与 `build()` 一样：单次 `acquire()` + chainId 校验，确保 nonce 与签署链一致
   * （adapter-spec 8.1：chainId 校验与 nonce 必须来自同一句柄）。返回十进制字符串。
   */
  /**
   * EVM 的排序前提就是 pending nonce（ADR-032/033）。与 `getPendingNonce` 同源，
   * 只是包成链无关的 `SequencingToken`，让 Core/引擎用同一套路由处理两链。
   */
  async getSequencingToken(ctx: AdapterContext, account: AccountRef): Promise<SequencingToken> {
    const value = await this.getPendingNonce(ctx, account);
    return { kind: 'nonce', value };
  }

  /** 把引擎分配的 nonce 注入请求（ADR-033）；EVM 用 `req.nonce`。 */
  withSequencingToken(req: TransactionRequest, token: SequencingToken): TransactionRequest {
    if (token.kind !== 'nonce') {
      throw createDfrError('DFR_INVALID_REQUEST', {
        requestId: 'req_sequencing_token_shape' as never,
        message: 'EVM 的排序前提必须是 nonce token',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'sequencingRef' },
      });
    }
    return { ...req, nonce: token.value };
  }

  async getPendingNonce(ctx: AdapterContext, account: AccountRef): Promise<DecimalUint> {
    this.assertChain(account.chain, ctx);
    assertEvmAddress(account.address, this.chain.id, ctx.requestId);

    const handle = await ctx.providers.acquire({ capability: 'transaction.build' });
    const observedChainId = await rpcOn<string>(handle, ctx, 'eth_chainId', []);
    if (this.quantity(observedChainId, 'eth_chainId', ctx) !== BigInt(this.expectedChainId(ctx))) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: 'Provider 返回的 chainId 与注册表不一致，拒绝在其上读取 nonce',
        chain: this.chain.id,
        details: { expectedChainId: this.expectedChainId(ctx) },
      });
    }
    const hex = await rpcOn<string>(handle, ctx, 'eth_getTransactionCount', [
      account.address,
      'pending',
    ]);
    return this.quantity(hex, 'eth_getTransactionCount', ctx).toString(10) as DecimalUint;
  }

  /* ------------------------------- build ------------------------------- */

  /**
   * M1 build（DFR-M1-B02）：构造可交给外部钱包签名的未签名交易。
   *
   * 边界（见 ADR-012 / m1-api-contract.md 第 2 节 / adapter-spec 第 3 章）：
   * - **只构造**：不签名、不广播，全程只发 `safe-read` RPC，无链上副作用；
   * - nonce / gas / 费用与 chainId 校验**共用同一个 Provider 句柄**。若拆成多次
   *   `acquire()`，chainId 校验与 nonce 可能来自不同端点，校验就失去意义
   *   （adapter-spec 8.1）；同一句柄由本函数内的单次 `acquire()` 保证；
   * - `req.nonce` 显式时**不再**查询 `eth_getTransactionCount`，让上层能把 nonce
   *   租约的结果锁定进载荷（development-plan 4.3）；
   * - chainId 取自 Chain Registry，不信任请求体；与端点 `eth_chainId` 不一致时
   *   fail-closed（`DFR_CHAIN_MISMATCH`），绝不产出可能被重放的载荷；
   * - 合约创建（无 `to`）与 EIP-4844 / 7702 不在 M1 范围，显式失败；
   * - 所有链上数值以十进制字符串进出，绝不经过 JS `number`（AGENTS 红线）。
   */
  async build(ctx: AdapterContext, req: TransactionRequest): Promise<UnsignedTransaction> {
    this.assertChain(req.chain, ctx);
    this.assertChain(req.from.chain, ctx);
    assertEvmAddress(req.from.address, this.chain.id, ctx.requestId);
    if (req.to === undefined) {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'M1 build 只支持向已有地址发送交易；合约创建（缺少 to）不在范围',
        chain: this.chain.id,
        details: { capability: 'transaction.build', reason: 'contract-creation' },
      });
    }
    this.assertChain(req.to.chain, ctx);
    assertEvmAddress(req.to.address, this.chain.id, ctx.requestId);

    const chainId = this.expectedChainId(ctx);
    const value = this.transactionValue(req, ctx);
    const data = req.data ?? '0x';

    const handle = await ctx.providers.acquire({ capability: 'transaction.build' });

    // 先校验端点 chainId：后续所有读数都建立在这条链上。
    const observedChainId = await rpcOn<string>(handle, ctx, 'eth_chainId', []);
    if (this.quantity(observedChainId, 'eth_chainId', ctx) !== BigInt(chainId)) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `Provider 返回的 chainId 与注册表不一致（期望 ${chainId}）`,
        chain: this.chain.id,
        details: { expectedChainId: chainId },
      });
    }

    const [nonce, gasHex, fee] = await Promise.all([
      this.resolveNonce(handle, ctx, req),
      rpcOn<string>(handle, ctx, 'eth_estimateGas', [this.estimateGasParams(req, value)]),
      this.resolveFees(handle, ctx, req),
    ]);
    const gas = this.quantity(gasHex, 'eth_estimateGas', ctx);
    if (gas <= 0n) {
      throw this.validationFailed('gas', 'eth_estimateGas 返回非正数 gas', ctx);
    }

    const intent: EvmUnsignedIntent = {
      type: this.transactionType,
      chainId,
      nonce: nonce.toString(10),
      to: req.to.address,
      value: value.toString(10),
      gas: gas.toString(10),
      data,
      ...fee,
    };
    const encoded = this.encode(intent, ctx);

    const gasPrice = BigInt(
      encoded.type === 'eip1559' ? (fee.maxFeePerGas ?? '0') : (fee.gasPrice ?? '0'),
    );
    const meta: UnsignedTransactionMeta = {
      encoding: 'hex',
      requiresNonce: encoded.nonce,
      chainIdForSigning: encoded.chainId,
      // 费用上限：gas × 每 gas 价格上限，计价资产为原生币（Amount 携带计价资产）。
      feeEstimate: {
        asset: { kind: 'native', chain: this.chain.id },
        amount: (gas * gasPrice).toString(10) as DecimalUint,
      },
    };
    return {
      schemaVersion: '1',
      chain: this.chain.id,
      payload: encoded.payload,
      meta,
    };
  }

  /* ---------------- 未声明的能力（M1+）：显式失败，不静默降级 ---------------- */

  /**
   * 尚未落地的方法（ADR-010 M0 边界 + M1 分批评审）。
   *
   * 这些方法**不在** `capabilities()` 中；Core 的路由本应在到达这里之前就拒绝。
   * 这里仍然显式实现，是为了让直接调用 Adapter 的路径（测试、第三方集成）
   * 也得到 `DFR_UNSUPPORTED_CAPABILITY`，而不是一个 `TypeError`
   * （adapter-spec 第 6 章、第 9 章 L1）。
   */

  /* ------------------------------ simulate ----------------------------- */

  /**
   * M1 simulate（DFR-M1-B03）：用 `eth_call` + `eth_estimateGas` 归一化执行风险。
   *
   * 语义（m1-api-contract.md 第 2 节、error-spec 第 5 章）：
   * - **无副作用**：只发 `safe-read`，绝不广播、不签名；
   * - 执行回滚（transport 已映射为 `DFR_TRANSACTION_REVERTED`）**不是**异常，
   *   而是 `{ success: false, revertReason }`；状态由 Transaction Engine 落为
   *   `reverted` 并封锁广播（B05）。若把它抛成 5xx，调用方会误以为服务故障；
   * - 其它错误（Provider 不可用、超时、余额不足、nonce 冲突）继续抛出：
   *   error-spec 第 5.2 章要求"分类不确定时降级，不猜测"；
   * - 接受 `TransactionRequest`（按提供方模拟）与 `UnsignedTransaction`
   *   （按已固定载荷模拟）。载荷**不含发送方**，此时省略 `eth_call.from` 并写入
   *   `warnings`，不伪造发送方、不宣称覆盖发送方相关检查；
   * - `success` 只代表 `eth_call` 通过；`stateChanges` 需要 trace/diff RPC，
   *   M1 不实现，因此不返回（不编造）。
   */
  async simulate(
    ctx: AdapterContext,
    req: TransactionRequest | UnsignedTransaction,
    options?: SimulationOptions,
  ): Promise<SimulationResult> {
    const warnings: string[] = [];
    const payloadInput = isUnsignedTransaction(req) ? req : undefined;
    // 先做所有本地校验（不花 RPC）；两条路径的输入形状不同，分别收窄。
    let requestInput: TransactionRequest | undefined;
    if (isUnsignedTransaction(req)) {
      this.assertChain(req.chain, ctx);
    } else {
      requestInput = req;
      this.assertChain(req.chain, ctx);
      this.assertChain(req.from.chain, ctx);
      assertEvmAddress(req.from.address, this.chain.id, ctx.requestId);
      if (req.to === undefined) {
        throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
          requestId: ctx.requestId,
          message: 'M1 simulate 只支持向已有地址发送交易；合约创建（缺少 to）不在范围',
          chain: this.chain.id,
          details: { capability: 'transaction.simulate', reason: 'contract-creation' },
        });
      }
      this.assertChain(req.to.chain, ctx);
      assertEvmAddress(req.to.address, this.chain.id, ctx.requestId);
    }

    const chainId = this.expectedChainId(ctx);
    const handle = await ctx.providers.acquire({ capability: 'transaction.simulate' });
    const observedChainId = await rpcOn<string>(handle, ctx, 'eth_chainId', []);
    if (this.quantity(observedChainId, 'eth_chainId', ctx) !== BigInt(chainId)) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `Provider 返回的 chainId 与注册表不一致（期望 ${chainId}）`,
        chain: this.chain.id,
        details: { expectedChainId: chainId },
      });
    }

    const call: SimulationCall =
      payloadInput !== undefined
        ? this.simulationCallFromPayload(ctx, payloadInput, chainId, warnings, options?.from)
        : this.simulationCallFromRequest(ctx, requestInput as TransactionRequest);

    let gas = call.gas;
    if (gas === undefined) {
      const estimate = await this.readOrRevert(() =>
        rpcOn<string>(handle, ctx, 'eth_estimateGas', [this.simulationParams(call)]),
      );
      if (!estimate.ok) return this.revertedResult(estimate.reason, warnings);
      gas = this.quantity(estimate.value, 'eth_estimateGas', ctx);
    }
    if (gas <= 0n) throw this.validationFailed('gas', 'simulate 得到的 gas 必须为正数', ctx);

    const executed = await this.readOrRevert(() =>
      rpcOn<string>(handle, ctx, 'eth_call', [this.simulationParams(call, gas), 'latest']),
    );
    if (!executed.ok) return this.revertedResult(executed.reason, warnings);

    // 仅成功路径才需要费用估算（失败路径没有可通过的交易）。
    // 已构造载荷自带费用字段；请求路径才需要询问端点。
    let feePerGas = call.feePerGas;
    if (feePerGas === undefined && requestInput !== undefined) {
      const fee = await this.resolveFees(handle, ctx, requestInput);
      feePerGas = BigInt(fee.maxFeePerGas ?? fee.gasPrice ?? '0');
    }
    feePerGas ??= 0n;

    const result: SimulationResult = { success: true, estimatedCost: gas.toString(10) as DecimalUint };
    if (feePerGas > 0n) {
      result.estimatedFee = {
        asset: { kind: 'native', chain: this.chain.id },
        amount: (gas * feePerGas).toString(10) as DecimalUint,
      };
    }
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  /**
   * M1 broadcast（DFR-M1-C02）：把外部签名载荷提交给链，**恰好一次**。
   *
   * 权威来源：m1-api-contract 第 3/5 节、transaction-lifecycle §4.4、error-spec §5.1。
   *
   * 资金安全优先于功能便利，因此这里有四个刻意的选择：
   *
   * 1. **不查 `eth_chainId`**：chainId 已经密码学绑定在签名载荷里，与 Registry 的
   *    externalChainId 比较即可。多一次探测既多一次往返，也让"单次调用"变得难以证明。
   * 2. **本地校验失败一律不发出广播**：未签名载荷、链不符、`expectedHash` 与载荷重算
   *    不一致都在 acquire 之前拒绝（`DFR_TRANSACTION_REJECTED` / `DFR_CHAIN_MISMATCH`）。
   * 3. **`already known` / `already exists` 是幂等成功**，不是错误（error-spec §5.1）；
   *    这类判断必须在 Adapter 做，Provider 不能理解链语义。
   * 4. **幂等类别是 `non-idempotent-write`**：Provider Manager 因此绝不自动重试
   *    （provider-spec 第 6 章），失败也不切换 Provider 重发。
   *
   * 与记录的逐字段绑定（from / nonce / value / data 对比保存的 unsigned 载荷）由
   * TransactionEngine 在调用本方法之前完成（C03，`bindSignedTransaction`）：
   * Adapter 拿不到那条记录，也不应访问数据库。
   *
   * 端点返回的哈希必须与载荷重算一致：不一致说明端点行为异常，fail-closed 而不是
   * 报告一个可能错误的 txHash（m1-api-contract 第 3 节"txHash 由载荷重算"）。
   */
  async broadcast(
    ctx: AdapterContext,
    signed: SignedTransaction,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult> {
    this.assertChain(signed.chain, ctx);
    const chainId = this.expectedChainId(ctx);

    // --- 本地校验（不花 RPC、不 acquire） ---
    const txHash = await this.verifyBindingWithOptions(ctx, signed, chainId, options);

    // --- 单次调用 ---
    const handle = await ctx.providers.acquire({ capability: 'transaction.broadcast' });
    let returned: string;
    try {
      returned = await handle.request<string>(
        {
          method: 'eth_sendRawTransaction',
          params: [signed.signedPayload],
          // 防资金事故的核心：Provider Manager 对 non-idempotent-write 绝不重试。
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
      if (this.isAlreadyKnown(err)) return this.broadcastAccepted(ctx, handle, txHash, options);
      // 其它失败原样上抛：状态是否回退由 TransactionEngine 决定（C03），
      // Adapter 不假装成功，也不在这里重发。
      throw err;
    }

    if (
      typeof returned !== 'string' ||
      !isEvmTxHash(returned) ||
      returned.toLowerCase() !== txHash.toLowerCase()
    ) {
      throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
        requestId: ctx.requestId,
        message: '广播端点返回的交易哈希与签名载荷不一致',
        provider: handle.id,
        chain: this.chain.id,
        details: { method: 'eth_sendRawTransaction' },
      });
    }

    return this.broadcastAccepted(ctx, handle, txHash, options);
  }

  /** 广播成功（含 already-known 幂等成功）的唯一构造点。 */
  private broadcastAccepted(
    _ctx: AdapterContext,
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
   * 广播前的本地绑定校验，返回由载荷重算的交易哈希。
   *
   * 两条路径：
   * - **有记录真值**（`options.expectedFrom` + `options.expectedUnsignedPayload`，C03a）：
   *   走 `bindSignedTransaction` 做完整绑定——chainId、恢复出的 from、nonce/to/value/data/
   *   accessList 与**记录里的** unsigned 载荷逐项比对、expectedHash 比对。
   *   这是唯一能发现"换账户签同一笔"的检查，客户端回传的 unsigned 不作数。
   * - **无记录真值**：仍恢复发送方并校验签名，再校验 chainId / expectedHash，
   *   保持 C02 的行为。真实写路径必须走第一条（引擎会带上期望值）。
   *
   * 任何失败都在 `acquire()` 之前抛出，因此**不会发出广播**。
   */
  private async verifyBindingWithOptions(
    ctx: AdapterContext,
    signed: SignedTransaction,
    chainId: string,
    expectation: BroadcastOptions | undefined,
  ): Promise<string> {
    const hasFrom = expectation?.expectedFrom !== undefined;
    const hasUnsigned = expectation?.expectedUnsignedPayload !== undefined;
    if (hasFrom !== hasUnsigned) {
      // 半个真值比没有真值更危险：它会让调用方以为做了绑定校验。
      throw this.broadcastRejected(ctx, 'invalid_expectation');
    }

    if (hasFrom && hasUnsigned) {
      try {
        const binding = await bindSignedTransaction(signed.signedPayload, {
          chain: this.chain.id,
          expectedChainId: chainId as never,
          from: expectation!.expectedFrom!,
          unsignedPayload: expectation!.expectedUnsignedPayload!,
          expectedHash: signed.expectedHash,
        });
        return binding.txHash;
      } catch (err) {
        if (err instanceof EvmCodecError) {
          if (err.reason === 'chain_id_mismatch') {
            throw createDfrError('DFR_CHAIN_MISMATCH', {
              requestId: ctx.requestId,
              message: `签名载荷的 chainId 与注册表不一致（期望 ${chainId}）`,
              chain: this.chain.id,
              details: { expectedChainId: chainId },
            });
          }
          throw this.broadcastRejected(ctx, err.reason, err);
        }
        throw err;
      }
    }

    // 无记录真值：也必须完成签名恢复；没有记录时无法校验发送方归属。
    let parsed;
    try {
      parsed = await parseSignedTransaction(this.chain.id, signed.signedPayload);
    } catch (err) {
      throw this.broadcastRejected(
        ctx,
        err instanceof EvmCodecError ? err.reason : 'invalid_payload',
        err,
      );
    }
    if (parsed.chainId !== chainId) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `签名载荷的 chainId 与注册表不一致（期望 ${chainId}）`,
        chain: this.chain.id,
        details: { expectedChainId: chainId },
      });
    }
    if (signed.expectedHash.toLowerCase() !== parsed.txHash.toLowerCase()) {
      throw this.broadcastRejected(ctx, 'expected_hash_mismatch');
    }
    return parsed.txHash;
  }

  /** 广播前的本地拒绝：统一 422 `DFR_TRANSACTION_REJECTED`，不泄漏签名原文。 */
  private broadcastRejected(
    ctx: AdapterContext,
    reason: string,
    cause?: unknown,
  ): Error {
    return createDfrError('DFR_TRANSACTION_REJECTED', {
      requestId: ctx.requestId,
      message: `签名载荷未通过广播前校验（${reason}）`,
      chain: this.chain.id,
      details: { reason },
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  /** 端点是否在说"这笔交易我已经有了"（幂等成功，error-spec §5.1）。 */
  private isAlreadyKnown(err: unknown): boolean {
    if (!isDfrError(err)) return false;
    const message = `${err.chainError?.message ?? ''}`.toLowerCase();
    return ALREADY_KNOWN_PATTERNS.some((pattern) => message.includes(pattern));
  }

  /**
   * 广播后的链上观测（DFR-M1-C03b，非 Capability 的内部协调入口）。
   *
   * 只在广播结果不确定时由 Transaction Engine 调用一次。三类结果：
   *
   * - 按 `expectedHash` 查到交易：有 `blockNumber` → `included`，否则 → `pending`；
   * - 查不到：比较该账户的链上 nonce 与记录的 nonce ——
   *   链上 nonce **已越过**说明该 nonce 已被别的交易消耗 → `replaced`；
   *   否则 → `absent`（**不是** dropped：mempool 传播异步，判 dropped 留给 D03）。
   *
   * 全部只读（`safe-read`），不会重发广播。
   */
  async observeBroadcast(
    ctx: AdapterContext,
    req: BroadcastObservationRequest,
  ): Promise<BroadcastObservation> {
    this.assertChain(req.chain, ctx);
    assertEvmTxHash(req.txHash, this.chain.id, ctx.requestId);
    assertEvmAddress(req.from.address, this.chain.id, ctx.requestId);

    const handle = await ctx.providers.acquire({ capability: 'transaction.read' });
    const tx = await rpcOn<RpcTransaction | null>(
      handle,
      ctx,
      'eth_getTransactionByHash',
      [req.txHash],
    );
    if (tx !== null) {
      const blockNumber = tx.blockNumber;
      if (typeof blockNumber === 'string' && blockNumber !== null && blockNumber !== '') {
        return {
          kind: 'included',
          txHash: req.txHash,
          blockRef: { kind: 'number', number: hexToDecimalUint(blockNumber) },
          ...(typeof tx.blockHash === 'string' && tx.blockHash !== ''
            ? { canonicalBlockHash: tx.blockHash }
            : {}),
        };
      }
      return { kind: 'pending', txHash: req.txHash };
    }

    // 查不到本人交易：只有"该 nonce 已被别人消耗"才能判 replaced。
    const latestNonceHex = await rpcOn<string>(handle, ctx, 'eth_getTransactionCount', [
      req.from.address,
      'latest',
    ]);
    const latestNonce = this.quantity(latestNonceHex, 'eth_getTransactionCount', ctx);
    if (latestNonce > BigInt(req.nonce)) {
      return { kind: 'replaced', nonce: req.nonce };
    }
    return { kind: 'absent' };
  }

  /* ------------------------------ logs ------------------------------- */

  /**
   * 按区块区间查询事件日志（ADR-034，`eth_getLogs`）。
   *
   * 与 `contract.read`（`eth_call`）不同：这里返回某地址在 `[fromBlock, toBlock]`
   * 内的**事件日志**。三条硬约束：
   *   1. `fromBlock`/`toBlock` 必填；跨度超过 Adapter 的 `constraints.maxBlockRange`
   *      一律 fail-closed（不静默截断）；
   *   2. 只读（`safe-read`），单次 `acquire`、句柄复用；
   *   3. 结果是公开链上数据，但**不**写入日志/错误详情。
   */
  async logs(ctx: AdapterContext, req: ContractLogsRequest): Promise<readonly ChainLog[]> {
    this.assertChain(ctx.chain, ctx);
    if (req.address !== undefined) {
      assertEvmAddress(req.address, this.chain.id, ctx.requestId);
    }

    const from = this.numberOf(req.fromBlock, ctx, 'fromBlock');
    const to = this.numberOf(req.toBlock, ctx, 'toBlock');
    if (to < from) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: 'toBlock 不能早于 fromBlock',
        chain: this.chain.id,
        details: { fields: ['toBlock'] },
      });
    }
    const maxRange = this.maxBlockRange;
    if (to - from + 1n > BigInt(maxRange)) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: `区块跨度超过上限（maxBlockRange=${maxRange}）；请缩小区间后重试`,
        chain: this.chain.id,
        details: { maxBlockRange: maxRange, requested: (to - from + 1n).toString(10) },
      });
    }

    // `numberOf` 已保证两者都是明确的区块号（number 分支），因此可直接取字段。
    const params: Record<string, unknown> = {
      fromBlock: decimalUintToHex((req.fromBlock as { number: DecimalUint }).number),
      toBlock: decimalUintToHex((req.toBlock as { number: DecimalUint }).number),
    };
    if (req.address !== undefined) params['address'] = req.address;
    if (req.topics !== undefined) params['topics'] = req.topics;

    const handle = await ctx.providers.acquire({ capability: 'contract.logs' });
    const raw = await rpcOn<readonly RpcLog[]>(handle, ctx, 'eth_getLogs', [params]);
    const logs = raw.map((log) => this.toChainLog(log));
    return req.limit !== undefined ? logs.slice(0, req.limit) : logs;
  }

  /** `eth_getLogs` 的 RPC 日志 → 领域 `ChainLog`（只保留稳定字段）。 */
  private toChainLog(log: RpcLog): ChainLog {
    const mapped: ChainLog = {};
    if (log.address != null) mapped.address = log.address;
    if (log.topics != null) mapped.topics = log.topics;
    if (log.data != null) mapped.data = log.data;
    if (log.logIndex != null) mapped.index = hexToDecimalUint(log.logIndex);
    if (log.transactionHash != null) mapped.txHash = log.transactionHash;
    if (log.transactionIndex != null) mapped.txIndex = hexToDecimalUint(log.transactionIndex);
    if (log.blockNumber != null) {
      mapped.blockRef = { kind: 'number', number: hexToDecimalUint(log.blockNumber) };
    }
    if (log.removed != null) mapped.removed = log.removed;
    return mapped;
  }

  /** BlockRef → 十进制区块号；`hash`/`tag` 不能直接用于 getLogs 的区间（需明确的数字界）。 */
  private numberOf(ref: BlockRef, ctx: AdapterContext, field: string): bigint {
    if (ref.kind === 'number') return BigInt(ref.number);
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId: ctx.requestId,
      message: `${field} 必须是明确的区块号（number）；tag/hash 不能用于日志区间`,
      chain: this.chain.id,
      details: { fields: [field] },
    });
  }

  /* ------------------------- contract.read ------------------------- */

  /**
   * 只读合约调用（ADR-035，`eth_call`）。
   *
   * 两种输入二选一（同时给出即 fail-closed）：
   *   - `data`：预编码 calldata；
   *   - `abi` + `method`（+ `args`）：用 viem 编码，并按 outputs 解码返回。
   * 只读：单次 `acquire`、句柄复用、`safe-read`。
   */
  async readContract(ctx: AdapterContext, req: ContractReadRequest): Promise<ContractReadResult> {
    this.assertChain(ctx.chain, ctx);
    assertEvmAddress(req.contract, this.chain.id, ctx.requestId);
    const hasData = req.data !== undefined && req.data !== '';
    const hasAbi = req.abi !== undefined && req.method !== undefined;
    if (hasData === hasAbi) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: '必须且只能提供「data」或「abi+method」之一',
        chain: this.chain.id,
        details: { fields: ['data', 'abi', 'method'] },
      });
    }

    let callData: string;
    let decode: (raw: string) => unknown = () => undefined;
    let canDecode = false;
    if (hasData) {
      if (!/^0x[0-9a-fA-F]*$/u.test(req.data!)) {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId: ctx.requestId,
          message: 'data 必须是 0x 十六进制',
          chain: this.chain.id,
          details: { fields: ['data'] },
        });
      }
      callData = req.data!;
    } else {
      try {
        // human-readable 字符串需要先 parseAbi；JSON 片段直接用。
        const rawAbi = req.abi as readonly (string | object)[];
        const parsedAbi = rawAbi.some((item) => typeof item === 'string')
          ? parseAbi(rawAbi.filter((item): item is string => typeof item === 'string'))
          : (rawAbi as never);
        const abi = parsedAbi;
        const fn = getAbiItem({ abi: abi as never, name: req.method as string } as never);
        if (fn === undefined) throw new Error(`ABI 里没有方法 ${req.method}`);
        callData = encodeFunctionData({
          abi: abi as never,
          functionName: req.method!,
          args: (req.args ?? []) as never,
        } as never) as `0x${string}`;
        decode = (raw: string) =>
          decodeFunctionResult({
            abi: abi as never,
            functionName: req.method as string,
            data: raw as never,
          } as never);
        canDecode = true;
      } catch (err) {
        throw createDfrError('DFR_VALIDATION_FAILED', {
          requestId: ctx.requestId,
          message: `ABI 编码失败：${err instanceof Error ? err.message : String(err)}`,
          chain: this.chain.id,
          details: { fields: ['abi', 'method', 'args'] },
        });
      }
    }

    const blockParam = req.blockRef === undefined ? 'latest' : this.blockParam(req.blockRef, ctx);
    const handle = await ctx.providers.acquire({ capability: 'contract.read' });
    const raw = await rpcOn<string>(handle, ctx, 'eth_call', [
      { to: req.contract, data: callData },
      blockParam,
    ]);
    const result: ContractReadResult = { data: raw };
    if (canDecode) {
      try {
        // 解码结果里可能有 bigint（uint256）；HTTP/JSON 无法序列化 bigint，
        // 且本仓约定数值一律十进制字符串 → 递归归一化后再返回。
        (result as { decoded?: unknown }).decoded = normalizeDecoded(decode(raw));
      } catch {
        // 返回形状与 ABI 不符：保留原始 data，不把解码失败伪装成调用失败。
      }
    }
    return result;
  }

  /* ------------------------- account.code ------------------------- */

  /**
   * 账户存在性 / 合约判定（ADR-036，`eth_getCode` + `eth_getTransactionCount`）。
   *
   * `exists` 是**启发式**：code 非空或余额>0 或 nonce>0。对"曾经存在但已清空"的地址会判
   * `exists:false`——这是取舍，已在 ADR 与测试里显式说明。
   */
  async getAccount(ctx: AdapterContext, account: AccountRef): Promise<Account> {
    this.assertChain(account.chain, ctx);
    assertEvmAddress(account.address, this.chain.id, ctx.requestId);
    const handle = await ctx.providers.acquire({ capability: 'account.code' });
    const [code, nonceHex, balanceHex] = await Promise.all([
      rpcOn<string>(handle, ctx, 'eth_getCode', [account.address, 'latest']),
      rpcOn<string>(handle, ctx, 'eth_getTransactionCount', [account.address, 'latest']),
      rpcOn<string>(handle, ctx, 'eth_getBalance', [account.address, 'latest']),
    ]);
    const codeEmpty = code === '0x' || code === '0x0' || code === '';
    const nonce = this.quantity(nonceHex, 'eth_getTransactionCount', ctx);
    const balance = this.quantity(balanceHex, 'eth_getBalance', ctx);
    const result: Account = {
      ref: account,
      kind: codeEmpty ? 'externally-owned' : 'contract',
      exists: !codeEmpty || nonce > 0n || balance > 0n,
      nonce: nonce.toString(10) as DecimalUint,
    };
    return result;
  }

  subscribe(ctx: AdapterContext, _filter: EventFilter): AsyncIterable<ChainEvent> {
    const error = this.unsupportedError('event.subscribe', ctx);
    return {
      [Symbol.asyncIterator](): AsyncIterator<ChainEvent> {
        return {
          next: (): Promise<IteratorResult<ChainEvent>> => Promise.reject(error),
        };
      },
    };
  }

  private unsupportedError(capability: CapabilityId, ctx: AdapterContext): Error {
    return createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
      requestId: ctx.requestId,
      message: `Adapter 未启用能力 ${capability}`,
      chain: this.chain.id,
      details: { capability },
    });
  }


  /* --------------------------- build 辅助 --------------------------- */

  /** 请求的转账金额；只接受本链原生资产（代币/跨链金额缺 ABI 语义，ADR-012）。 */
  private transactionValue(req: TransactionRequest, ctx: AdapterContext): bigint {
    if (req.value === undefined) return 0n;
    const asset = req.value.asset;
    if (asset.kind !== 'native' || asset.chain !== this.chain.id) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'build 的原生金额必须使用本链原生资产',
        chain: this.chain.id,
      });
    }
    return this.decimalField(req.value.amount, 'value', ctx);
  }

  /** `eth_estimateGas` 参数；只放存在且非零的可选字段，避免给节点多余假设。 */
  private estimateGasParams(
    req: TransactionRequest,
    value: bigint,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      from: req.from.address,
      to: req.to?.address,
    };
    if (value !== 0n) params.value = decimalUintToHex(value.toString(10));
    if (req.data !== undefined && req.data !== '0x') params.data = req.data;
    return params;
  }

  /**
   * nonce 解析：显式 nonce 优先（上层已通过 NonceStore 租约锁定），否则取
   * `eth_getTransactionCount(from, "pending")`——包含内存池中已提交但未打包的交易。
   */
  private async resolveNonce(
    handle: ProviderHandle,
    ctx: AdapterContext,
    req: TransactionRequest,
  ): Promise<bigint> {
    if (req.nonce !== undefined) return this.decimalField(req.nonce, 'nonce', ctx);
    const hex = await rpcOn<string>(handle, ctx, 'eth_getTransactionCount', [
      req.from.address,
      'pending',
    ]);
    return this.quantity(hex, 'eth_getTransactionCount', ctx);
  }

  /**
   * 费用字段解析（全部返回十进制字符串，供 codec 直接使用）。
   *
   * EIP-1559：`maxFeePerGas = 2 × baseFee + tip`（有界余量，否则 baseFee 在
   * build → broadcast 之间上涨会让交易无法被打包）；`req.maxFee` 作为**每 gas
   * 价格上限**覆盖该默认值，低于 `baseFee + tip` 时 fail-closed，不静默抬高。
   *
   * legacy / eip2930：使用 `eth_gasPrice`；`req.maxFee` 作为上限，低于链上报价时失败。
   */
  private async resolveFees(
    handle: ProviderHandle,
    ctx: AdapterContext,
    req: TransactionRequest,
  ): Promise<Pick<EvmUnsignedIntent, 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'>> {
    if (this.transactionType === 'legacy' || this.transactionType === 'eip2930') {
      const networkPrice = this.quantity(
        await rpcOn<string>(handle, ctx, 'eth_gasPrice', []),
        'eth_gasPrice',
        ctx,
      );
      let gasPrice = networkPrice;
      if (req.maxFee !== undefined) {
        gasPrice = this.decimalField(req.maxFee, 'maxFee', ctx);
        if (gasPrice < networkPrice) {
          throw this.validationFailed(
            'maxFee',
            `maxFee 低于链上 eth_gasPrice（${networkPrice.toString(10)}）`,
            ctx,
          );
        }
      }
      if (gasPrice <= 0n) throw this.validationFailed('maxFee', 'gasPrice 必须为正数', ctx);
      return { gasPrice: gasPrice.toString(10) };
    }

    const [block, tip] = await Promise.all([
      rpcOn<RpcBlock | null>(handle, ctx, 'eth_getBlockByNumber', ['latest', false]),
      this.resolvePriorityFee(handle, ctx),
    ]);
    const baseFeeHex = block?.baseFeePerGas;
    if (baseFeeHex == null) {
      // pre-London 端点不会给 baseFeePerGas：这条链不支持 EIP-1559 计价。
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: '最新区块缺少 baseFeePerGas：该端点不支持 EIP-1559 计价',
        chain: this.chain.id,
        details: { capability: 'transaction.build', reason: 'no-base-fee' },
      });
    }
    const baseFee = this.quantity(baseFeeHex, 'eth_getBlockByNumber.baseFeePerGas', ctx);

    let maxFeePerGas = baseFee * 2n + tip;
    if (req.maxFee !== undefined) {
      maxFeePerGas = this.decimalField(req.maxFee, 'maxFee', ctx);
      const floor = baseFee + tip;
      if (maxFeePerGas < floor) {
        throw this.validationFailed(
          'maxFee',
          `maxFee 低于 baseFee + priorityFee（${floor.toString(10)}）`,
          ctx,
        );
      }
    }
    // codec 要求 maxPriorityFeePerGas ≤ maxFeePerGas；tip ≤ baseFee + tip ≤ maxFee 恒成立。
    return {
      maxFeePerGas: maxFeePerGas.toString(10),
      maxPriorityFeePerGas: tip.toString(10),
    };
  }

  /**
   * priority fee：优先 `eth_maxPriorityFeePerGas`；端点不支持时回退到
   * `eth_feeHistory` 的中位奖励。两者都拿不到则 fail-closed——绝不静默用 0 或常数，
   * 否则会产出一笔几乎不可能被打包的交易。
   */
  private async resolvePriorityFee(handle: ProviderHandle, ctx: AdapterContext): Promise<bigint> {
    try {
      return this.quantity(
        await rpcOn<string>(handle, ctx, 'eth_maxPriorityFeePerGas', []),
        'eth_maxPriorityFeePerGas',
        ctx,
      );
    } catch {
      const history = await rpcOn<RpcFeeHistory | null>(handle, ctx, 'eth_feeHistory', [
        '0x1',
        'latest',
        [50],
      ]).catch(() => null);
      const reward = history?.reward?.[0]?.[0];
      if (typeof reward === 'string' && /^0x[0-9a-fA-F]+$/.test(reward)) {
        return this.quantity(reward, 'eth_feeHistory.reward', ctx);
      }
      throw createDfrError('DFR_CHAIN_UNAVAILABLE', {
        requestId: ctx.requestId,
        message: '无法获得 priority fee（eth_maxPriorityFeePerGas 与 eth_feeHistory 均不可用）',
        chain: this.chain.id,
      });
    }
  }

  /** 编码意图；codec 的字段级失败统一归一化为 `DFR_VALIDATION_FAILED`（含 details.fields）。 */
  private encode(intent: EvmUnsignedIntent, ctx: AdapterContext): EvmUnsignedPayload {
    try {
      return encodeUnsignedTransaction(intent);
    } catch (err) {
      throw this.encodeFailure(err, ctx);
    }
  }

  /** codec 的字段级失败 → 统一 DFR 错误；其它异常原样抛出。 */
  private encodeFailure(err: unknown, ctx: AdapterContext): Error {
    if (err instanceof EvmCodecError) {
      return createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: `交易载荷字段非法（${err.reason}）`,
        chain: this.chain.id,
        details: {
          reason: err.reason,
          ...(err.field !== undefined ? { fields: [err.field] } : {}),
        },
        cause: err,
      });
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /* -------------------------- simulate 辅助 -------------------------- */

  /** 已构造载荷 → 调用意图；载荷不含发送方，必须写入 warning（不伪造 from）。 */
  private simulationCallFromPayload(
    ctx: AdapterContext,
    unsigned: UnsignedTransaction,
    chainId: string,
    warnings: string[],
    from?: AccountRef,
  ): SimulationCall {
    let decoded;
    try {
      decoded = decodeTransactionPayload(unsigned.payload);
    } catch (err) {
      throw this.encodeFailure(err, ctx);
    }
    if (decoded.chainId !== null && BigInt(decoded.chainId) !== BigInt(chainId)) {
      throw this.validationFailed(
        'payload',
        `载荷 chainId ${decoded.chainId} 与请求链 ${chainId} 不一致`,
        ctx,
      );
    }
    if (decoded.to === null) {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: '合约创建载荷不在 M1 范围（载荷 to 为空）',
        chain: this.chain.id,
        details: { capability: 'transaction.simulate', reason: 'contract-creation' },
      });
    }
    // 调用方（composition root / Transaction Engine）持有记录，知道发送方时会显式传入；
    // 只有真正不知道发送方时才退化为"节点默认 from"，并如实写进 warnings。
    if (from !== undefined) {
      this.assertChain(from.chain, ctx);
      assertEvmAddress(from.address, this.chain.id, ctx.requestId);
    } else {
      warnings.push(
        'unsigned 载荷不含发送方：本次模拟使用节点默认发送方，发送方相关检查（余额、授权、nonce）未被覆盖；请用 TransactionRequest 形式模拟以覆盖发送方',
      );
    }
    const feePerGas = decoded.maxFeePerGas ?? decoded.gasPrice;
    return {
      ...(from !== undefined ? { from: from.address } : {}),
      to: decoded.to,
      value: BigInt(decoded.value),
      data: decoded.data,
      gas: BigInt(decoded.gas),
      ...(feePerGas !== undefined ? { feePerGas: BigInt(feePerGas) } : {}),
    };
  }

  /** 请求 → 调用意图。费用在成功后才解析，避免为回滚请求白花读数。 */
  private simulationCallFromRequest(ctx: AdapterContext, req: TransactionRequest): SimulationCall {
    return {
      from: req.from.address,
      to: req.to?.address as string,
      value: this.transactionValue(req, ctx),
      data: req.data ?? '0x',
    };
  }

  /** `eth_call` / `eth_estimateGas` 参数；缺省字段不出现，避免给节点多余假设。 */
  private simulationParams(call: SimulationCall, gas?: bigint): Record<string, unknown> {
    const params: Record<string, unknown> = { to: call.to };
    if (call.from !== undefined) params.from = call.from;
    if (call.value !== 0n) params.value = decimalUintToHex(call.value.toString(10));
    if (call.data !== '0x') params.data = call.data;
    const limit = gas ?? call.gas;
    if (limit !== undefined) params.gas = decimalUintToHex(limit.toString(10));
    return params;
  }

  /**
   * 执行一次可能回滚的读调用。
   *
   * 回滚（transport 映射的 `DFR_TRANSACTION_REVERTED`）是**预期结果**，转成
   * `{ ok: false, reason }`；其它错误原样抛出，不吞掉 Provider 故障。
   */
  private async readOrRevert<T>(
    run: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    try {
      return { ok: true, value: await run() };
    } catch (err) {
      if (isDfrError(err) && err.code === 'DFR_TRANSACTION_REVERTED') {
        return { ok: false, reason: err.chainError?.message ?? err.message };
      }
      throw err;
    }
  }

  private revertedResult(reason: string, warnings: readonly string[]): SimulationResult {
    const result: SimulationResult = { success: false, revertReason: reason };
    if (warnings.length > 0) result.warnings = [...warnings];
    return result;
  }

  /** 十进制字符串解析（AGENTS 红线：链上数值不得经过 JS number）。 */
  private decimalField(value: unknown, field: string, ctx: AdapterContext): bigint {
    if (typeof value !== 'string' || !DECIMAL_UINT_RE.test(value)) {
      throw this.validationFailed(
        field,
        `${field} 必须是规范十进制字符串（无前导零、无符号、无小数）`,
        ctx,
      );
    }
    return BigInt(value);
  }

  /**
   * 十六进制数量（`0x…`）→ bigint。
   *
   * Provider 只校验 JSON-RPC 响应的**形状**（存在 result），不校验数值编码；
   * 端点返回 `"0x"` / `"not-a-number"` 时若直接 `BigInt()` 会抛出 TypeError，
   * 变成 500 内部错误。这里统一归一化为 `DFR_PROVIDER_INVALID_RESPONSE`（fail-closed）。
   */
  private quantity(value: unknown, label: string, ctx: AdapterContext): bigint {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
        requestId: ctx.requestId,
        message: `Provider 返回的 ${label} 不是合法的十六进制数量`,
        chain: this.chain.id,
      });
    }
    return BigInt(value);
  }

  private validationFailed(field: string, message: string, ctx: AdapterContext): Error {
    return createDfrError('DFR_VALIDATION_FAILED', {
      requestId: ctx.requestId,
      message,
      chain: this.chain.id,
      details: { fields: [field] },
    });
  }

  /* ------------------------------ helpers ------------------------------ */

  private expectedChainId(ctx: AdapterContext): string {
    const expected = this.chain.externalChainId;
    if (expected === undefined) {
      throw createDfrError('DFR_CONFIGURATION_ERROR', {
        requestId: ctx.requestId,
        message: `链 ${this.chain.id} 缺少 externalChainId，无法校验 EVM chainId`,
      });
    }
    return expected;
  }

  private assertChain(chain: ChainId, ctx: AdapterContext): void {
    if (chain !== this.chain.id) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `Adapter 绑定 ${this.chain.id}，收到 ${chain}`,
        chain,
      });
    }
  }

  /** BlockRef → JSON-RPC 参数；不支持的分支显式失败，不静默降级（adapter-spec 第 9 章）。 */
  private blockParam(ref: BlockRef, ctx: AdapterContext): string {
    switch (ref.kind) {
      case 'number':
        return decimalUintToHex(ref.number);
      case 'hash':
        return ref.hash;
      case 'tag':
        // EVM 不认 'safe' 以外的自定义 commitment；tag 直接透传。
        return ref.tag;
      case 'slot':
        throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
          requestId: ctx.requestId,
          message: 'EVM 不支持 slot 引用',
          chain: this.chain.id,
        });
      default:
        throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
          requestId: ctx.requestId,
          message: '无法识别的 BlockRef 分支',
          chain: this.chain.id,
        });
    }
  }

  /** 依据 Chain Registry 的 FinalityPolicy 推导观测到的最终性。 */
  private async deriveFinality(
    ctx: AdapterContext,
    handle: ProviderHandle,
    ref: BlockRef,
    number: DecimalUint,
  ): Promise<FinalityState> {
    if (ref.kind === 'tag') {
      if (ref.tag === 'finalized') return 'finalized';
      if (ref.tag === 'safe') return 'confirmed';
      return 'included';
    }
    const policy: FinalityPolicy = this.chain.finality;
    if (policy.kind === 'checkpoint') {
      const finalized = await rpcOn<RpcBlock | null>(
        handle,
        ctx,
        'eth_getBlockByNumber',
        ['finalized', false],
      ).catch(() => null);
      if (finalized?.number != null && ref.kind === 'number') {
        return BigInt(number) <= BigInt(finalized.number) ? 'finalized' : 'included';
      }
      return 'included';
    }
    if (policy.kind === 'confirmations') {
      const latest = await rpcOn<RpcBlock | null>(
        handle,
        ctx,
        'eth_getBlockByNumber',
        ['latest', false],
      ).catch(() => null);
      if (latest?.number != null && ref.kind === 'number') {
        const depth = BigInt(latest.number) - BigInt(number) + 1n;
        return depth >= BigInt(policy.confirmations) ? 'confirmed' : 'included';
      }
      return 'included';
    }
    return 'included';
  }

  private nativeAmount(amount: string): Amount {
    const asset: AssetRef = { kind: 'native', chain: this.chain.id };
    return { asset, amount: (BigInt(amount)).toString(10) as DecimalUint };
  }

  /**
   * 一致性提示 → 余额查询的区块参数。
   *
   * `at-block` 必须带 blockRef；缺失时显式失败，不静默退回 latest
   * （domain-model 第 6 章：不支持时返回 DFR_UNSUPPORTED_CAPABILITY，不得静默忽略）。
   */
  private balanceBlockParam(req: GetBalanceRequest, ctx: AdapterContext): string {
    const consistency = req.consistency;
    if (consistency === undefined || consistency.mode === 'best-effort') return 'latest';
    if (consistency.mode === 'finalized') return 'finalized';
    if (consistency.blockRef === undefined) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: 'consistency=at-block 时必须提供 blockRef',
        chain: this.chain.id,
        details: { fields: ['blockRef'] },
      });
    }
    return this.blockParam(consistency.blockRef, ctx);
  }
}

/** 把 viem 解码结果里的 bigint 递归转成十进制字符串（HTTP/JSON 安全，符合禁 number 契约）。 */
function normalizeDecoded(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map((v) => normalizeDecoded(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeDecoded(v);
    return out;
  }
  return value;
}

