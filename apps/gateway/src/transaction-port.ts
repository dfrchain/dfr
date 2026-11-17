/**
 * Transaction Engine 的链访问端口实现（DFR-M1-B07，composition root 的一部分）。
 *
 * 权威来源：docs/architecture/development-plan.md 第 4.3/4.4 节、
 * docs/architecture/adapter-spec-v0.1.md 第 8.1 节。
 *
 * 为什么需要这一层：`@dfr/transaction` 不得 import Adapter / Provider / Core
 * （AGENTS.md 第 3 节依赖方向），所以它只认识 `TransactionChainPort` 端口；
 * 把端口接到真实链路是 composition root 的职责，本文件就是那根接线。
 *
 * 装配出来的端口保证：
 *   1. `getPendingNonce` 走 `eth_getTransactionCount(from,'pending')`，返回十进制字符串；
 *   2. `build` 使用 Engine 已经分配的显式 nonce（Adapter 不再自行查 nonce，
 *      否则链上读数与 nonce 租约可能不一致）；
 *   3. `simulate` 把记录里的 `from` 交给 Adapter，让余额 / 授权 / nonce 检查生效
 *      （`UnsignedTransaction` 本身不含发送方）；
 *   4. `broadcast` 把记录真值（`from` + unsigned 载荷）交给 Adapter 做完整绑定校验，
 *      客户端回传的 unsigned 只是回声、不作数（M1-C03a）；
 *   5. `observe` 在广播结果不确定时按 expectedHash 观测链上处境（M1-C03b），
 *      字段全部来自记录，不接受调用方声明。
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

/** 端口输入 → Core 调用上下文；缺省 requestId 只为兼容手写调用，正常由 Engine 透传。 */
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
 * 用 Core 装配 `TransactionChainPort`。
 *
 * Core 负责 Capability 路由与错误归一化；非 EVM 链族（或未启用写能力的链）在这里
 * fail-closed：未知链 → `DFR_NOT_FOUND`，链存在但 Adapter 未实现对应方法 →
 * `DFR_UNSUPPORTED_CAPABILITY`。**不**静默降级到 EVM 语义。
 */
export function createCoreTransactionChainPort(core: DfrCore): TransactionChainPort {
  return {
    getPendingNonce: (input) => core.getPendingNonce(input.chain, input.account, context(input)),

    // ADR-033：链无关排序前提（EVM nonce / Solana blockhash）。
    getSequencingToken: (input) =>
      core.getSequencingToken(input.chain, input.account, context(input)),

    // ADR-033：把引擎分配的排序前提注入请求（Solana 用它固定 blockhash）。
    withSequencingToken: (request, token) =>
      core.withSequencingToken(request.chain, request, token),

    // B43: real Adapter block-height freshness check immediately before send.
    // DfrCore requires this capability for blockhash; it does not guess false.
    isSequencingExpired: (input) =>
      core.isSequencingExpired(input.chain, input.token, context(input)),

    build: (input) => core.buildTransaction(input.request.chain, input.request, context(input)),

    /**
     * 只读模拟。`from` 必须来自记录（Engine 提供），否则 Adapter 只能退化到
     * "节点默认发送方"并在 `warnings` 里标注——那是 B03 的兼容行为，不是写路径常态。
     */
    simulate: (input) =>
      core.simulateTransaction(input.unsigned.chain, input.unsigned, context(input), {
        from: input.from,
      }),

    /**
     * 单次广播（M1-C03a）。记录真值（from / unsigned 载荷）与 `rebroadcast` 一起交给
     * Adapter：只有 Adapter 能做链语义绑定（公钥恢复），Core 只搬运。
     */
    broadcast: (input) =>
      core.broadcastTransaction(input.signed.chain, input.signed, context(input), {
        ...(input.options ?? {}),
        expectedFrom: input.expected.from,
        expectedUnsignedPayload: input.expected.unsignedPayload,
      }),

    /**
     * 广播结果不确定时的链上观测（M1-C03b）。全部字段来自记录（expectedHash / from / nonce），
     * 不接受调用方声明；只读，不会重发广播。
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
