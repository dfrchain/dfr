/**
 * 交易状态机（DFR-M1-A05）。
 *
 * 权威边集：docs/architecture/transaction-lifecycle.md 第 3.1 节状态转移表。
 * 本模块是**纯函数**：不接触数据库、Provider、链或时钟，只回答
 * "从这个状态收到这个事件，允许迁移到哪里"。
 *
 * 设计要点：
 *
 * 1. **表驱动**：允许边集中在 `ALLOWED_TRANSITIONS`，实现不含分散的 if/switch。
 *    规范表格变化时只改表，不必追改逻辑。
 * 2. **终态优先**：终态保护在查表**之前**判断，因此终态永远得到 `TERMINAL_STATE`，
 *    不会被"恰好没这条边"的 `INVALID_TRANSITION` 掩盖。
 * 3. **原因码稳定**：`TransitionRejectionReason` 是状态机自身的词汇，
 *    不是 `DFR_*` 错误码。HTTP 层负责把它映射成对外错误。
 * 4. **`orphaned` 不是交易状态**：重组把 `included` 回退到 `pending`，
 *    重组事实由 `chain.reorg` 事件与区块观测状态（`FinalityState`）表达。
 *
 * 不在本模块范围内（由调用方 / 后续任务负责）：
 *   - 迁移的前置条件中除 `rebroadcast` 旗标外的部分
 *     （是否已授权跳过模拟、`FinalityPolicy` 是否满足、`dropTimeoutMs` 是否超过）；
 *   - 持久化、并发控制、事件发布。
 */

import type { TransactionStatus } from '@dfr/types';

/**
 * 触发状态迁移的事件。
 *
 * 命名刻意区分"模拟失败"与"链上执行失败"：二者目标都是 `reverted`，
 * 但来源状态完全不同（前者只能来自 `built`，后者适用于所有非终态）。
 */
export type TransactionEvent =
  | 'build'
  | 'simulate.succeeded'
  | 'simulate.failed'
  | 'sign'
  | 'broadcast.accepted'
  | 'broadcast.rejected'
  /**
   * 广播结果不确定（ADR-019）：请求已发出，但既未确认接受也未确认拒绝。
   *
   * TX-02：当前 RPC 拒绝并不证明其它节点没有传播已签名哈希，
   * 因此此类拒绝也走 `broadcast.indeterminate → unknown`，由只读链上观测解析。
   * `broadcast.rejected → failed` 仅保留给可本地验证的不可再上链条件
   * （当前为过期 Solana blockhash）；不得把普通 RPC 拒绝当全网事实。
   */
  | 'broadcast.indeterminate'
  /** TX-04: only an explicit dropped→broadcast retry may record this uncertain outcome. */
  | 'rebroadcast.indeterminate'
  | 'mempool.entered'
  | 'included'
  | 'confirmed'
  | 'finalized'
  | 'dropped'
  | 'replaced'
  | 'rebroadcast'
  | 'reorg'
  /**
   * 显式作废一笔**未广播**的交易（ADR-037）。仅 `built` / `simulated` 接受该事件；
   * `signed` 及以上不配边，因此到达即 `TERMINAL_STATE` 或"无此边"。
   */
  | 'abandon'
  | 'execution.failed';

/** 迁移被拒的稳定原因码。 */
export type TransitionRejectionReason =
  /** 起始状态是终态，任何事件都不能再迁移。 */
  | 'TERMINAL_STATE'
  /** 规范第 3.1 节没有定义这条边。 */
  | 'INVALID_TRANSITION'
  /** `dropped → broadcast` 必须显式携带 `rebroadcast: true`，防止隐式第二次广播。 */
  | 'REBROADCAST_FLAG_REQUIRED';

/**
 * 终态（transaction-lifecycle.md 第 3.2 节）。
 *
 * `dropped` **不是**终态：它仍可在时限内以同一 nonce 重播。
 */
export const TERMINAL_STATUSES: readonly TransactionStatus[] = [
  'finalized',
  'reverted',
  'failed',
  'replaced',
  // ADR-037：被显式作废；终态，没有任何出边。
  'abandoned',
];

/** 一条允许边。`from === null` 表示交易尚未创建。 */
export interface TransitionSpec {
  readonly from: TransactionStatus | null;
  readonly event: TransactionEvent;
  readonly to: TransactionStatus;
  /** 为 true 时，调用方必须显式传 `rebroadcast: true`。 */
  readonly requiresRebroadcast?: boolean;
}

/**
 * 规范第 3.1 节的完整允许边集。
 *
 * 规范表格的 `*` 行（链上执行失败）按字面展开为全部 9 个非终态；
 * 另有 ADR-019 定义的 5 条 `unknown` 边（1 条入边 + 4 条解析出边）
 * 与 ADR-023 定义的 3 条 `dropped` 收敛边。
 * 此外 TX-04 增加一条 `broadcast + rebroadcast.indeterminate → unknown` 专用边。
 * 边集总数以 ALLOWED_TRANSITIONS 长度为准，测试锁定当前集合。
 * 终态不入表：任何 `from` 为终态的请求都在查表前被 `TERMINAL_STATE` 拦截。
 */
export const ALLOWED_TRANSITIONS: readonly TransitionSpec[] = [
  // （无）→ built
  { from: null, event: 'build', to: 'built' },

  // built
  { from: 'built', event: 'simulate.succeeded', to: 'simulated' },
  // ADR-037：显式作废（DELETE /v1/transactions/{id}）。只从 built/simulated 可达——
  // signed 及以上一律 fail-closed，绝不让"已签名/已广播"的交易走到这里。
  { from: 'built', event: 'abandon', to: 'abandoned' },
  { from: 'built', event: 'simulate.failed', to: 'reverted' },
  { from: 'built', event: 'sign', to: 'signed' },

  // simulated
  { from: 'simulated', event: 'sign', to: 'signed' },
  { from: 'simulated', event: 'abandon', to: 'abandoned' },

  // signed
  { from: 'signed', event: 'broadcast.accepted', to: 'broadcast' },
  { from: 'signed', event: 'broadcast.rejected', to: 'failed' },
  // 广播结果不确定：只进 unknown，绝不直接判 failed（ADR-019）。
  { from: 'signed', event: 'broadcast.indeterminate', to: 'unknown' },

  // broadcast
  // TX-04: an explicit retry starts at dropped→broadcast. If its RPC call
  // errors, the outcome is unknowable: preserve the original hash/nonce,
  // enter unknown and observe. Never turn this into failed/rejected or re-send.
  { from: 'broadcast', event: 'rebroadcast.indeterminate', to: 'unknown' },
  { from: 'broadcast', event: 'mempool.entered', to: 'pending' },

  // pending
  { from: 'pending', event: 'included', to: 'included' },
  { from: 'pending', event: 'dropped', to: 'dropped' },
  { from: 'pending', event: 'replaced', to: 'replaced' },

  // included
  { from: 'included', event: 'confirmed', to: 'confirmed' },
  { from: 'included', event: 'reorg', to: 'pending' },

  // confirmed
  { from: 'confirmed', event: 'finalized', to: 'finalized' },

  // dropped：既可在时限内重播（须显式 rebroadcast），也可被后续观测纠正（ADR-023）。
  // 为什么需要后面三条收敛边：`dropped` 是**判断**（"此刻链上没有"），不是不可逆事实。
  // 缺少它们时，一次误判会让记录永久停在 dropped——对一笔实际已确认的交易报告"已丢弃"。
  { from: 'dropped', event: 'rebroadcast', to: 'broadcast', requiresRebroadcast: true },
  { from: 'dropped', event: 'mempool.entered', to: 'pending' },
  { from: 'dropped', event: 'included', to: 'included' },
  { from: 'dropped', event: 'replaced', to: 'replaced' },

  // unknown（ADR-019）：按链上观测解析；没有 unknown → broadcast，
  // 重播必须经 dropped → rebroadcast，避免"超时后自动第二次广播"。
  { from: 'unknown', event: 'mempool.entered', to: 'pending' },
  { from: 'unknown', event: 'included', to: 'included' },
  { from: 'unknown', event: 'dropped', to: 'dropped' },
  { from: 'unknown', event: 'replaced', to: 'replaced' },

  // `*` 行：链上执行失败（收据 status = 0），适用于全部非终态。
  { from: 'built', event: 'execution.failed', to: 'reverted' },
  { from: 'simulated', event: 'execution.failed', to: 'reverted' },
  { from: 'signed', event: 'execution.failed', to: 'reverted' },
  { from: 'broadcast', event: 'execution.failed', to: 'reverted' },
  { from: 'pending', event: 'execution.failed', to: 'reverted' },
  { from: 'included', event: 'execution.failed', to: 'reverted' },
  { from: 'confirmed', event: 'execution.failed', to: 'reverted' },
  { from: 'dropped', event: 'execution.failed', to: 'reverted' },
  { from: 'unknown', event: 'execution.failed', to: 'reverted' },
];

/**
 * 全部已声明事件，从边集派生。
 *
 * 派生而非手写：保证"有事件但没有边"或"有边但没有事件"都不可能存在。
 */
export const TRANSACTION_EVENTS: readonly TransactionEvent[] = [
  ...new Set(ALLOWED_TRANSITIONS.map((spec) => spec.event)),
];

export interface TransitionInput {
  /** 当前状态；`null` 表示交易尚未创建。 */
  readonly from: TransactionStatus | null;
  readonly event: TransactionEvent;
  /** 仅 `dropped → broadcast` 需要；必须显式为 `true`。 */
  readonly rebroadcast?: boolean;
}

export interface TransitionAllowed {
  readonly ok: true;
  readonly status: TransactionStatus;
}

export interface TransitionRejected {
  readonly ok: false;
  readonly reason: TransitionRejectionReason;
  /** 回显输入，便于审计与排障。 */
  readonly from: TransactionStatus | null;
  readonly event: TransactionEvent;
}

export type TransitionResult = TransitionAllowed | TransitionRejected;

function isTerminal(status: TransactionStatus | null): boolean {
  return status !== null && TERMINAL_STATUSES.includes(status);
}

/**
 * 计算一次状态迁移。
 *
 * 判定顺序（顺序本身是契约的一部分）：
 *   1. 终态保护 → `TERMINAL_STATE`
 *   2. 是否命中规范定义的边 → 否则 `INVALID_TRANSITION`
 *   3. 该边是否要求 `rebroadcast: true` → 否则 `REBROADCAST_FLAG_REQUIRED`
 */
export function transition(input: TransitionInput): TransitionResult {
  const { from, event } = input;

  if (isTerminal(from)) {
    return { ok: false, reason: 'TERMINAL_STATE', from, event };
  }

  const spec = ALLOWED_TRANSITIONS.find((s) => s.from === from && s.event === event);
  if (!spec) {
    return { ok: false, reason: 'INVALID_TRANSITION', from, event };
  }

  if (spec.requiresRebroadcast && input.rebroadcast !== true) {
    return { ok: false, reason: 'REBROADCAST_FLAG_REQUIRED', from, event };
  }

  return { ok: true, status: spec.to };
}

/** 只读辅助：该边是否允许，不返回原因。 */
export function canTransition(input: TransitionInput): boolean {
  return transition(input).ok;
}
