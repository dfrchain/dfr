/**
 * M1 write-endpoint handlers (DFR-M1-B07 build; B08 adds simulate).
 *
 * Placement and responsibilities: see docs/architecture/m1-api-contract.md chapter 6, "suggested structure":
 * The generic pipeline (auth / rate limiting / gates / body) stays in `server.ts`; the write endpoints' business orchestration
 * lives in its own file, so all the logic is not piled into `handle()` anymore.
 *
 * Responsibility boundary (gateway-spec chapter 3 step 7 + section 8):
 * - The Gateway only does **structural validation** (shape, required fields); domain validation goes to the engine / Adapter;
 * - The Gateway does **not construct** error semantics; it only hands the DFR errors thrown by the engine to the unified mapping;
 * - The Gateway does not persist, allocate nonces, or do fingerprint canonicalization (it reuses the engine's implementation).
 */
import { createDfrError } from '@dfr/errors';
import type { GatewayIdempotencyCoordinator } from '../idempotency.js';
import type { TransactionEngine } from '@dfr/transaction';
import type {
  BroadcastTransactionResponse,
  ConfirmTransactionRequest,
  ChainId,
  RequestId,
  SimulateTransactionRequest,
  TransactionRequest,
  SignedTransaction,
  TransactionId,
} from '@dfr/types';

export interface WriteHandlerContext {
  readonly requestId: RequestId;
  readonly traceId: string;
  readonly spanId: string;
  readonly projectId: string;
  /** Caller-authorized chains, supplied by the Gateway after API Key auth. */
  readonly authorizedChains?: readonly ChainId[] | '*';
  readonly signal: AbortSignal;
  /** `Idempotency-Key` header; optional for build (gateway-spec section 7.1). */
  readonly idempotencyKey?: string;
  /** Unassembled = this deployment does not expose the write path; returns 422, not 500. */
  readonly engine?: TransactionEngine;
  /**
   * Reporting outlet for idempotent "replays".
   *
   * Only the engine knows whether this build hit an idempotency record (`BuiltTransactionResult.replayed`),
   * and the Gateway does not expose that field in the response envelope (the A01 contract fixes three fields), so the handler reports it proactively,
   * feeding the `dfr_gateway_idempotency_hits_total{outcome="replayed"}` counter.
   */
  readonly onIdempotencyOutcome?: (outcome: 'replayed' | 'conflict') => void;
  /**
   * Gateway-level idempotency coordinator (DFR-M1-C04). **Broadcast** uses it for "fingerprint + first response" replays;
   * build's idempotency lives inside the engine (by request-body fingerprint); the two have different scopes and do not overlap.
   */
  readonly idempotency?: GatewayIdempotencyCoordinator;
}

export interface WriteHandlerResult {
  readonly status: number;
  readonly body: unknown;
  /** Extra headers to write into the HTTP response (e.g. `Idempotency-Replayed` for idempotent replays). */
  readonly headers?: Record<string, string>;
}

/** `POST /v1/transactions/build` (DFR-M1-B07). Success code 200; see the OpenAPI spec and the A01 contract test. */
export async function handleBuildTransaction(
  body: Record<string, unknown> | undefined,
  ctx: WriteHandlerContext,
): Promise<WriteHandlerResult> {
  // Order: structural validation (contract) precedes "whether this deployment has an engine assembled" (capability / configuration).
  // Structurally invalid requests are 400 in any deployment and are not re-judged because the deployment lacks an engine.
  // Idempotency-Key is an optional header, but **once provided** it must satisfy the contract bounds (TODO-007).
  const idempotencyKey = assertIdempotencyKey(ctx.idempotencyKey, ctx.requestId, {
    required: false,
    operation: 'build',
  });
  const request = parseBuildRequest(body, ctx.requestId);
  const engine = requireEngine(ctx.engine, ctx.requestId, 'transaction.build');
  const result = await engine.build({
    request,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    projectId: ctx.projectId,
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    signal: ctx.signal,
  });
  if (result.replayed) ctx.onIdempotencyOutcome?.('replayed');
  return {
    status: 200,
    body: {
      transactionId: result.transactionId,
      unsignedTransaction: result.unsignedTransaction,
      requestId: ctx.requestId,
    },
  };
}

/**
 * `DELETE /v1/transactions/{transactionId}` (ADR-037 option A).
 *
 * Void an **unbroadcast** transaction (`built` / `simulated`), releasing the nonce lease it holds.
 * **Idempotent**: calling again after `abandoned` returns 200 (`leaseReleased=false`).
 *
 * `signed` and above → `422 DFR_TRANSACTION_REJECTED` (`reason: not_abandonable`):
 * A signed/broadcast nonce is **never** reclaimed (fund safety, ADR-018/019).
 *
 * The path parameter is a **DFR internal execution id** (`txn_<...>`), not an on-chain transaction hash.
 */
export async function handleAbandonTransaction(
  transactionId: string,
  ctx: WriteHandlerContext,
): Promise<WriteHandlerResult> {
  if (transactionId === '') {
    throw validation(ctx.requestId, 'missing transactionId', ['transactionId']);
  }
  const engine = requireEngine(ctx.engine, ctx.requestId, 'transaction.build');
  const result = await engine.abandon({
    transactionId: transactionId as TransactionId,
    requesterProjectId: ctx.projectId,
    ...(ctx.authorizedChains !== undefined ? { authorizedChains: ctx.authorizedChains } : {}),
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
  });
  return {
    status: 200,
    body: {
      transactionId: result.transactionId,
      status: result.status,
      leaseReleased: result.leaseReleased,
      ...(result.nonce !== undefined ? { nonce: result.nonce } : {}),
      requestId: ctx.requestId,
    },
  };
}

/**
 * `POST /v1/transactions/preflight` (ADR-037 option B).
 *
 * Read-only preflight: **no nonce taken, nothing persisted, no idempotency table written**. Same request body as build
 * (`TransactionRequest`), with response envelope `{ unsignedTransaction, simulation, observedNonce?, requestId }`.
 *
 * Why it exists: `simulate` needs a `transactionId` first, but a `transactionId` is only produced by build;
 * so before preflight, the only way to answer "can this transaction go through" was build, consuming one on-chain nonce each time —
 * and repeated preflights left permanent gaps (the measured cause behind ADR-037).
 *
 * A rollback is **not** an HTTP error: it returns 200 with `simulation.success=false`, so the caller reads the failure as information.
 * This deliberately differs from simulate's 422 semantics — preflight has **no record that can land in `reverted`**,
 * and must not fabricate a 4xx just for "consistency".
 */
export async function handlePreflightTransaction(
  body: Record<string, unknown> | undefined,
  ctx: WriteHandlerContext,
): Promise<WriteHandlerResult> {
  assertIdempotencyKey(ctx.idempotencyKey, ctx.requestId, {
    required: false,
    operation: 'preflight',
  });
  const request = parseBuildRequest(body, ctx.requestId);
  const engine = requireEngine(ctx.engine, ctx.requestId, 'transaction.build');
  const result = await engine.preflight({
    request,
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    signal: ctx.signal,
  });
  return {
    status: 200,
    body: {
      unsignedTransaction: result.unsignedTransaction,
      simulation: result.simulation,
      ...(result.observedNonce !== undefined ? { observedNonce: result.observedNonce } : {}),
      requestId: result.requestId,
    },
  };
}

/**
 * `POST /v1/transactions/simulate` (DFR-M1-B08).
 *
 * Request body = `SimulateTransactionRequest` (transactionId + unsignedTransaction).
 * Success code 200, envelope `{ transactionId, simulation, requestId }`.
 *
 * A rollback is **not** a "failure translation" of an HTTP error: the engine has already landed the record in `reverted` and thrown
 * `DFR_TRANSACTION_REVERTED` (B05); the Gateway only maps the status code → 422.
 * Never reclassify, never wrap as a 500 (or callers will misjudge it as a service failure).
 *
 * An optional `Idempotency-Key` is accepted but **does not take part in the idempotency decision**: simulate is located by
 * `transactionId`, and a repeated call is a new observation (m1-api-contract section 2).
 */
export async function handleSimulateTransaction(
  body: Record<string, unknown> | undefined,
  ctx: WriteHandlerContext,
): Promise<WriteHandlerResult> {
  assertIdempotencyKey(ctx.idempotencyKey, ctx.requestId, {
    required: false,
    operation: 'simulate',
  });
  const request = parseSimulateRequest(body, ctx.requestId);
  const engine = requireEngine(ctx.engine, ctx.requestId, 'transaction.simulate');
  const result = await engine.simulate({
    transactionId: request.transactionId,
    unsignedTransaction: request.unsignedTransaction,
    requesterProjectId: ctx.projectId,
    ...(ctx.authorizedChains !== undefined ? { authorizedChains: ctx.authorizedChains } : {}),
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    signal: ctx.signal,
  });
  return {
    status: 200,
    body: {
      transactionId: result.transactionId,
      simulation: result.simulation,
      requestId: ctx.requestId,
    },
  };
}

export async function handleBroadcastTransaction(
  body: Record<string, unknown> | undefined,
  ctx: WriteHandlerContext,
): Promise<WriteHandlerResult> {
  // Key validation precedes body parsing: when the key is invalid, the payload need not and should not be parsed.
  const idempotencyKey = assertIdempotencyKey(ctx.idempotencyKey, ctx.requestId, {
    required: true,
    operation: 'broadcast',
  })!;
  const request = parseBroadcastRequest(body, ctx.requestId);

  // Gateway-level idempotency (gateway-spec §7.2 / m1-api-contract §4):
  // The fingerprint covers chain / transactionId / **signature digest** / rebroadcast.
  // `expectedHash` (= keccak256(signedPayload)) is used deliberately instead of the raw signedPayload:
  // it is both the spec-required "signature digest" and avoids handling the raw signature (safety red line: raw signatures never enter logs/storage).
  const coordinator = ctx.idempotency;
  let idempotencyOwner: string | undefined;
  if (coordinator !== undefined) {
    const scope = {
      projectId: ctx.projectId,
      chain: request.signedTransaction.chain,
      key: idempotencyKey,
    };
    const began = await coordinator.acquire(scope, {
      chain: request.signedTransaction.chain,
      transactionId: request.transactionId,
      expectedHash: request.signedTransaction.expectedHash,
      rebroadcast: request.rebroadcast === true,
    });
    if (began.kind === 'conflict') {
      ctx.onIdempotencyOutcome?.('conflict');
      throw createDfrError('DFR_IDEMPOTENCY_CONFLICT', {
        requestId: ctx.requestId,
        chain: request.signedTransaction.chain,
        message: 'the same idempotency key was already used for a different broadcast request',
      });
    }
    if (began.kind === 'in_flight') {
      ctx.onIdempotencyOutcome?.('conflict');
      throw createDfrError('DFR_IDEMPOTENCY_CONFLICT', {
        requestId: ctx.requestId,
        chain: request.signedTransaction.chain,
        message: 'a broadcast with the same idempotency key is already in progress',
        details: { retryAfterMs: began.retryAfterMs },
      });
    }
    if (began.kind === 'replayed') {
      // Replay the first response: status code and body both come from the record; the broadcast is **not** re-executed.
      ctx.onIdempotencyOutcome?.('replayed');
      return {
        status: began.record.statusCode ?? 202,
        body: began.record.responseBody ?? { requestId: ctx.requestId },
        headers: { 'Idempotency-Replayed': 'true' },
      };
    }
    idempotencyOwner = began.record.ownerToken;
  }

  const engine = requireEngine(ctx.engine, ctx.requestId, 'transaction.broadcast');
  const result = await engine.broadcast({
    transactionId: request.transactionId,
    signed: request.signedTransaction,
    requesterProjectId: ctx.projectId,
    ...(ctx.authorizedChains !== undefined ? { authorizedChains: ctx.authorizedChains } : {}),
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    signal: ctx.signal,
    options: { rebroadcast: request.rebroadcast === true, idempotencyKey },
  });
  // Explicitly annotate the response-body type: the engine's BroadcastTransactionResult must match the OpenAPI/type
  // BroadcastTransactionOutcome, or `pnpm typecheck` fails right here.
  // DFR-M1-E03 fixed the earlier drift of "declaring BroadcastResult (ref) but actually returning txHash".
  const responseBody: BroadcastTransactionResponse = {
    transactionId: result.transactionId,
    broadcast: result,
    requestId: ctx.requestId,
  };
  if (coordinator !== undefined && idempotencyOwner !== undefined) {
    // Record the first response for same-key replays. If ownership is lost (taken over), the result is still genuine;
    // it is just not guaranteed to replay next time — the request is not re-judged as failed because of that.
    await coordinator.complete({
      scope: {
        projectId: ctx.projectId,
        chain: request.signedTransaction.chain,
        key: idempotencyKey,
      },
      ownerToken: idempotencyOwner,
      statusCode: 202,
      responseBody,
      transactionId: result.transactionId,
    });
  }
  return { status: 202, body: responseBody };
}

export async function handleConfirmTransaction(
  txHash: string,
  body: Record<string, unknown> | undefined,
  ctx: WriteHandlerContext,
): Promise<WriteHandlerResult> {
  if (txHash === '') throw validation(ctx.requestId, 'txHash must be non-empty', ['txHash']);
  const request = parseConfirmRequest(body, ctx.requestId);
  const engine = requireEngine(ctx.engine, ctx.requestId, 'transaction.confirm');
  const confirmation = await engine.confirm({
    chain: request.chain,
    txHash,
    ...(request.minFinality !== undefined ? { minFinality: request.minFinality } : {}),
    timeoutMs: request.timeoutMs ?? 60_000,
    requestId: ctx.requestId,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    signal: ctx.signal,
  });
  return { status: 200, body: { confirmation, requestId: ctx.requestId } };
}

export function parseConfirmRequest(
  body: Record<string, unknown> | undefined,
  requestId: RequestId,
): ConfirmTransactionRequest {
  if (body === undefined || typeof body['chain'] !== 'string' || body['chain'] === '') {
    throw validation(requestId, 'chain must be a non-empty string', ['chain']);
  }
  const minFinality = body['minFinality'];
  if (minFinality !== undefined && !['submitted', 'included', 'confirmed', 'finalized'].includes(String(minFinality))) {
    throw validation(requestId, 'invalid minFinality value', ['minFinality']);
  }
  const timeoutMs = body['timeoutMs'];
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)) {
    throw validation(requestId, 'timeoutMs must be an integer in the range 1000..600000', ['timeoutMs']);
  }
  return {
    chain: body['chain'] as ConfirmTransactionRequest['chain'],
    ...(minFinality !== undefined ? { minFinality: minFinality as NonNullable<ConfirmTransactionRequest['minFinality']> } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function parseBroadcastRequest(body: Record<string, unknown> | undefined, requestId: RequestId): { transactionId: TransactionId; signedTransaction: SignedTransaction; rebroadcast?: boolean } {
  if (body === undefined || typeof body.transactionId !== 'string' || body.transactionId === '' || body.signedTransaction === null || typeof body.signedTransaction !== 'object') {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'broadcast request body structure is invalid', details: { fields: ['transactionId', 'signedTransaction'] } });
  }
  const signed = body.signedTransaction as Record<string, unknown>;
  if (typeof signed.schemaVersion !== 'string' || typeof signed.chain !== 'string' || typeof signed.signedPayload !== 'string' || typeof signed.expectedHash !== 'string' || signed.unsigned === null || typeof signed.unsigned !== 'object') {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'signedTransaction structure is invalid' });
  }
  return { transactionId: body.transactionId as TransactionId, signedTransaction: signed as unknown as SignedTransaction, ...(body.rebroadcast === true ? { rebroadcast: true } : {}) };
}

function requireEngine(
  engine: TransactionEngine | undefined,
  requestId: RequestId,
  capability: string,
): TransactionEngine {
  if (engine === undefined) {
    throw createDfrError('DFR_UNSUPPORTED_CAPABILITY', {
      requestId,
      message: 'this deployment has no transaction engine assembled; the write path is unavailable',
      details: { capability },
    });
  }
  return engine;
}

/**
 * Structural validation of build requests (Gateway responsibility boundary).
 *
 * Only "shape" is judged: `chain` is a non-empty string, `from` is an object carrying `address` (`to` / `value`
 * must also be objects when present). Address formats, chain support, amount semantics, and other **domain validation** go to the Adapter /
 * engine (gateway-spec chapter 3 step 7: "contract validation only does structural matching").
 *
 * `nonce` is not part of structural validation: it is passed to the engine as-is, and the engine rejects it with `DFR_VALIDATION_FAILED`
 * (in M1, nonces are allocated by the server and land in leases).
 */
export function parseBuildRequest(
  body: Record<string, unknown> | undefined,
  requestId: RequestId,
): TransactionRequest {
  if (body === undefined) {
    throw validation(requestId, 'missing request body', ['body']);
  }
  if (typeof body['chain'] !== 'string' || body['chain'] === '') {
    throw validation(requestId, 'chain must be a non-empty string', ['chain']);
  }
  for (const field of ['from', 'to'] as const) {
    const value = body[field];
    if (value === undefined) {
      if (field === 'from') throw validation(requestId, 'missing from', ['from']);
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw validation(requestId, `${field} must be an object`, [field]);
    }
    if (typeof (value as { address?: unknown }).address !== 'string') {
      throw validation(requestId, `${field}.address must be a string`, [field]);
    }
  }
  const value = body['value'];
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw validation(requestId, 'value must be an object', ['value']);
  }
  // Passed through as-is: unknown fields are failed closed by the engine / Adapter respectively; the Gateway does no domain trimming.
  return body as unknown as TransactionRequest;
}

/**
 * Structural validation of simulate requests.
 *
 * Only shape is judged: `transactionId` is a non-empty string, `unsignedTransaction` is a plain object
 * (it must carry a string `payload` and a string `chain` — without them it is not a payload).
 * "Whether the payload matches the saved build" is a **domain binding check**, done by the engine before RPC
 * (B05); the Gateway does not overreach.
 */
export function parseSimulateRequest(
  body: Record<string, unknown> | undefined,
  requestId: RequestId,
): SimulateTransactionRequest {
  if (body === undefined) {
    throw validation(requestId, 'missing request body', ['body']);
  }
  const transactionId = body['transactionId'];
  if (typeof transactionId !== 'string' || transactionId === '') {
    throw validation(requestId, 'transactionId must be a non-empty string', ['transactionId']);
  }
  const unsigned = body['unsignedTransaction'];
  if (typeof unsigned !== 'object' || unsigned === null || Array.isArray(unsigned)) {
    throw validation(requestId, 'unsignedTransaction must be an object', ['unsignedTransaction']);
  }
  // OpenAPI's `UnsignedTransaction.required` is [schemaVersion, chain, payload, meta].
  // Each item gets a **shape** check here: a missing meta would make the engine throw at `unsigned.meta.requiresNonce`,
  // a TypeError disguising the caller's input error as a 500 (hit in the real-chain acceptance run on 2026-10-06).
  const shape = unsigned as { schemaVersion?: unknown; chain?: unknown; payload?: unknown; meta?: unknown };
  if (shape.schemaVersion !== '1') {
    throw validation(requestId, 'unsignedTransaction.schemaVersion must be "1"', [
      'unsignedTransaction.schemaVersion',
    ]);
  }
  if (typeof shape.chain !== 'string' || shape.chain === '') {
    throw validation(requestId, 'unsignedTransaction.chain must be a non-empty string', [
      'unsignedTransaction',
    ]);
  }
  if (typeof shape.payload !== 'string' || shape.payload === '') {
    throw validation(requestId, 'unsignedTransaction.payload must be a non-empty string', [
      'unsignedTransaction',
    ]);
  }
  if (typeof shape.meta !== 'object' || shape.meta === null || Array.isArray(shape.meta)) {
    throw validation(requestId, 'unsignedTransaction.meta must be an object (passed back exactly as build returned it)', [
      'unsignedTransaction.meta',
    ]);
  }
  return body as unknown as SimulateTransactionRequest;
}

/**
 * Length contract for the `Idempotency-Key` header (TODO-007).
 *
 * Authoritative sources: `IdempotencyKey` / `IdempotencyKeyOptional` in `docs/api/openapi.yaml`,
 * both with `minLength: 8, maxLength: 128`.
 *
 * Why it is enforced in the Gateway: this is **structural validation** (shape/bounds), not a domain rule; enforcing it before entering the engine
 * guarantees that "structurally invalid requests are 400 in any deployment" and produces no idempotency records or nonce leases.
 * The upper bound matters most — the key becomes the idempotency record's primary key, and an unbounded string is an abusable input surface.
 *
 * A missing optional header returns undefined (build / simulate may omit it); when `required`, a missing header fails.
 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

function assertIdempotencyKey(
  value: string | undefined,
  requestId: RequestId,
  options: { readonly required: boolean; readonly operation: string },
): string | undefined {
  if (value === undefined) {
    if (options.required) {
      throw validation(requestId, `${options.operation} must carry the Idempotency-Key header`, ['Idempotency-Key']);
    }
    return undefined;
  }
  if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw validation(
      requestId,
      `Idempotency-Key length must be between ${IDEMPOTENCY_KEY_MIN_LENGTH}..${IDEMPOTENCY_KEY_MAX_LENGTH}`,
      ['Idempotency-Key'],
    );
  }
  return value;
}

function validation(requestId: RequestId, message: string, fields: readonly string[]): Error {
  return createDfrError('DFR_VALIDATION_FAILED', {
    requestId,
    message,
    details: { fields: [...fields] },
  });
}
