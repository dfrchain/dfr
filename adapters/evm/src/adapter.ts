/**
 * EVM Adapter (DFR-008, M0 read-only).
 *
 * Scope (see ADR-010): getInfo / getBalance / getBlock / getTransaction / getReceipt.
 * No signing, no broadcast, no private-key custody; build / simulate / broadcast belong to M1,
 * so this Adapter does not declare those capabilities, and related requests return DFR_UNSUPPORTED_CAPABILITY.
 *
 * The Adapter holds no endpoints or credentials: all chain access goes through `ctx.providers.acquire()`.
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

/** Native-asset precision is fixed at 18 (ETH / each EVM L2 native coin). */
const NATIVE_DECIMALS = 18;

/**
 * Broadcast timeout (M1-C02).
 *
 * Slightly longer than the 10s read timeout: broadcast queuing / mempool entry at the endpoint takes longer than an ordinary query.
 * A timeout is **not a failure** (m1-api-contract Section 5): C03 queries by expectedHash and then
 * classifies it as included / unknown, never resending automatically.
 */
const BROADCAST_TIMEOUT_MS = 15_000;

/**
 * Message patterns for when an endpoint expresses "I already have this transaction" as a JSON-RPC error.
 *
 * This lives in the Adapter, not the Provider: the Provider only transports and does not understand chain semantics (AGENTS.md Section 3).
 * The upstream message is already placed in `chainError.message` by the Provider (after redaction); only classification happens here.
 */
const ALREADY_KNOWN_PATTERNS = [
  'already known',
  'already exists',
  'already imported',
  'known transaction',
] as const;

/** M0 read-only capability set (matches the M0 entries in chains.yaml; registry ⊆ adapter). */
export const EVM_M0_CAPABILITIES: readonly CapabilityId[] = [
  'account.balance',
  'block.read',
  'transaction.read',
];

/**
 * The capability set the Adapter **currently implements** (capability ground truth, adapter-spec Chapter 3 rule 7).
 *
 * Capabilities may only be added: B02 adds `transaction.build`; later work landing simulate /
 * broadcast appends here. The registry (chains.yaml) is an "allowlist" that must be a subset of this set;
 * the reverse does not hold — so this set may exist before the M1 entries in chains.yaml.
 */
export const EVM_IMPLEMENTED_CAPABILITIES: readonly CapabilityId[] = [
  ...EVM_M0_CAPABILITIES,
  'transaction.build',
  'transaction.simulate',
  // M1-C02: single broadcast call. M1-C05 (Gateway endpoint) and C03 (engine state stream) are the places that
  // expose the write path publicly; the capability ground truth is here, while whether the Registry enables it is separate (registry ⊆ adapter).
  'transaction.broadcast',
  // ADR-034: event log queries (BEX on-chain reconciliation). Alongside contract.read (eth_call).
  'contract.logs',
  // ADR-035: read-only contract calls (eth_call).
  'contract.read',
  // ADR-036: account existence / contract determination (eth_getCode).
  'account.code',
];

/** Conservative default span for `eth_getLogs` (ADR-034); overridable per chain with `maxBlockRange`. */
const DEFAULT_MAX_BLOCK_RANGE = '2000' as DecimalUint;

/** Transaction types allowed by M1 build (ADR-016 §5). */
const SUPPORTED_TRANSACTION_TYPES: readonly EvmTransactionType[] = [
  'legacy',
  'eip2930',
  'eip1559',
];

/** Canonical decimal: no leading zeros (except `0`), no sign, no fraction. */
const DECIMAL_UINT_RE = /^(?:0|[1-9][0-9]*)$/;

/** Distinguish the two simulate inputs (the payload path has no sender, so it must be called out explicitly). */
function isUnsignedTransaction(
  value: TransactionRequest | UnsignedTransaction,
): value is UnsignedTransaction {
  return 'payload' in value;
}

/** Call intent after simulate normalization. */
interface SimulationCall {
  /** Sender; unknown when no payload has been built (never fabricated). */
  readonly from?: string;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  /** Gas limit fixed by the constructed payload; derived via estimateGas when unknown on the request path. */
  readonly gas?: bigint;
  /** Per-gas price cap, used to estimate fees. */
  readonly feePerGas?: bigint;
}

export interface EvmAdapterOptions {
  /** The chain this Adapter instance is bound to; `externalChainId` is used for the eth_chainId consistency check. */
  chain: Chain;
  /** Adapter implementation version (semver). */
  version?: string;
  /**
   * Transaction type produced by build; defaults to `eip1559`.
   *
   * Only affects build's encoding and fee-fetching method; the parse path (codec) supports all three types.
   */
  transactionType?: EvmTransactionType;
  /**
   * Maximum block span allowed for a single `eth_getLogs` (ADER-034), as a decimal string.
   *
   * When omitted, a **conservative** default applies (see `DEFAULT_MAX_BLOCK_RANGE`); pass explicitly to calibrate per chain.
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
        message: `Unsupported transaction type "${String(type)}"; M1 only supports legacy / eip2930 / eip1559`,
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

    // Reuse the same Provider handle: the chainId check is only meaningful when the height/block comes from the same endpoint.
    const handle = await ctx.providers.acquire({ capability: 'block.read' });
    const [chainIdHex, heightHex, block, nodeVersion] = await Promise.all([
      rpcOn<string>(handle, ctx, 'eth_chainId', []),
      rpcOn<string>(handle, ctx, 'eth_blockNumber', []),
      rpcOn<RpcBlock | null>(handle, ctx, 'eth_getBlockByNumber', ['latest', false]),
      rpcOn<string>(handle, ctx, 'web3_clientVersion', []).catch(() => undefined),
    ]);

    // fail-closed: a chain ID mismatch means the endpoint points at the wrong network (adapter-spec 8.1).
    if (BigInt(chainIdHex) !== BigInt(expected)) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `Provider returned a chainId inconsistent with the registry (expected ${expected})`,
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
      // ERC-20 balances need eth_call; M0 does not declare contract.read (see the chains.yaml M0 entries).
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'M0 only supports native-asset balances; token balances need the contract.read capability',
        chain: this.chain.id,
        details: { capability: 'contract.read' },
      });
    }
    if (asset.chain !== this.chain.id) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'asset.chain does not match the requested chain',
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
        message: 'EVM only supports querying by transaction hash',
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
      // State is the only source of truth for the lifecycle (audit fix A-09).
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

  /** A single confirmation observation; polling/timeout is controlled by TransactionTracker. */
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
        message: 'Provider returned a chainId inconsistent with the registry; refusing to confirm the transaction',
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
      // EVM receipt.status: "0x1" success, "0x0" failure.
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
   * Read the on-chain pending nonce (the nonce-coordination entry point for DFR-M1-B07).
   *
   * Not a public Capability: `transaction.build` needs a "next nonce when there are no unconfirmed transactions on-chain"
   * nonce as the NonceStore lease starting point, but the Gateway must not route this method directly, so it does not enter
   * `capabilities()` (adapter-spec Chapter 3 rule 7).
   *
   * Like `build()`: a single `acquire()` + chainId check, ensuring the nonce matches the signing chain
   * (adapter-spec 8.1: the chainId check and the nonce must come from the same handle). Returns a decimal string.
   */
  /**
   * The EVM sequencing prerequisite is the pending nonce (ADR-032/033). It shares its origin with `getPendingNonce`,
   * just wrapped as a chain-agnostic `SequencingToken` so Core/the engine routes both chains the same way.
   */
  async getSequencingToken(ctx: AdapterContext, account: AccountRef): Promise<SequencingToken> {
    const value = await this.getPendingNonce(ctx, account);
    return { kind: 'nonce', value };
  }

  /** Inject the engine-assigned nonce into the request (ADR-033); EVM uses `req.nonce`. */
  withSequencingToken(req: TransactionRequest, token: SequencingToken): TransactionRequest {
    if (token.kind !== 'nonce') {
      throw createDfrError('DFR_INVALID_REQUEST', {
        requestId: 'req_sequencing_token_shape' as never,
        message: 'EVM sequencing prerequisite must be a nonce token',
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
        message: 'Provider returned a chainId inconsistent with the registry; refusing to read a nonce from it',
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
   * M1 build (DFR-M1-B02): construct an unsigned transaction for an external wallet to sign.
   *
   * Boundaries (see ADR-012 / m1-api-contract.md Section 2 / adapter-spec Chapter 3):
   * - **Construct only**: no signing, no broadcast; only `safe-read` RPCs throughout, no on-chain side effects;
   * - nonce / gas / fees and the chainId check **share one Provider handle**. Splitting them into multiple
   *   `acquire()` calls could put the chainId check and the nonce on different endpoints, making the check meaningless
   *   (adapter-spec 8.1); a single handle is guaranteed by the one `acquire()` inside this function;
   * - When `req.nonce` is explicit, `eth_getTransactionCount` is **no longer** queried, letting the upper layer lock the nonce
   *   lease result into the payload (development-plan 4.3);
   * - chainId comes from the Chain Registry, never trusting the request body; a mismatch with the endpoint's `eth_chainId`
   *   fails closed (`DFR_CHAIN_MISMATCH`), never producing a payload that could be replayed;
   * - Contract creation (no `to`) and EIP-4844 / 7702 are out of M1 scope; fail explicitly;
   * - All on-chain values enter and leave as decimal strings, never via JS `number` (AGENTS red line).
   */
  async build(ctx: AdapterContext, req: TransactionRequest): Promise<UnsignedTransaction> {
    this.assertChain(req.chain, ctx);
    this.assertChain(req.from.chain, ctx);
    assertEvmAddress(req.from.address, this.chain.id, ctx.requestId);
    if (req.to === undefined) {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'M1 build only supports sending transactions to existing addresses; contract creation (missing to) is out of scope',
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

    // Check the endpoint chainId first: all subsequent reads build on this chain.
    const observedChainId = await rpcOn<string>(handle, ctx, 'eth_chainId', []);
    if (this.quantity(observedChainId, 'eth_chainId', ctx) !== BigInt(chainId)) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `Provider returned a chainId inconsistent with the registry (expected ${chainId})`,
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
      throw this.validationFailed('gas', 'eth_estimateGas returned non-positive gas', ctx);
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
      // Fee cap: gas × per-gas price cap, priced in the native coin (Amount carries the pricing asset).
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

  /* ---------------- Undeclared capabilities (M1+): fail explicitly, no silent downgrade ---------------- */

  /**
   * Methods not yet landed (ADR-010 M0 boundary + M1 staged review).
   *
   * These methods are **not** in `capabilities()`; Core's routing should have rejected them before reaching here.
   * They are still implemented explicitly so that paths calling the Adapter directly (tests, third-party integrations)
   * also get `DFR_UNSUPPORTED_CAPABILITY` instead of a `TypeError`
   * (adapter-spec Chapters 6 and 9 L1).
   */

  /* ------------------------------ simulate ----------------------------- */

  /**
   * M1 simulate (DFR-M1-B03): normalize execution risk with `eth_call` + `eth_estimateGas`.
   *
   * Semantics (m1-api-contract.md Section 2, error-spec Chapter 5):
   * - **No side effects**: only `safe-read` is sent; never broadcast, never sign;
   * - An execution revert (already mapped by transport to `DFR_TRANSACTION_REVERTED`) is **not** an exception,
   *   but `{ success: false, revertReason }`; the Transaction Engine records the state as
   *   `reverted` and blocks broadcast (B05). Throwing it as 5xx would make callers think the service is down;
   * - Other errors (Provider unavailable, timeout, insufficient balance, nonce conflict) keep throwing:
   *   error-spec Section 5.2 requires "downgrade when the classification is uncertain; do not guess";
   * - Accepts `TransactionRequest` (simulate as provided) and `UnsignedTransaction`
   *   (simulating against a fixed payload). The payload **has no sender**, so `eth_call.from` is omitted and a
   *   `warnings` entry is written instead — never fabricate a sender, never claim sender-related checks are covered;
   * - `success` only means `eth_call` passed; `stateChanges` needs trace/diff RPC,
   *   which M1 does not implement, so it is not returned (nothing is fabricated).
   */
  async simulate(
    ctx: AdapterContext,
    req: TransactionRequest | UnsignedTransaction,
    options?: SimulationOptions,
  ): Promise<SimulationResult> {
    const warnings: string[] = [];
    const payloadInput = isUnsignedTransaction(req) ? req : undefined;
    // Do all local validation first (no RPC spent); the two paths have different input shapes, narrowed separately.
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
          message: 'M1 simulate only supports sending transactions to existing addresses; contract creation (missing to) is out of scope',
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
        message: `Provider returned a chainId inconsistent with the registry (expected ${chainId})`,
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
    if (gas <= 0n) throw this.validationFailed('gas', 'simulate returned gas that must be positive', ctx);

    const executed = await this.readOrRevert(() =>
      rpcOn<string>(handle, ctx, 'eth_call', [this.simulationParams(call, gas), 'latest']),
    );
    if (!executed.ok) return this.revertedResult(executed.reason, warnings);

    // Only the success path needs a fee estimate (the failure path has no passable transaction).
    // A constructed payload carries its own fee fields; only the request path needs to ask the endpoint.
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
   * M1 broadcast (DFR-M1-C02): submit an externally signed payload to the chain, **exactly once**.
   *
   * Authoritative sources: m1-api-contract Sections 3/5, transaction-lifecycle §4.4, error-spec §5.1.
   *
   * Fund safety outranks convenience, so there are four deliberate choices here:
   *
   * 1. **Do not query `eth_chainId`**: the chainId is already cryptographically bound in the signed payload; comparing it with the Registry's
   *    externalChainId is enough. One more probe is one more round trip and makes "a single call" harder to prove.
   * 2. **Failed local validation never sends a broadcast**: unsigned payloads, chain mismatches, and `expectedHash` vs. recomputed-payload
   *    mismatches are all rejected before acquire (`DFR_TRANSACTION_REJECTED` / `DFR_CHAIN_MISMATCH`).
   * 3. **`already known` / `already exists` are idempotent successes**, not errors (error-spec §5.1);
   *    this classification must happen in the Adapter; the Provider cannot understand chain semantics.
   * 4. **The idempotency class is `non-idempotent-write`**: the Provider Manager therefore never retries automatically
   *    (provider-spec Chapter 6), and failures never switch Provider and resend.
   *
   * Field-by-field binding against the record (from / nonce / value / data vs. the saved unsigned payload) is done by
   * TransactionEngine before calling this method (C03, `bindSignedTransaction`):
   * the Adapter cannot reach that record, nor should it access the database.
   *
   * The hash returned by the endpoint must match the recomputed payload hash: a mismatch means abnormal endpoint behavior, so fail closed instead of
   * reporting a possibly wrong txHash (m1-api-contract Section 3, "txHash is recomputed from the payload").
   */
  async broadcast(
    ctx: AdapterContext,
    signed: SignedTransaction,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult> {
    this.assertChain(signed.chain, ctx);
    const chainId = this.expectedChainId(ctx);

    // --- Local validation (no RPC, no acquire) ---
    const txHash = await this.verifyBindingWithOptions(ctx, signed, chainId, options);

    // --- Single call ---
    const handle = await ctx.providers.acquire({ capability: 'transaction.broadcast' });
    let returned: string;
    try {
      returned = await handle.request<string>(
        {
          method: 'eth_sendRawTransaction',
          params: [signed.signedPayload],
          // The core fund-safety guard: the Provider Manager never retries non-idempotent-write.
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
      // Other failures are rethrown as-is: TransactionEngine decides whether state rolls back (C03);
      // the Adapter neither pretends success nor resends here.
      throw err;
    }

    if (
      typeof returned !== 'string' ||
      !isEvmTxHash(returned) ||
      returned.toLowerCase() !== txHash.toLowerCase()
    ) {
      throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
        requestId: ctx.requestId,
        message: 'broadcast endpoint returned a transaction hash inconsistent with the signed payload',
        provider: handle.id,
        chain: this.chain.id,
        details: { method: 'eth_sendRawTransaction' },
      });
    }

    return this.broadcastAccepted(ctx, handle, txHash, options);
  }

  /** The single construction point for broadcast success (including already-known idempotent success). */
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
   * Pre-broadcast local binding verification, returning the transaction hash recomputed from the payload.
   *
   * Two paths:
   * - **With recorded ground truth** (`options.expectedFrom` + `options.expectedUnsignedPayload`, C03a):
   *   go through `bindSignedTransaction` for the full binding — chainId, the recovered from, nonce/to/value/data/
   *   accessList compared item by item against the **recorded** unsigned payload, plus an expectedHash comparison.
   *   This is the only check that catches "a different account signing the same transaction"; a client-returned unsigned payload does not count.
   * - **No recorded ground truth**: still recover the sender and verify the signature, then verify chainId / expectedHash,
   *   keeping C02's behavior. The real write path must take the first route (the engine passes the expected values).
   *
   * Any failure is thrown before `acquire()`, so **no broadcast is sent**.
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
      // Half a ground truth is more dangerous than none: it makes callers think binding verification happened.
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
              message: `signed payload chainId is inconsistent with the registry (expected ${chainId})`,
              chain: this.chain.id,
              details: { expectedChainId: chainId },
            });
          }
          throw this.broadcastRejected(ctx, err.reason, err);
        }
        throw err;
      }
    }

    // No recorded ground truth: signature recovery must still complete; with no record, sender ownership cannot be verified.
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
        message: `signed payload chainId is inconsistent with the registry (expected ${chainId})`,
        chain: this.chain.id,
        details: { expectedChainId: chainId },
      });
    }
    if (signed.expectedHash.toLowerCase() !== parsed.txHash.toLowerCase()) {
      throw this.broadcastRejected(ctx, 'expected_hash_mismatch');
    }
    return parsed.txHash;
  }

  /** Pre-broadcast local rejection: uniform 422 `DFR_TRANSACTION_REJECTED`, without leaking the raw signature. */
  private broadcastRejected(
    ctx: AdapterContext,
    reason: string,
    cause?: unknown,
  ): Error {
    return createDfrError('DFR_TRANSACTION_REJECTED', {
      requestId: ctx.requestId,
      message: `signed payload failed pre-broadcast validation (${reason})`,
      chain: this.chain.id,
      details: { reason },
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  /** Whether the endpoint is saying "I already have this transaction" (idempotent success, error-spec §5.1). */
  private isAlreadyKnown(err: unknown): boolean {
    if (!isDfrError(err)) return false;
    const message = `${err.chainError?.message ?? ''}`.toLowerCase();
    return ALREADY_KNOWN_PATTERNS.some((pattern) => message.includes(pattern));
  }

  /**
   * Post-broadcast on-chain observation (DFR-M1-C03b, a non-Capability internal coordination entry point).
   *
   * Called once by the Transaction Engine, only when the broadcast result is uncertain. Three outcomes:
   *
   * - Transaction found by `expectedHash`: with `blockNumber` → `included`, otherwise → `pending`;
   * - Not found: compare the account's on-chain nonce with the recorded nonce —
   *   an on-chain nonce that has **already passed** means that nonce was consumed by another transaction → `replaced`;
   *   otherwise → `absent` (**not** dropped: mempool propagation is asynchronous; judging dropped is left to D03).
   *
   * All read-only (`safe-read`); no broadcast is resent.
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

    // Own transaction not found: only "that nonce was consumed by someone else" justifies replaced.
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
   * Query event logs by block range (ADR-034, `eth_getLogs`).
   *
   * Unlike `contract.read` (`eth_call`), this returns the **event logs** of an address within `[fromBlock, toBlock]`
   * Three hard constraints:
   *   1. `fromBlock`/`toBlock` are required; a span exceeding the Adapter's `constraints.maxBlockRange`
   *      always fails closed (no silent truncation);
   *   2. Read-only (`safe-read`), single `acquire`, handle reuse;
   *   3. Results are public on-chain data, but are **not** written into logs/error details.
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
        message: 'toBlock must not be earlier than fromBlock',
        chain: this.chain.id,
        details: { fields: ['toBlock'] },
      });
    }
    const maxRange = this.maxBlockRange;
    if (to - from + 1n > BigInt(maxRange)) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: `Block range exceeds the limit (maxBlockRange=${maxRange}); narrow the range and retry`,
        chain: this.chain.id,
        details: { maxBlockRange: maxRange, requested: (to - from + 1n).toString(10) },
      });
    }

    // `numberOf` already guarantees both are explicit block numbers (the number branch), so the fields can be read directly.
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

  /** `eth_getLogs` RPC logs → domain `ChainLog` (only stable fields kept). */
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

  /** BlockRef → decimal block number; `hash`/`tag` cannot be used directly for a getLogs range (explicit numeric bounds are needed). */
  private numberOf(ref: BlockRef, ctx: AdapterContext, field: string): bigint {
    if (ref.kind === 'number') return BigInt(ref.number);
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId: ctx.requestId,
      message: `${field} must be an explicit block number (number); tag/hash cannot be used for a log range`,
      chain: this.chain.id,
      details: { fields: [field] },
    });
  }

  /* ------------------------- contract.read ------------------------- */

  /**
   * Read-only contract calls (ADR-035, `eth_call`).
   *
   * Two inputs, choose one (giving both fails closed):
   *   - `data`: pre-encoded calldata;
   *   - `abi` + `method` (+ `args`): encode with viem and decode the outputs for the return value.
   * Read-only: single `acquire`, handle reuse, `safe-read`.
   */
  async readContract(ctx: AdapterContext, req: ContractReadRequest): Promise<ContractReadResult> {
    this.assertChain(ctx.chain, ctx);
    assertEvmAddress(req.contract, this.chain.id, ctx.requestId);
    const hasData = req.data !== undefined && req.data !== '';
    const hasAbi = req.abi !== undefined && req.method !== undefined;
    if (hasData === hasAbi) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: 'must provide exactly one of "data" or "abi+method"',
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
          message: 'data must be 0x hex',
          chain: this.chain.id,
          details: { fields: ['data'] },
        });
      }
      callData = req.data!;
    } else {
      try {
        // Human-readable strings need parseAbi first; JSON fragments are used directly.
        const rawAbi = req.abi as readonly (string | object)[];
        const parsedAbi = rawAbi.some((item) => typeof item === 'string')
          ? parseAbi(rawAbi.filter((item): item is string => typeof item === 'string'))
          : (rawAbi as never);
        const abi = parsedAbi;
        const fn = getAbiItem({ abi: abi as never, name: req.method as string } as never);
        if (fn === undefined) throw new Error(`ABI has no method ${req.method}`);
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
          message: `ABI encoding failed: ${err instanceof Error ? err.message : String(err)}`,
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
        // Decoded results may contain bigint (uint256); HTTP/JSON cannot serialize bigint,
        // and this repo requires all values as decimal strings → normalize recursively before returning.
        (result as { decoded?: unknown }).decoded = normalizeDecoded(decode(raw));
      } catch {
        // Return shape does not match the ABI: keep the original data; do not disguise a decode failure as a call failure.
      }
    }
    return result;
  }

  /* ------------------------- account.code ------------------------- */

  /**
   * Account existence / contract determination (ADR-036, `eth_getCode` + `eth_getTransactionCount`).
   *
   * `exists` is a **heuristic**: non-empty code, balance > 0, or nonce > 0. An address that "once existed but has been emptied" is judged
   * `exists:false` — this is a trade-off, stated explicitly in the ADR and tests.
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
      message: `Adapter has not enabled capability ${capability}`,
      chain: this.chain.id,
      details: { capability },
    });
  }


  /* --------------------------- build helpers --------------------------- */

  /** Requested transfer amount; only this chain's native asset is accepted (token/cross-chain amounts lack ABI semantics, ADR-012). */
  private transactionValue(req: TransactionRequest, ctx: AdapterContext): bigint {
    if (req.value === undefined) return 0n;
    const asset = req.value.asset;
    if (asset.kind !== 'native' || asset.chain !== this.chain.id) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'build native amounts must use this chain\'s native asset',
        chain: this.chain.id,
      });
    }
    return this.decimalField(req.value.amount, 'value', ctx);
  }

  /** `eth_estimateGas` parameters; only include optional fields that exist and are non-zero, to avoid giving the node extra assumptions. */
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
   * Nonce resolution: an explicit nonce wins (the upper layer already locked it via a NonceStore lease); otherwise fetch
   * `eth_getTransactionCount(from, "pending")` — including mempool transactions already submitted but not yet packaged.
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
   * Fee-field parsing (all returned as decimal strings, for direct codec use).
   *
   * EIP-1559: `maxFeePerGas = 2 × baseFee + tip` (bounded margin; otherwise a baseFee rise between
   * build → broadcast would leave the transaction unpackable); `req.maxFee` acts as the **per-gas
   * price cap** overriding that default; below `baseFee + tip` it fails closed, never silently raising it.
   *
   * legacy / eip2930: use `eth_gasPrice`; `req.maxFee` acts as the cap, failing when below the on-chain quote.
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
            `maxFee is below the on-chain eth_gasPrice (${networkPrice.toString(10)})`,
            ctx,
          );
        }
      }
      if (gasPrice <= 0n) throw this.validationFailed('maxFee', 'gasPrice must be positive', ctx);
      return { gasPrice: gasPrice.toString(10) };
    }

    const [block, tip] = await Promise.all([
      rpcOn<RpcBlock | null>(handle, ctx, 'eth_getBlockByNumber', ['latest', false]),
      this.resolvePriorityFee(handle, ctx),
    ]);
    const baseFeeHex = block?.baseFeePerGas;
    if (baseFeeHex == null) {
      // Pre-London endpoints do not provide baseFeePerGas: this chain does not support EIP-1559 pricing.
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'latest block is missing baseFeePerGas: this endpoint does not support EIP-1559 pricing',
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
          `maxFee is below baseFee + priorityFee (${floor.toString(10)})`,
          ctx,
        );
      }
    }
    // The codec requires maxPriorityFeePerGas ≤ maxFeePerGas; tip ≤ baseFee + tip ≤ maxFee always holds.
    return {
      maxFeePerGas: maxFeePerGas.toString(10),
      maxPriorityFeePerGas: tip.toString(10),
    };
  }

  /**
   * priority fee: prefer `eth_maxPriorityFeePerGas`; fall back to
   * `eth_feeHistory`'s median reward when the endpoint does not support it. If neither is available, fail closed — never silently use 0 or a constant,
   * which would otherwise produce a transaction almost impossible to package.
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
        message: 'cannot obtain a priority fee (both eth_maxPriorityFeePerGas and eth_feeHistory are unavailable)',
        chain: this.chain.id,
      });
    }
  }

  /** Encode the intent; codec field-level failures are uniformly normalized to `DFR_VALIDATION_FAILED` (with details.fields). */
  private encode(intent: EvmUnsignedIntent, ctx: AdapterContext): EvmUnsignedPayload {
    try {
      return encodeUnsignedTransaction(intent);
    } catch (err) {
      throw this.encodeFailure(err, ctx);
    }
  }

  /** Codec field-level failures → uniform DFR errors; other exceptions are rethrown as-is. */
  private encodeFailure(err: unknown, ctx: AdapterContext): Error {
    if (err instanceof EvmCodecError) {
      return createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: `invalid transaction payload field (${err.reason})`,
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

  /* -------------------------- simulate helpers -------------------------- */

  /** Built payload → call intent; the payload has no sender, so a warning must be written (never fabricate from). */
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
        `payload chainId ${decoded.chainId} does not match the requested chain ${chainId}`,
        ctx,
      );
    }
    if (decoded.to === null) {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'contract-creation payload is out of M1 scope (payload to is empty)',
        chain: this.chain.id,
        details: { capability: 'transaction.simulate', reason: 'contract-creation' },
      });
    }
    // The caller (composition root / Transaction Engine) holds the record and passes the sender explicitly when it knows it;
    // Only when the sender is genuinely unknown does it fall back to the "node default from", recorded honestly in warnings.
    if (from !== undefined) {
      this.assertChain(from.chain, ctx);
      assertEvmAddress(from.address, this.chain.id, ctx.requestId);
    } else {
      warnings.push(
        'unsigned payload has no sender: this simulation uses the node default sender; sender-related checks (balance, authorization, nonce) are not covered; simulate with a TransactionRequest to cover the sender',
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

  /** Request → call intent. Fees are only parsed after success, to avoid wasting reads on reverted requests. */
  private simulationCallFromRequest(ctx: AdapterContext, req: TransactionRequest): SimulationCall {
    return {
      from: req.from.address,
      to: req.to?.address as string,
      value: this.transactionValue(req, ctx),
      data: req.data ?? '0x',
    };
  }

  /** `eth_call` / `eth_estimateGas` parameters; omitted fields do not appear, to avoid giving the node extra assumptions. */
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
   * Execute one read call that may revert.
   *
   * A revert (mapped by transport to `DFR_TRANSACTION_REVERTED`) is an **expected result**, converted to
   * `{ ok: false, reason }`; other errors are rethrown as-is, without swallowing Provider failures.
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

  /** Decimal-string parsing (AGENTS red line: on-chain values must never pass through JS number). */
  private decimalField(value: unknown, field: string, ctx: AdapterContext): bigint {
    if (typeof value !== 'string' || !DECIMAL_UINT_RE.test(value)) {
      throw this.validationFailed(
        field,
        `${field} must be a canonical decimal string (no leading zeros, no sign, no fraction)`,
        ctx,
      );
    }
    return BigInt(value);
  }

  /**
   * Hex quantity (`0x…`) → bigint.
   *
   * The Provider only validates the **shape** of JSON-RPC responses (that result exists), not numeric encodings;
   * when an endpoint returns `"0x"` / `"not-a-number"`, a direct `BigInt()` would throw a TypeError,
   * becoming a 500 internal error. Here it is uniformly normalized to `DFR_PROVIDER_INVALID_RESPONSE` (fail-closed).
   */
  private quantity(value: unknown, label: string, ctx: AdapterContext): bigint {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
        requestId: ctx.requestId,
        message: `Provider returned an invalid hex quantity for ${label}`,
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
        message: `chain ${this.chain.id} is missing externalChainId; cannot verify the EVM chainId`,
      });
    }
    return expected;
  }

  private assertChain(chain: ChainId, ctx: AdapterContext): void {
    if (chain !== this.chain.id) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `Adapter is bound to ${this.chain.id}, got ${chain}`,
        chain,
      });
    }
  }

  /** BlockRef → JSON-RPC parameters; unsupported branches fail explicitly, without silent downgrade (adapter-spec Chapter 9). */
  private blockParam(ref: BlockRef, ctx: AdapterContext): string {
    switch (ref.kind) {
      case 'number':
        return decimalUintToHex(ref.number);
      case 'hash':
        return ref.hash;
      case 'tag':
        // EVM does not recognize custom commitments other than 'safe'; tags pass through directly.
        return ref.tag;
      case 'slot':
        throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
          requestId: ctx.requestId,
          message: 'EVM does not support slot references',
          chain: this.chain.id,
        });
      default:
        throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
          requestId: ctx.requestId,
          message: 'unrecognized BlockRef branch',
          chain: this.chain.id,
        });
    }
  }

  /** Derive the observed finality from the Chain Registry's FinalityPolicy. */
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
   * Consistency hint → block parameter for balance queries.
   *
   * `at-block` must carry a blockRef; when missing, fail explicitly instead of silently falling back to latest
   * (domain-model Chapter 6: return DFR_UNSUPPORTED_CAPABILITY when unsupported; never silently ignore).
   */
  private balanceBlockParam(req: GetBalanceRequest, ctx: AdapterContext): string {
    const consistency = req.consistency;
    if (consistency === undefined || consistency.mode === 'best-effort') return 'latest';
    if (consistency.mode === 'finalized') return 'finalized';
    if (consistency.blockRef === undefined) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: 'consistency=at-block requires a blockRef',
        chain: this.chain.id,
        details: { fields: ['blockRef'] },
      });
    }
    return this.blockParam(consistency.blockRef, ctx);
  }
}

/** Recursively convert bigint in viem decode results to decimal strings (HTTP/JSON-safe, per the no-number rule). */
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

