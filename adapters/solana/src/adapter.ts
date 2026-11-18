/**
 * @dfr/adapter-solana — Solana Adapter (M2 read-only, ADR-025/027/028).
 *
 * Scope: getInfo / capabilities / getBalance (lamports) / getBlock (located by slot).
 * The write path (build/simulate/broadcast) belongs to M3; this Adapter does not declare those capabilities,
 * so Core fails closed at the capability gate.
 *
 * Isomorphic with the EVM Adapter: the Adapter only handles chain semantics and codecs; it does not select Providers or access databases.
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

/** Acquire a handle by capability, then make one read-only call (single-call scenario, isomorphic with the EVM evmCall). */
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
 * The capabilities this Adapter **actually implements** (ground truth). The Registry is an allowlist, verified at startup as registry ⊆ adapter.
 *
 * Note that `event.subscribe` is excluded: per ADR-025, that capability is **deployment-level** (provided by Core's event bus),
 * not implemented by the Adapter. `transaction.read` needs getTransaction; the current M2 read-only scope declares only
 * balance / block, to be added to the list and registry once B04 fills the gap.
 */
export const SOLANA_IMPLEMENTED_CAPABILITIES: readonly CapabilityId[] = [
  'account.balance',
  'block.read',
  'transaction.read',
  // M3-A02/B01: write-path construction (codec in transaction-codec.ts).
  'transaction.build',
  // M3-B02: read-only on-chain simulation.
  'transaction.simulate',
  // M3-C01: single broadcast.
  'transaction.broadcast',
];

const LAMPORTS_DECIMALS = 9;

/** System Program (11111111111111111111111111111111 = 32 zero bytes). */
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/** Broadcast timeout: a single submission; failures throw immediately, never resent. */
const BROADCAST_TIMEOUT_MS = 30_000;

/** Patterns for the endpoint saying "already have it" (idempotent success). */
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
    // Reuse the same handle: slot and version must come from the same endpoint.
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
    // getLatestBlockhash returns { context, value: { blockhash, lastValidBlockHeight } }
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
      // SPL token balances need getTokenAccountBalance + associated-account derivation; out of the M2 read-only scope.
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'M2 only supports native SOL balances; SPL token balances need extra token-account resolution',
        chain: this.chain.id,
        details: { capability: 'account.balance' },
      });
    }
    if (asset.chain !== this.chain.id) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'asset.chain does not match the requested chain',
        chain: this.chain.id,
      });
    }

    const commitment = this.commitmentOf(req.consistency);
    const accountInfo = await evmStyleCall<SolanaRpcAccountInfo>(ctx, 'account.balance', 'getAccountInfo', [
      req.account.address,
      { commitment, encoding: 'base64' },
    ]);

    // When an account does not exist, lamports count as 0 (Solana semantics: an uninitialized account has a 0 balance); no not-found error.
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
   * Solana transaction query (M2-B04).
   *
   * Differences from EVM (stated as they are, without forcing EVM fields onto them):
   * - The identifier is a **signature** (base58, 64 bytes), not a keccak hash;
   * - No nonce, no single "to/value" (account list + instruction model), so those fields are left unset;
   * - The fee is meta.fee (lamports);
   * - Status is decided by meta.err: null = success, non-null = execution failure.
   */
  async getTransaction(ctx: AdapterContext, ref: TransactionRef): Promise<Transaction | null> {
    this.assertChain(ctx.chain, ctx);
    if (ref.kind !== 'hash') {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'Solana only supports querying by transaction signature',
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
        message: 'Solana transaction execution failed',
        chain: this.chain.id,
      });
    }
    return transaction;
  }

  /**
   * Solana receipts: computeUnitsConsumed is "consumed compute", with different semantics from EVM gasUsed
   * (there is no gas price), so only gasUsed and the fee are filled in; no pricing model is fabricated.
   */
  async getReceipt(ctx: AdapterContext, ref: TransactionRef): Promise<Receipt | null> {
    this.assertChain(ctx.chain, ctx);
    if (ref.kind !== 'hash') return null;
    // Soft check: an invalid signature counts as "not found", no error thrown (a receipt is optional information).
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
   * `BlockRef` → slot (ADR-027).
   *
   * - `slot`: Solana's canonical locator;
   * - `hash`: defined as a **blockhash** (base58), which must first be resolved to a slot by blockhash;
   * - `number` / `tag`: not applicable to Solana → fail-closed (the mirror image of how EVM handles `slot`).
   */
  private slotOf(ref: BlockRef, ctx: AdapterContext): { slot: bigint | number } {
    if (ref.kind === 'slot') return { slot: BigInt(ref.slot) };
    if (ref.kind === 'tag') {
      // Only latest/confirmed/finalized semantics are supported → the caller resolves them with getSlot first.
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'Solana getBlock needs an explicit slot or blockhash; resolve tag-based locations with getSlot first',
        chain: this.chain.id,
        details: { capability: 'block.read' },
      });
    }
    if (ref.kind === 'hash') {
      throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'Blockhash-based location must first resolve to a slot; M2 only supports slot location',
        chain: this.chain.id,
        details: { capability: 'block.read' },
      });
    }
    // kind === 'number'
    throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
      requestId: ctx.requestId,
      message: 'Solana does not use block height (number); use slot location',
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
   * Decide whether a Solana sequencing prerequisite (recent blockhash) has expired (M3-A01, ADR-032).
   *
   * The criterion is **block height**, not time: once `getBlockHeight()` exceeds the token's
   * `lastValidBlockHeight`, the blockhash is no longer accepted by the chain (measured devnet validity window:
   * about 166 blocks, ≈60–90 seconds). This is exactly why "chain-specific expiry semantics belong in the Adapter";
   * the Store only keeps `lastValidBlockHeight` and never judges on its own.
   *
   * This is a non-Capability internal coordination method (like `getPendingNonce`): it does not enter
   * `CapabilityId` / `capabilities()` and cannot be routed directly by the Gateway. EVM does **not** implement it
   * (a nonce never expires); when Core lacks it, it is treated as "never expires".
   */
  async isSequencingExpired(ctx: AdapterContext, token: SequencingToken): Promise<boolean> {
    this.assertChain(ctx.chain, ctx);
    if (token.kind !== 'blockhash') {
      // An EVM nonce token must not reach the Solana Adapter: fail closed instead of guessing an answer.
      throw createDfrError('DFR_INVALID_REQUEST', {
        requestId: ctx.requestId,
        message: 'Solana Adapter only accepts blockhash sequencing prerequisites; nonce semantics belong to EVM',
        chain: this.chain.id,
        details: { capability: 'transaction.build' },
      });
    }
    // The JSDoc already states this is a safe call (read-only, no signing material involved).
    const handle = await ctx.providers.acquire({ capability: 'block.read' });
    const height = await rpcOn<number>(handle, ctx, 'getBlockHeight', [{ commitment: 'confirmed' }]);
    // Decimal-string comparison: both may exceed the JS safe-integer range (no-number rule).
    return BigInt(String(height)) > BigInt(token.lastValidBlockHeight);
  }

  /* ------------------------------- build ------------------------------- */

  /**
   * Build an unsigned Solana transaction (M3-B01).
   *
   * Key difference from EVM build: Solana has **no account nonce**; the sequencing prerequisite is a recent blockhash,
   * fetched from the chain by the Adapter (`getLatestBlockhash`) — exactly the "chain-specific prerequisite lives in the Adapter" point.
   * So `req.nonce` is meaningless for Solana: its presence fails closed (never silently ignored, so callers do not
   * think the nonce took effect). The blockhash is also written to `meta.recentBlockhash` for the upper layer's
   * `SequencingStore` to carry its `lastValidBlockHeight`.
   *
   * Scope (M3-B01): native SOL transfers (System Program `Transfer`, instruction enum value 2).
   * SPL token / arbitrary instructions / ALT / durable nonce are out of this card's scope; fail closed explicitly.
   */
  /**
   * Fetch this chain's current **sequencing prerequisite** (ADR-032/033): recent blockhash + on-chain validity.
   *
   * This is a non-Capability internal coordination method (the counterpart of EVM's `getPendingNonce`): when the engine takes the
   * blockhash path it calls this first, handing the token to `SequencingStore.reserve` to place the lease,
   * then injecting the **same** blockhash into build via `withSequencingToken` — keeping the lease and payload consistent.
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
        message: 'getLatestBlockhash did not return a usable blockhash / lastValidBlockHeight',
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

  /** Inject the engine-assigned blockhash into the request (ADR-033); a shape mismatch fails closed. */
  withSequencingToken(req: TransactionRequest, token: SequencingToken): TransactionRequest {
    if (token.kind !== 'blockhash') {
      throw createDfrError('DFR_INVALID_REQUEST', {
        requestId: 'req_sequencing_token_shape' as never,
        message: 'Solana sequencing prerequisite must be a blockhash token',
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
        message: 'Solana build needs an explicit recipient address (to); this card does not support contract/program deployment',
        chain: this.chain.id,
        details: { capability: 'transaction.build', reason: 'missing-to' },
      });
    }
    this.assertChain(req.to.chain, ctx);
    assertSolanaAddress(req.to.address, this.chain.id, ctx.requestId);
    if (req.nonce !== undefined) {
      // Solana has no account nonce. An EVM-semantics nonce passed in must fail explicitly, not be pretended away.
      throw createDfrError('DFR_INVALID_REQUEST', {
        requestId: ctx.requestId,
        message: 'Solana does not use account nonces; the sequencing prerequisite is a recent blockhash (fetched by the Adapter)',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'nonce' },
      });
    }

    const lamports = this.transferLamports(req, ctx);
    // Sequencing prerequisite: use as-is when the engine (via SequencingStore) already injected one; otherwise (when the Adapter is called directly,
    // as in contract tests) fetch one on the spot. Never hardcode one.
    let blockhash = req.recentBlockhash;
    if (blockhash === undefined || blockhash.length === 0) {
      const token = await this.getSequencingToken(ctx, req.from);
      if (token.kind !== 'blockhash') throw new Error('unreachable: Solana token must be blockhash');
      blockhash = token.value;
    }

    // System Program Transfer instruction: u32 little-endian instruction enum 2 + u64 little-endian lamports.
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
      // Solana sequencing prerequisite (ADR-032): written into meta for SequencingStore to record validity.
      recentBlockhash: blockhash,
      feeEstimate: {
        asset: { kind: 'native', chain: this.chain.id },
        // Fees are decided by signer count and compute budget; the exact value needs simulate (B02).
        // Here is Solana's **base signature fee** (5000 lamports × signer count); no compute fee is invented.
        amount: String(5_000 * message.numRequiredSignatures) as DecimalUint,
      },
      warnings: [
        'fee covers only the base signature fee (5000 lamports × signer count), excluding compute fees; the exact fee comes from simulate',
      ],
    };
    return { schemaVersion: '1', chain: this.chain.id, payload: encoded.payload, meta };
  }

  /** Native SOL amount → lamports (`Amount.amount` is already a decimal string, converted at the legal decimal places). */
  private transferLamports(req: TransactionRequest, ctx: AdapterContext): bigint {
    if (req.value === undefined) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'Solana transfers must provide an amount (value)',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'value' },
      });
    }
    const asset = req.value.asset;
    if (asset.kind !== 'native' || asset.chain !== this.chain.id) {
      throw createDfrError('DFR_INVALID_ASSET', {
        requestId: ctx.requestId,
        message: 'build native amounts must use this chain's native asset',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'value' },
      });
    }
    if (!/^[0-9]+$/u.test(req.value.amount)) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: 'amount must be a decimal string',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'value' },
      });
    }
    const lamports = BigInt(req.value.amount) * 10n ** BigInt(LAMPORTS_DECIMALS);
    // Solana lamports are u64.
    if (lamports > (2n ** 64n - 1n)) {
      throw createDfrError('DFR_VALIDATION_FAILED', {
        requestId: ctx.requestId,
        message: 'amount exceeds the Solana u64 lamports limit',
        chain: this.chain.id,
        details: { capability: 'transaction.build', field: 'value' },
      });
    }
    return lamports;
  }

  /* ------------------------------ simulate ------------------------------ */

  /**
   * Read-only on-chain simulation (M3-B02).
   *
   * Solana uses `simulateTransaction`, returning `err` (execution failure reason), `logs`, `unitsConsumed`,
   * `fee`. Semantics align with EVM: **execution reverts do not throw 5xx**; they are normalized to
   * `{ success:false, revertReason }`, which the Transaction Engine records as `reverted` and blocks from broadcast.
   *
   * Two call shapes are supported, matching EVM's input shapes:
   *   - Payload path (`UnsignedTransaction`): simulate the payload directly; `options.from` does not apply
   *     (Solana's fee payer is already compiled into the message); passing one changes nothing.
   *   - Request path (`TransactionRequest`): build first, then simulate (build fetches a blockhash).
   *
   * Why `sigVerify:false`: externally signed transactions are signed on the **client**; the server only simulates,
   * it has and needs no signing material; Solana allows simulation with sigVerify:false (signatures count as passing).
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
          message: 'Solana simulate only accepts base64 payloads',
          chain: this.chain.id,
          details: { capability: 'transaction.simulate', encoding: req.meta.encoding },
        });
      }
      payload = req.payload;
      // Solana's sender (fee payer) is already compiled into the message; only the request path needs from.
      warnings.push('the payload path does not verify roles beyond the sender balance; the fee payer is already decided by the payload');
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
        message: 'simulateTransaction returned no result',
        chain: this.chain.id,
        details: { capability: 'transaction.simulate' },
      });
    }
    if (value.err != null) {
      const reason = this.describeSolanaError(value.err);
      // `BlockhashNotFound` semantically means "the sequencing prerequisite expired; rebuild", not a program revert.
      // The exact classification (this error code / retry semantics) is defined by C03; it is only flagged explicitly here so it is not mistaken for an ordinary revert.
      const extra =
        reason.includes('BlockhashNotFound')
          ? ['blockhash may have expired: rebuild per C03 semantics instead of marking it reverted']
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

  /** Solana execution errors (`err` may be an object or a string) → redacted reason text. */
  private describeSolanaError(err: unknown): string {
    if (typeof err === 'string') return err;
    try {
      const encoded = JSON.stringify(err);
      return encoded === undefined ? 'Solana transaction execution failed' : encoded;
    } catch {
      return 'Solana transaction execution failed';
    }
  }

  private revertedSimulation(reason: string, warnings: readonly string[]): SimulationResult {
    const result: SimulationResult = { success: false, revertReason: reason };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  /* ------------------------------ broadcast ------------------------------ */

  /**
   * Broadcast a signed transaction once (M3-C01).
   *
   * Four red lines aligned with EVM (fund safety over convenience):
   *   1. **Exactly once**: `idempotency: 'non-idempotent-write'`; the Provider Manager never retries automatically,
   *      and failures never switch endpoints and resend;
   *   2. **Pre-broadcast local validation**: signed payload vs. recorded ground truth (from / unsigned payload / expectedHash) binding mismatches
   *      are all rejected before `acquire()` → `DFR_TRANSACTION_REJECTED`, **no broadcast sent**;
   *   3. **already known is an idempotent success** (error-spec §5.1);
   *   4. The signature returned by the endpoint must match the recomputed payload hash, otherwise `DFR_PROVIDER_INVALID_RESPONSE`.
   *
   * `maxRetries:0`: never hand "retries" to the node — retry policy is the state machine's job (C03), not the transport layer's.
   */
  async broadcast(
    ctx: AdapterContext,
    signed: SignedTransaction,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult> {
    this.assertChain(signed.chain, ctx);

    // --- Local validation (no RPC, no acquire)---
    const txHash = this.verifyBroadcastBinding(ctx, signed, options);

    // --- Single call ---
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
              // Retries are the state machine's job (C03); never retry automatically here.
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
      // Blockhash expired (M3-C03): this signed payload will never land on-chain; resending is pointless.
      // Normalized to a **dedicated** error code + an actionable hint; never re-sign automatically (signing belongs outside).
      if (this.isBlockhashExpired(err)) {
        throw createDfrError('DFR_BLOCKHASH_EXPIRED', {
          requestId: ctx.requestId,
          message: 'Solana blockhash expired: this signed payload will not be accepted; rebuild and re-sign',
          chain: this.chain.id,
          details: { method: 'sendTransaction', action: 'rebuild' },
          ...(isDfrError(err) ? { cause: err } : {}),
        });
      }
      // Other failures are rethrown as-is: TransactionEngine decides whether to roll state back (C03).
      throw err;
    }

    if (typeof returned !== 'string' || !isSolanaSignature(returned) || returned !== txHash) {
      throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
        requestId: ctx.requestId,
        message: 'broadcast endpoint returned a signature inconsistent with the signed payload',
        provider: handle.id,
        chain: this.chain.id,
        details: { method: 'sendTransaction' },
      });
    }

    return this.broadcastAccepted(handle, txHash, options);
  }

  /** The single construction point for broadcast success (including already-known idempotent success). */
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
   * Pre-broadcast local binding verification, returning the transaction hash recomputed from the signed payload.
   *
   * With recorded ground truth (the engine passes `expectedFrom` + `expectedUnsignedPayload`), do the full binding;
   * otherwise only do what the Adapter can prove on its own (signed + expectedHash). Any failure is thrown
   * before `acquire()`, so **no broadcast is sent**.
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
    // No recorded ground truth: only do what the Adapter can prove on its own.
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

  /** Pre-broadcast local rejection: uniform 422 `DFR_TRANSACTION_REJECTED`, without leaking the raw signature. */
  private broadcastRejected(ctx: AdapterContext, reason: string, cause?: unknown): Error {
    return createDfrError('DFR_TRANSACTION_REJECTED', {
      requestId: ctx.requestId,
      message: `signed payload failed pre-broadcast validation (${reason})`,
      chain: this.chain.id,
      details: { reason },
      ...(cause !== undefined ? { cause } : {}),
    });
  }

  /**
   * Whether the endpoint is saying "blockhash not found / expired" (M3-C03).
   *
   * When a blockhash expires (past `lastValidBlockHeight`), Solana rejects the transaction with "Blockhash not found"
   * ; this is a **provably unrecoverable** rejection that must be distinguished from ordinary reverts/timeouts.
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

  /** Extract matchable text from any error (DFR errors prefer chainError.message, to avoid leaking the original). */
  private errorText(err: unknown): string {
    if (isDfrError(err)) return `${err.chainError?.message ?? ''} ${err.message}`;
    return err instanceof Error ? err.message : String(err);
  }

  /** Whether the endpoint is saying "I already have this transaction" (idempotent success). */
  private isAlreadyKnown(err: unknown): boolean {
    if (!isDfrError(err)) return false;
    const message = `${err.chainError?.message ?? ''}`.toLowerCase();
    return ALREADY_KNOWN_PATTERNS.some((pattern) => message.includes(pattern));
  }

  /**
   * Single read-only confirmation observation (M3-C02).
   *
   * Use `getTransaction` with a Solana commitment: `processed` / `confirmed` / `finalized`
   * (ADR-031's three levels). The returned `finality` is **mapped from the commitment** into the DFR observation domain (not
   * derived from a confirmation count — Solana has no EVM-style "confirmation count").
   *
   * Semantics:
   *   - Not found (`null`) → `null` (the upper layer keeps unknown; no state is faked);
   *   - Execution failure (`meta.err != null`) → status `reverted`, finality still reported by commitment;
   *   - Otherwise status takes the commitment's tier (processed→included / confirmed / finalized).
   *
   * Read-only: never broadcast, never resend, never write state.
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
        // Some clusters (including devnet) do not support `processed` in getTransaction
        // ("Method does not support commitment below `confirmed`").
        // This is not "not found" but "that tier is unavailable" — skip it as tier-unavailable, never treat it as a failure or a null conclusion.
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
    // Execution failure (reverted) takes precedence over the finality tier: the status is still factual, and finality is reported as observed.
    // Note: `getTransaction` returns no block hash, so canonicalBlockHash is not fabricated (left empty).
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
   * `event.subscribe` is a **deployment-level** capability (ADR-025), provided by Core's event bus; the Adapter does not implement it.
   * Isomorphic with EVM: present but throws immediately, without silent downgrade.
   */
  subscribe(ctx: AdapterContext, _filter: unknown): AsyncIterable<never> {
    const error = createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
      requestId: ctx.requestId,
      message: 'event.subscribe is a deployment-level capability, provided by Core's event bus',
      chain: ctx.chain,
      details: { capability: 'event.subscribe' },
    });
    return {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return { next: (): Promise<IteratorResult<never>> => Promise.reject(error) };
      },
    };
  }

  /** `contract.read` (read-only program call) is not implemented yet: fail-closed, no silent downgrade. */
  readContract(ctx: AdapterContext, _req: unknown): Promise<never> {
    return Promise.reject(
      createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
        requestId: ctx.requestId,
        message: 'Solana read-only program call (contract.read) is not implemented yet',
        chain: this.chain.id,
        details: { capability: 'contract.read' },
      }),
    );
  }

  private assertChain(chain: ChainId, ctx: AdapterContext): void {
    if (chain !== this.chain.id) {
      throw createDfrError('DFR_CHAIN_MISMATCH', {
        requestId: ctx.requestId,
        message: `requested chain ${chain} does not match the chain ${this.chain.id} bound to the Adapter`,
        chain: this.chain.id,
      });
    }
  }
}
