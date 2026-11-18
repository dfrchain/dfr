/**
 * Transaction Engine chain-access port implementation (DFR-M1-B07, part of the composition root).
 *
 * Authoritative sources: docs/architecture/development-plan.md sections 4.3/4.4,
 * docs/architecture/adapter-spec-v0.1.md section 8.1.
 *
 * Why this layer is needed: `@dfr/transaction` must not import Adapter / Provider / Core
 * (AGENTS.md section 3 dependency direction), so it only knows the `TransactionChainPort` port;
 * connecting the port to the real chain path is the composition root's job, and this file is that wiring.
 *
 * The assembled port guarantees:
 *   1. `getPendingNonce` goes through `eth_getTransactionCount(from,'pending')` and returns a decimal string;
 *   2. `build` uses the explicit nonce already allocated by the Engine (the Adapter no longer looks up nonces itself,
 *      or the on-chain reading could disagree with the nonce lease);
 *   3. `simulate` hands the record's `from` to the Adapter, so balance / authorization / nonce checks take effect
 *      (`UnsignedTransaction` itself carries no sender);
 *   4. `broadcast` hands the record's true values (`from` + unsigned payload) to the Adapter for full binding validation,
 *      while the unsigned payload echoed back by the client counts for nothing (M1-C03a);
 *   5. `observe` watches the on-chain situation by expectedHash when the broadcast outcome is uncertain (M1-C03b),
 *      with all fields coming from the record, accepting no caller declarations.
 */
import type { DfrCore } from '@dfr/core';
import { newRequestId } from '@dfr/errors';
import type { BroadcastObservation, BroadcastObservationRequest } from '@dfr/types';
import type {
  ChainBroadcastInput,
  ChainConfirmInput,
  ChainBuildInput,
  ChainObserveInput,
  ChainSimulateInput,
  ChainSequencingExpiryInput,
  GetPendingNonceInput,
  TransactionChainPort,
} from '@dfr/transaction';

/** Port input → Core call context; the default requestId only exists for hand-written calls and is normally passed through by the Engine. */
function context(
  input:
    | GetPendingNonceInput
    | ChainBuildInput
    | ChainSequencingExpiryInput
    | ChainSimulateInput
    | ChainBroadcastInput
    | ChainConfirmInput
    | ChainObserveInput,
) {
  return {
    requestId: input.requestId ?? newRequestId(),
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    ...(input.spanId !== undefined ? { spanId: input.spanId } : {}),
    signal: input.signal,
  };
}

/**
 * Assemble a `TransactionChainPort` with Core.
 *
 * Core handles capability routing and error normalization; non-EVM chain families (or chains without write capability enabled) fail closed here:
 * fail-closed: unknown chains → `DFR_NOT_FOUND`; a chain that exists but whose Adapter does not implement the method →
 * `DFR_UNSUPPORTED_CAPABILITY`. **Never** silently degrade to EVM semantics.
 */
export function createCoreTransactionChainPort(core: DfrCore): TransactionChainPort {
  return {
    getPendingNonce: (input) => core.getPendingNonce(input.chain, input.account, context(input)),

    // ADR-033: chain-agnostic ordering prerequisite (EVM nonce / Solana blockhash).
    getSequencingToken: (input) =>
      core.getSequencingToken(input.chain, input.account, context(input)),

    // ADR-033: inject the engine-allocated ordering prerequisite into the request (Solana uses it to pin the blockhash).
    withSequencingToken: (request, token) =>
      core.withSequencingToken(request.chain, request, token),

    // B43: real Adapter block-height freshness check immediately before send.
    // DfrCore requires this capability for blockhash; it does not guess false.
    isSequencingExpired: (input) =>
      core.isSequencingExpired(input.chain, input.token, context(input)),

    build: (input) => core.buildTransaction(input.request.chain, input.request, context(input)),

    /**
     * Read-only simulation. `from` must come from the record (provided by the Engine); otherwise the Adapter can only fall back to
     * the "node default sender", flagged in `warnings` — that is the B03 compatibility behavior, not the write-path norm.
     */
    simulate: (input) =>
      core.simulateTransaction(input.unsigned.chain, input.unsigned, context(input), {
        from: input.from,
      }),

    /**
     * Single broadcast (M1-C03a). The record's true values (from / unsigned payload) are handed to the
     * Adapter together with `rebroadcast`: only the Adapter can do chain-semantics binding (public-key recovery); Core only carries.
     */
    broadcast: (input) =>
      core.broadcastTransaction(input.signed.chain, input.signed, context(input), {
        ...(input.options ?? {}),
        expectedFrom: input.expected.from,
        expectedUnsignedPayload: input.expected.unsignedPayload,
      }),

    /**
     * On-chain observation when the broadcast outcome is uncertain (M1-C03b). All fields come from the record (expectedHash / from / nonce),
     * accepting no caller declarations; read-only, never re-sending the broadcast.
     */
    observe: (input) =>
      core.observeBroadcast(
        input.chain,
        {
          chain: input.chain,
          txHash: input.txHash,
          from: input.from,
          nonce: input.nonce,
        } satisfies BroadcastObservationRequest,
        context(input),
      ) as Promise<BroadcastObservation>,

    confirm: (input) => core.observeConfirmation(
      input.chain,
      input.txHash,
      input.minFinality,
      context(input),
    ),
  };
}
