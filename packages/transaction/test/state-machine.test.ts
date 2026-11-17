/**
 * 交易状态机契约测试（DFR-M1-A05）。
 *
 * 权威边集：docs/architecture/transaction-lifecycle.md 第 3.1 节状态转移表。
 *
 * 本测试的目的不是"给实现补测试"，而是把规范表格逐行变成可回归断言：
 *   - 每一条允许边都有断言；
 *   - 终态保护、非法边、重复建单都有负对照；
 *   - 状态集合与 `@dfr/types` 的 `TransactionStatus` 在编译期与运行期双向绑定，
 *     使"类型加了状态但状态机没跟上"这类漂移立刻失败。
 */
import { describe, expect, it } from 'vitest';
import type { TransactionStatus } from '@dfr/types';
import {
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
  TRANSACTION_EVENTS,
  transition,
  type TransactionEvent,
  type TransitionResult,
} from '../src/state-machine.js';

const ALL_STATUSES = [
  'built',
  'simulated',
  'signed',
  'broadcast',
  'pending',
  'included',
  'confirmed',
  'finalized',
  'failed',
  'reverted',
  'dropped',
  'replaced',
  'unknown',
  // ADR-037：被显式作废的未广播交易（终态）。
  'abandoned',
] as const satisfies readonly TransactionStatus[];

/**
 * 编译期穷尽性守卫。
 *
 * `Record<TransactionStatus, ...>` 要求覆盖每一个状态：若 `TransactionStatus`
 * 新增取值而这里没补，`pnpm typecheck` 会直接报错，而不是让状态机静默漏掉新状态。
 */
const COVERAGE_REASON: Record<TransactionStatus, string> = {
  built: 'allowed：simulate.succeeded / simulate.failed / sign / abandon（ADR-037）',
  simulated: 'allowed：sign / abandon（ADR-037）',
  signed: 'allowed：broadcast.accepted / broadcast.rejected',
  broadcast: 'allowed：mempool.entered / rebroadcast.indeterminate（TX-04）',
  pending: 'allowed：included / dropped / replaced',
  included: 'allowed：confirmed / reorg',
  confirmed: 'allowed：finalized',
  finalized: 'terminal：拒绝全部事件',
  failed: 'terminal：拒绝全部事件',
  reverted: 'terminal：拒绝全部事件',
  replaced: 'terminal：拒绝全部事件',
  dropped: 'allowed：rebroadcast（须显式 rebroadcast=true）',
  unknown: 'allowed：mempool.entered / included / dropped / replaced（ADR-019）',
  abandoned: 'terminal：拒绝全部事件（ADR-037，只从 built/simulated 可达）',
};

function ok(result: TransitionResult): result is Extract<TransitionResult, { ok: true }> {
  return result.ok;
}

describe('状态集合与类型契约', () => {
  it('ALLOWED_TRANSITIONS 覆盖的状态集合与 TransactionStatus 完全一致', () => {
    const referenced = new Set<string>(TERMINAL_STATUSES);
    for (const spec of ALLOWED_TRANSITIONS) {
      if (spec.from !== null) referenced.add(spec.from);
      referenced.add(spec.to);
    }
    expect([...referenced].sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('编译期穷尽性守卫覆盖每个状态（缺失会由 typecheck 拦截）', () => {
    expect(Object.keys(COVERAGE_REASON).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('每个状态都有明确归类：终态或有出边（无遗留缺口）', () => {
    for (const status of ALL_STATUSES) {
      const hasOutgoing = ALLOWED_TRANSITIONS.some((s) => s.from === status);
      const isTerminal = TERMINAL_STATUSES.includes(status);
      expect(
        hasOutgoing || isTerminal,
        `${status}: ${COVERAGE_REASON[status]}`,
      ).toBe(true);
    }
  });

  it('unknown 的入边与解析出边由 ADR-019 定义（DFR-M1-C03b 关闭 TODO-006）', () => {
    const intoUnknown = ALLOWED_TRANSITIONS.filter((s) => s.to === 'unknown');
    // 首次发送和显式重播各一条进入 unknown 的事件；不允许其他状态绕过。
    expect(intoUnknown).toEqual([
      { from: 'signed', event: 'broadcast.indeterminate', to: 'unknown' },
      { from: 'broadcast', event: 'rebroadcast.indeterminate', to: 'unknown' },
    ]);

    const fromUnknown = ALLOWED_TRANSITIONS.filter((s) => s.from === 'unknown');
    expect(fromUnknown.map((s) => s.event).sort()).toEqual(
      ['execution.failed', 'included', 'mempool.entered', 'replaced', 'dropped'].sort(),
    );
  });

  it('unknown 不是终态：必须能被恢复扫描接手（m1-storage-model 第 6 节）', () => {
    expect([...TERMINAL_STATUSES]).not.toContain('unknown');
  });

  it('不存在 unknown → broadcast 的边：重播只能经 dropped → rebroadcast（防自动二次广播）', () => {
    const direct = ALLOWED_TRANSITIONS.filter(
      (s) => s.from === 'unknown' && s.to === 'broadcast',
    );
    expect(direct, 'unknown 不得直接回到 broadcast').toEqual([]);
    // 唯一的重播入口：dropped --rebroadcast--> broadcast，且必须显式带标记。
    const rebroadcast = ALLOWED_TRANSITIONS.filter((s) => s.event === 'rebroadcast');
    expect(rebroadcast).toEqual([
      { from: 'dropped', event: 'rebroadcast', to: 'broadcast', requiresRebroadcast: true },
    ]);
  });

  it('状态机中不存在 orphaned 交易状态（DFR-M1-A05 决议）', () => {
    expect([...ALL_STATUSES]).not.toContain('orphaned');
    const targets = ALLOWED_TRANSITIONS.map((s) => s.to);
    expect(targets).not.toContain('orphaned');
  });
});

describe('允许边（逐行对应 transaction-lifecycle.md 第 3.1 节）', () => {
  for (const spec of ALLOWED_TRANSITIONS) {
    const label = `${spec.from ?? '（无）'} --${spec.event}--> ${spec.to}`;
    it(`允许：${label}`, () => {
      const result = transition({
        from: spec.from,
        event: spec.event,
        // 需要用 rebroadcast 旗标的边，测试里显式给出，旗标缺失由专门的负对照覆盖。
        ...(spec.requiresRebroadcast ? { rebroadcast: true } : {}),
      });
      expect(ok(result), `${label} 应被允许，实际被拒：${JSON.stringify(result)}`).toBe(true);
      if (ok(result)) expect(result.status).toBe(spec.to);
    });
  }

  it('边集与规范表格一致：16 行 = 15 条具名边 + `*` 行展开为 9 个非终态', () => {
    // 规范表格原有 16 行（15 条具名 + `*`）；ADR-019 新增 5 条具名边
    // （`signed → unknown` 与 4 条 unknown 解析出边），故具名边共 20 条。
    // `*` 按字面适用于全部 9 个非终态，展开为 9 条。
    // 合计 20 + 9 = 29 条。终态不入表（由终态保护拦截）。
    // ADR-023 新增 3 条 dropped 收敛边（→ pending / included / replaced）。
    // ADR-037 新增 2 条 abandon 边（built/simulated → abandoned），合计 34 条。
    expect(ALLOWED_TRANSITIONS).toHaveLength(35);

    const nonTerminal = ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));
    expect(nonTerminal).toHaveLength(9);
    const starRow = ALLOWED_TRANSITIONS.filter((s) => s.event === 'execution.failed');
    expect(starRow.map((s) => s.from).sort()).toEqual([...nonTerminal].sort());
  });
});

describe('终态保护', () => {
  it('终态集合与规范第 3.2 节一致（dropped 不是终态）', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      // ADR-037 新增终态 abandoned。
      ['abandoned', 'failed', 'finalized', 'replaced', 'reverted'].sort(),
    );
    expect(TERMINAL_STATUSES).not.toContain('dropped');
  });

  for (const status of ['finalized', 'failed', 'reverted', 'replaced', 'abandoned'] as const) {
    it(`终态 ${status} 拒绝全部 ${TRANSACTION_EVENTS.length} 个事件`, () => {
      for (const event of TRANSACTION_EVENTS) {
        const result = transition({ from: status, event, rebroadcast: true });
        expect(ok(result), `${status} + ${event} 不应被允许`).toBe(false);
        if (!ok(result)) expect(result.reason).toBe('TERMINAL_STATE');
      }
    });
  }

  it('终态不会被 reorg 普通路径覆盖', () => {
    for (const status of ['finalized', 'reverted'] as const) {
      const result = transition({ from: status, event: 'reorg' });
      expect(ok(result)).toBe(false);
      if (!ok(result)) expect(result.reason).toBe('TERMINAL_STATE');
    }
  });
});

describe('建单边界', () => {
  it('无状态 + build 是唯一可用的入口', () => {
    const result = transition({ from: null, event: 'build' });
    expect(ok(result)).toBe(true);
    if (ok(result)) expect(result.status).toBe('built');
  });

  it('无状态时除 build 外全部被拒（INVALID_TRANSITION）', () => {
    for (const event of TRANSACTION_EVENTS) {
      if (event === 'build') continue;
      const result = transition({ from: null, event });
      expect(ok(result), `null + ${event} 不应被允许`).toBe(false);
      if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
    }
  });

  it('已有状态时不能再 build（禁止重复建单）', () => {
    for (const status of ALL_STATUSES) {
      const result = transition({ from: status, event: 'build' });
      expect(ok(result), `${status} + build 不应被允许`).toBe(false);
      expect(ok(result) ? undefined : result.reason).toBe(
        TERMINAL_STATUSES.includes(status) ? 'TERMINAL_STATE' : 'INVALID_TRANSITION',
      );
    }
  });
});

describe('禁止边（非终态的非法事件）', () => {
  it('signed 不能直接跳到 included（必须经过 broadcast → pending）', () => {
    const result = transition({ from: 'signed', event: 'included' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('pending 不能直接 finalized（禁止跳级，避免谎报最终性）', () => {
    const result = transition({ from: 'pending', event: 'finalized' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('confirmed 不能被普通 dropped 覆盖（只允许 finalized）', () => {
    const result = transition({ from: 'confirmed', event: 'dropped' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('built 不能直接 broadcast.accepted（必须先 sign）', () => {
    const result = transition({ from: 'built', event: 'broadcast.accepted' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('reverted 不能被 simulate 成功覆盖（模拟失败是终点）', () => {
    const result = transition({ from: 'reverted', event: 'simulate.succeeded' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('TERMINAL_STATE');
  });
});

describe('dropped → broadcast 重播边', () => {
  it('缺少 rebroadcast 旗标时被拒（防止隐式第二次广播）', () => {
    const result = transition({ from: 'dropped', event: 'rebroadcast' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('REBROADCAST_FLAG_REQUIRED');
  });

  it('显式 rebroadcast=false 同样被拒', () => {
    const result = transition({ from: 'dropped', event: 'rebroadcast', rebroadcast: false });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('REBROADCAST_FLAG_REQUIRED');
  });

  it('显式 rebroadcast=true 放行并回到 broadcast', () => {
    const result = transition({ from: 'dropped', event: 'rebroadcast', rebroadcast: true });
    expect(ok(result)).toBe(true);
    if (ok(result)) expect(result.status).toBe('broadcast');
  });

  it('dropped 不接受普通 broadcast.accepted（避免把重播伪装成首次广播）', () => {
    const result = transition({ from: 'dropped', event: 'broadcast.accepted' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) expect(result.reason).toBe('INVALID_TRANSITION');
  });
});

describe('重组回退', () => {
  it('included + reorg 回退到 pending', () => {
    const result = transition({ from: 'included', event: 'reorg' });
    expect(ok(result)).toBe(true);
    if (ok(result)) expect(result.status).toBe('pending');
  });

  it('回退后仍可按既有边继续推进（pending → included）', () => {
    const afterReorg = transition({ from: 'included', event: 'reorg' });
    expect(ok(afterReorg)).toBe(true);
    if (!ok(afterReorg)) return;
    const reIncluded = transition({ from: afterReorg.status, event: 'included' });
    expect(ok(reIncluded)).toBe(true);
    if (ok(reIncluded)) expect(reIncluded.status).toBe('included');
  });

  it('回退后超过时限仍可收敛到 dropped', () => {
    const afterReorg = transition({ from: 'included', event: 'reorg' });
    expect(ok(afterReorg)).toBe(true);
    if (!ok(afterReorg)) return;
    const dropped = transition({ from: afterReorg.status, event: 'dropped' });
    expect(ok(dropped)).toBe(true);
    if (ok(dropped)) expect(dropped.status).toBe('dropped');
  });

  it('未见过的 (状态, 事件) 组合一律 INVALID_TRANSITION，且不回显领域错误码', () => {
    const result = transition({ from: 'pending', event: 'reorg' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) {
      expect(result.reason).toBe('INVALID_TRANSITION');
      // 原因码是稳定的状态机词汇，不是 HTTP/DFR 错误码。
      expect(result.reason.startsWith('DFR_')).toBe(false);
    }
  });
});

describe('execution.failed 的 `*` 边', () => {
  it('对每个非终态都适用（规范第 3.1 节 `*` 行）', () => {
    for (const status of ALL_STATUSES) {
      if (TERMINAL_STATUSES.includes(status)) continue;
      const result = transition({ from: status, event: 'execution.failed' });
      expect(ok(result), `${status} + execution.failed 应被允许`).toBe(true);
      if (ok(result)) expect(result.status).toBe('reverted');
    }
  });

  it('对终态不适用', () => {
    for (const status of TERMINAL_STATUSES) {
      const result = transition({ from: status, event: 'execution.failed' });
      expect(ok(result)).toBe(false);
      if (!ok(result)) expect(result.reason).toBe('TERMINAL_STATE');
    }
  });
});

describe('纯函数性质', () => {
  it('相同输入产生相同结果（无隐藏状态）', () => {
    const a = transition({ from: 'pending', event: 'included' });
    const b = transition({ from: 'pending', event: 'included' });
    expect(a).toEqual(b);
  });

  it('不修改入参对象', () => {
    const input = { from: 'dropped' as TransactionStatus, event: 'rebroadcast' as TransactionEvent };
    const snapshot = { ...input };
    transition(input);
    expect(input).toEqual(snapshot);
  });

  it('拒绝结果携带原始 from/event 以便审计', () => {
    const result = transition({ from: 'pending', event: 'finalized' });
    expect(ok(result)).toBe(false);
    if (!ok(result)) {
      expect(result.from).toBe('pending');
      expect(result.event).toBe('finalized');
    }
  });
});

describe('TX-04: failed explicit retry records indeterminate without enabling automatic broadcasts', () => {
  it('broadcast can enter unknown only on the dedicated rebroadcast.indeterminate event', () => {
    expect(transition({ from: 'broadcast', event: 'rebroadcast.indeterminate' }))
      .toEqual({ ok: true, status: 'unknown' });
    expect(transition({ from: 'broadcast', event: 'broadcast.indeterminate' }).ok).toBe(false);
    expect(transition({ from: 'broadcast', event: 'broadcast.rejected' }).ok).toBe(false);
  });

  it('no other nonterminal status gets an implicit retry-indeterminate edge', () => {
    for (const from of ALL_STATUSES) {
      if (from === 'broadcast') continue;
      expect(transition({ from, event: 'rebroadcast.indeterminate' }).ok).toBe(false);
    }
  });
});

describe('dropped 收敛边（ADR-023）', () => {
  // 为什么必须有这三条边：`dropped` 是**判断**不是事实。误判后若交易实际上链，
  // 缺少收敛边会让记录永久停在 dropped——对已确认的交易报告"已丢弃"。
  it.each([
    ['mempool.entered', 'pending'],
    ['included', 'included'],
    ['replaced', 'replaced'],
  ] as const)('dropped + %s → %s', (event, to) => {
    const result = transition({ from: 'dropped', event });
    expect(ok(result), `dropped + ${event} 应被允许：${JSON.stringify(result)}`).toBe(true);
    if (ok(result)) expect(result.status).toBe(to);
  });

  it('dropped → broadcast 仍必须显式 rebroadcast: true（不得因新增边而放松）', () => {
    const without = transition({ from: 'dropped', event: 'rebroadcast' });
    expect(ok(without)).toBe(false);
    if (!ok(without)) expect(without.reason).toBe('REBROADCAST_FLAG_REQUIRED');

    const withFlag = transition({ from: 'dropped', event: 'rebroadcast', rebroadcast: true });
    expect(ok(withFlag)).toBe(true);
    if (ok(withFlag)) expect(withFlag.status).toBe('broadcast');
  });

  it('dropped 仍不是终态，且不得出现 dropped → signed/failed 之类的新边', () => {
    expect(TERMINAL_STATUSES).not.toContain('dropped');
    expect(ok(transition({ from: 'dropped', event: 'broadcast.accepted' }))).toBe(false);
    expect(ok(transition({ from: 'dropped', event: 'broadcast.rejected' }))).toBe(false);
    expect(ok(transition({ from: 'dropped', event: 'sign' }))).toBe(false);
  });
});
