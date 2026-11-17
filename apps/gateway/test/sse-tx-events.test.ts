/**
 * `tx.*` 事件端到端接线（M2 余项）。
 *
 * 分两层验证：
 *  - 映射本身（本文件）：状态 → `tx.*` 事件类型的覆盖；
 *  - 引擎发出事件（`packages/transaction/test/transition-events.test.ts`）：
 *    每次成功迁移都发、汇点抛错不影响业务、未注入时不报错。
 *
 * 为什么不做"build → SSE"的端到端：它需要一套完整的链 stub 才能让 build 成功，
 * 而在本仓库里那样做的价值与稳定性都不如上面两层（真实链路径已由
 * `m1-write.e2e.test.ts` 与 `m1-broadcast.e2e.test.ts` 覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { statusToEventType } from '../src/main.js';


describe('statusToEventType 映射', () => {
  it('覆盖规范事件表的全部 12 个 tx.* 状态', () => {
    const mapping = {
      built: 'tx.built', simulated: 'tx.simulated', signed: 'tx.signed', broadcast: 'tx.broadcast',
      pending: 'tx.pending', included: 'tx.included', confirmed: 'tx.confirmed', finalized: 'tx.finalized',
      failed: 'tx.failed', reverted: 'tx.reverted', dropped: 'tx.dropped', replaced: 'tx.replaced',
    } as const;
    for (const [status, type] of Object.entries(mapping)) {
      expect(statusToEventType(status), status).toBe(type);
    }
    // `unknown` 没有对应事件（规范事件表里没有 tx.unknown）。
    expect(statusToEventType('unknown')).toBeUndefined();
  });
});
