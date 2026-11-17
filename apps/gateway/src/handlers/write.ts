/**
 * M1 写端点 handler（DFR-M1-B07 build；B08 补 simulate）。
 *
 * 位置与职责见 docs/architecture/m1-api-contract.md 第 6 章"建议结构"：
 * 通用管线（鉴权 / 限流 / 闸门 / body）留在 `server.ts`，写端点的业务编排
 * 单独成文件，避免继续把全部逻辑堆进 `handle()`。
 *
 * 职责边界（gateway-spec 第 3 章第 7 步 + 第 8 节）：
 * - Gateway 只做**结构校验**（形状、必填字段），领域校验交给引擎 / Adapter；
 * - Gateway **不构造**错误语义，只把引擎抛出的 DFR 错误交给统一映射；
 * - Gateway 不落库、不分配 nonce、不做指纹 canonicalization（复用引擎实现）。
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
  /** `Idempotency-Key` 头；build 可选（gateway-spec 第 7.1 节）。 */
  readonly idempotencyKey?: string;
  /** 未装配 = 本部署未开放写路径；此时返回 422 而不是 500。 */
  readonly engine?: TransactionEngine;
  /**
   * 幂等"重放"的上报出口。
   *
   * 只有引擎知道本次 build 是否命中幂等记录（`BuiltTransactionResult.replayed`），
   * Gateway 在响应封套里不暴露该字段（A01 契约固定为三个字段），因此由 handler 主动上报，
   * 供 `dfr_gateway_idempotency_hits_total{outcome="replayed"}` 计数。
   */
  readonly onIdempotencyOutcome?: (outcome: 'replayed' | 'conflict') => void;
  /**
   * 网关级幂等协调器（DFR-M1-C04）。**广播**用它做"指纹 + 首次响应"重放；
   * build 的幂等在引擎内（按请求体指纹），两者作用域不同、不重复。
   */
  readonly idempotency?: GatewayIdempotencyCoordinator;
}

export interface WriteHandlerResult {
  readonly status: number;
  readonly body: unknown;
  /** 需要写进 HTTP 响应的额外头（例如幂等重放的 `Idempotency-Replayed`）。 */
  readonly headers?: Record<string, string>;
}

/** `POST /v1/transactions/build`（DFR-M1-B07）。成功码 200，见 OpenAPI 与 A01 契约测试。 */
export async function handleBuildTransaction(
  body: Record<string, unknown> | undefined,
  ctx: WriteHandlerContext,
): Promise<WriteHandlerResult> {
  // 顺序：结构校验（契约）先于"本部署是否装配了引擎"（能力 / 配置）。
  // 结构非法的请求在任何部署下都是 400，不因部署缺引擎而被改判。
  // Idempotency-Key 是可选头，但**一旦提供**就必须满足契约边界（TODO-007）。
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
 * `DELETE /v1/transactions/{transactionId}`（ADR-037 方案 A）。
 *
 * 作废一笔**未广播**的交易（`built` / `simulated`），释放它占用的 nonce 租约。
 * **幂等**：已 `abandoned` 再调返回 200（`leaseReleased=false`）。
 *
 * `signed` 及以上 → `422 DFR_TRANSACTION_REJECTED`（`reason: not_abandonable`）：
 * 已签名/已广播的 nonce **绝不**回收（资金安全，ADR-018/019）。
 *
 * 路径参数是 **DFR 内部执行标识**（`txn_<...>`），不是链上交易哈希。
 */
export async function handleAbandonTransaction(
  transactionId: string,
  ctx: WriteHandlerContext,
): Promise<WriteHandlerResult> {
  if (transactionId === '') {
    throw validation(ctx.requestId, '缺少 transactionId', ['transactionId']);
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
 * `POST /v1/transactions/preflight`（ADR-037 方案 B）。
 *
 * 只读预检：**不占 nonce、不落库、不写幂等表**。请求体与 build 相同
 * （`TransactionRequest`），响应封套 `{ unsignedTransaction, simulation, observedNonce?, requestId }`。
 *
 * 它为什么存在：`simulate` 必须先有 `transactionId`，而 `transactionId` 只在 build 时产生；
 * 因此在 preflight 之前，"这笔能不能过"只能靠 build，每次消耗一个链上 nonce——
 * 反复预检即留下永久空洞（ADR-037 的实测成因）。
 *
 * 回滚**不是** HTTP 错误：以 `simulation.success=false` 返回 200，让调用方把失败当信息读。
 * 这与 simulate 的 422 语义刻意不同——preflight **没有记录可落在 `reverted`**，
 * 也不该为了"统一"而伪造一个 4xx。
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
 * `POST /v1/transactions/simulate`（DFR-M1-B08）。
 *
 * 请求体 = `SimulateTransactionRequest`（transactionId + unsignedTransaction）。
 * 成功码 200，封套 `{ transactionId, simulation, requestId }`。
 *
 * 回滚**不是** HTTP 错误的一种"失败翻译"：引擎已把记录落为 `reverted` 并抛
 * `DFR_TRANSACTION_REVERTED`（B05），Gateway 只做状态码映射 → 422。
 * 绝不重新分类、绝不包装成 500（否则调用方会误判为服务故障）。
 *
 * 可选 `Idempotency-Key` 被接受但**不参与幂等判断**：simulate 由
 * `transactionId` 定位记录，重复调用是新观测（m1-api-contract 第 2 节）。
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
  // 键校验先于 body 解析：键非法时不需要也不应该解析载荷。
  const idempotencyKey = assertIdempotencyKey(ctx.idempotencyKey, ctx.requestId, {
    required: true,
    operation: 'broadcast',
  })!;
  const request = parseBroadcastRequest(body, ctx.requestId);

  // 网关级幂等（gateway-spec §7.2 / m1-api-contract §4）：
  // 指纹包含 chain / transactionId / **签名摘要** / rebroadcast。
  // 刻意用 `expectedHash`（= keccak256(signedPayload)）而不是原始 signedPayload：
  // 它既是规范要求的"签名摘要"，又避免处理签名原文（安全红线：原文不进日志/存储）。
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
        message: '同一幂等键已用于不同的广播请求',
      });
    }
    if (began.kind === 'in_flight') {
      ctx.onIdempotencyOutcome?.('conflict');
      throw createDfrError('DFR_IDEMPOTENCY_CONFLICT', {
        requestId: ctx.requestId,
        chain: request.signedTransaction.chain,
        message: '同一幂等键的广播正在处理中',
        details: { retryAfterMs: began.retryAfterMs },
      });
    }
    if (began.kind === 'replayed') {
      // 重放首次响应：状态码与 body 都取自记录，**不**重新执行广播。
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
  // 显式标注响应体类型：引擎的 BroadcastTransactionResult 必须与 OpenAPI/类型的
  // BroadcastTransactionOutcome 一致，否则这里会在 `pnpm typecheck` 直接失败。
  // DFR-M1-E03 修正了此前"声明 BroadcastResult（ref）但实际返回 txHash"的漂移。
  const responseBody: BroadcastTransactionResponse = {
    transactionId: result.transactionId,
    broadcast: result,
    requestId: ctx.requestId,
  };
  if (coordinator !== undefined && idempotencyOwner !== undefined) {
    // 记录首次响应，供同键重放返回。丢失所有权（被接管）时结果仍真实，
    // 只是不保证下次能重放 —— 不因此改判请求失败。
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
  if (txHash === '') throw validation(ctx.requestId, 'txHash 必须非空', ['txHash']);
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
    throw validation(requestId, 'chain 必须是非空字符串', ['chain']);
  }
  const minFinality = body['minFinality'];
  if (minFinality !== undefined && !['submitted', 'included', 'confirmed', 'finalized'].includes(String(minFinality))) {
    throw validation(requestId, 'minFinality 取值无效', ['minFinality']);
  }
  const timeoutMs = body['timeoutMs'];
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)) {
    throw validation(requestId, 'timeoutMs 必须是 1000..600000 范围内的整数', ['timeoutMs']);
  }
  return {
    chain: body['chain'] as ConfirmTransactionRequest['chain'],
    ...(minFinality !== undefined ? { minFinality: minFinality as NonNullable<ConfirmTransactionRequest['minFinality']> } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function parseBroadcastRequest(body: Record<string, unknown> | undefined, requestId: RequestId): { transactionId: TransactionId; signedTransaction: SignedTransaction; rebroadcast?: boolean } {
  if (body === undefined || typeof body.transactionId !== 'string' || body.transactionId === '' || body.signedTransaction === null || typeof body.signedTransaction !== 'object') {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'broadcast 请求体结构无效', details: { fields: ['transactionId', 'signedTransaction'] } });
  }
  const signed = body.signedTransaction as Record<string, unknown>;
  if (typeof signed.schemaVersion !== 'string' || typeof signed.chain !== 'string' || typeof signed.signedPayload !== 'string' || typeof signed.expectedHash !== 'string' || signed.unsigned === null || typeof signed.unsigned !== 'object') {
    throw createDfrError('DFR_VALIDATION_FAILED', { requestId, message: 'signedTransaction 结构无效' });
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
      message: '本部署未装配交易引擎，写路径不可用',
      details: { capability },
    });
  }
  return engine;
}

/**
 * build 请求的结构校验（Gateway 职责边界）。
 *
 * 只判断"形状"：`chain` 是非空字符串、`from` 是带 `address` 的对象（`to` / `value`
 * 若出现也必须是对象）。地址格式、链是否支持、金额语义等**领域校验**交给 Adapter /
 * 引擎（gateway-spec 第 3 章第 7 步："契约校验只做结构匹配"）。
 *
 * `nonce` 不在结构校验里：它会被原样传给引擎，由引擎以 `DFR_VALIDATION_FAILED`
 * 拒绝（M1 的 nonce 由服务端分配并落租约）。
 */
export function parseBuildRequest(
  body: Record<string, unknown> | undefined,
  requestId: RequestId,
): TransactionRequest {
  if (body === undefined) {
    throw validation(requestId, '缺少请求体', ['body']);
  }
  if (typeof body['chain'] !== 'string' || body['chain'] === '') {
    throw validation(requestId, 'chain 必须是非空字符串', ['chain']);
  }
  for (const field of ['from', 'to'] as const) {
    const value = body[field];
    if (value === undefined) {
      if (field === 'from') throw validation(requestId, '缺少 from', ['from']);
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw validation(requestId, `${field} 必须是对象`, [field]);
    }
    if (typeof (value as { address?: unknown }).address !== 'string') {
      throw validation(requestId, `${field}.address 必须是字符串`, [field]);
    }
  }
  const value = body['value'];
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw validation(requestId, 'value 必须是对象', ['value']);
  }
  // 原样透传：未知字段由引擎 / Adapter 各自 fail-closed，Gateway 不做领域裁剪。
  return body as unknown as TransactionRequest;
}

/**
 * simulate 请求的结构校验。
 *
 * 只判断形状：`transactionId` 是非空字符串、`unsignedTransaction` 是普通对象
 * （必须带字符串 `payload` 与字符串 `chain`——缺了就不是一个载荷）。
 * "载荷是否与已保存 build 一致"属**领域绑定校验**，由引擎在 RPC 之前完成
 * （B05），Gateway 不越界。
 */
export function parseSimulateRequest(
  body: Record<string, unknown> | undefined,
  requestId: RequestId,
): SimulateTransactionRequest {
  if (body === undefined) {
    throw validation(requestId, '缺少请求体', ['body']);
  }
  const transactionId = body['transactionId'];
  if (typeof transactionId !== 'string' || transactionId === '') {
    throw validation(requestId, 'transactionId 必须是非空字符串', ['transactionId']);
  }
  const unsigned = body['unsignedTransaction'];
  if (typeof unsigned !== 'object' || unsigned === null || Array.isArray(unsigned)) {
    throw validation(requestId, 'unsignedTransaction 必须是对象', ['unsignedTransaction']);
  }
  // OpenAPI 的 `UnsignedTransaction.required` 是 [schemaVersion, chain, payload, meta]。
  // 这里逐项做**形状**校验：漏掉 meta 会让引擎在 `unsigned.meta.requiresNonce` 抛
  // TypeError，把调用方的输入错误伪装成 500（真实链验收 2026-10-06 踩到）。
  const shape = unsigned as { schemaVersion?: unknown; chain?: unknown; payload?: unknown; meta?: unknown };
  if (shape.schemaVersion !== '1') {
    throw validation(requestId, 'unsignedTransaction.schemaVersion 必须是 "1"', [
      'unsignedTransaction.schemaVersion',
    ]);
  }
  if (typeof shape.chain !== 'string' || shape.chain === '') {
    throw validation(requestId, 'unsignedTransaction.chain 必须是非空字符串', [
      'unsignedTransaction',
    ]);
  }
  if (typeof shape.payload !== 'string' || shape.payload === '') {
    throw validation(requestId, 'unsignedTransaction.payload 必须是非空字符串', [
      'unsignedTransaction',
    ]);
  }
  if (typeof shape.meta !== 'object' || shape.meta === null || Array.isArray(shape.meta)) {
    throw validation(requestId, 'unsignedTransaction.meta 必须是对象（build 原样回传）', [
      'unsignedTransaction.meta',
    ]);
  }
  return body as unknown as SimulateTransactionRequest;
}

/**
 * `Idempotency-Key` 头的长度契约（TODO-007）。
 *
 * 权威来源：`docs/api/openapi.yaml` 的 `IdempotencyKey` / `IdempotencyKeyOptional`，
 * 两者均为 `minLength: 8, maxLength: 128`。
 *
 * 为什么在 Gateway 强制：这是**结构校验**（形状/边界），不是领域规则；放在进入引擎之前
 * 才能保证"结构非法的请求在任何部署下都是 400"，且不产生任何幂等记录或 nonce 租约。
 * 上界尤其重要——键会成为幂等记录的主键，无界字符串是可被滥用的输入面。
 *
 * 可选头缺失时返回 undefined（build / simulate 允许不带）；`required` 时缺失即失败。
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
      throw validation(requestId, `${options.operation} 必须携带 Idempotency-Key 头`, ['Idempotency-Key']);
    }
    return undefined;
  }
  if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw validation(
      requestId,
      `Idempotency-Key 长度必须在 ${IDEMPOTENCY_KEY_MIN_LENGTH}..${IDEMPOTENCY_KEY_MAX_LENGTH} 之间`,
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
