/**
 * 进程内事件总线契约测试（M2-C01，ADR-006 / ADR-026）。
 *
 * 重点锁定 ADR-006 明确承诺、且容易被后人"顺手加强"而说谎的语义：
 * - cursor 的**作用域**（全局 vs 单链）不可互换；
 * - 进程内重放**有界**，截断必须显式告知；
 * - at-least-once 而不是 exactly-once（不承诺去重）。
 */
import { describe, expect, it } from 'vitest';
import type { ChainId, EventType } from '@dfr/types';
import { EventBus, type EventBusOptions } from '../src/index.js';

const A = 'ethereum-sepolia' as ChainId;
const B = 'solana-devnet' as ChainId;

let seq = 0;
function bus(options: Partial<EventBusOptions> = {}): EventBus {
  seq = 0;
  return new EventBus({ newEventId: () => `evt_${++seq}`, now: () => '2026-10-06T00:00:00.000Z', ...options });
}

describe('EventBus 发布与订阅（M2-C01）', () => {
  it('发布返回全局流与链流两份事件，各自 cursor 从 1 开始', () => {
    const b = bus();
    const { global, chain } = b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    expect(global.cursor).toBe('1');
    expect(chain.cursor).toBe('1');
    expect(global.eventId).toBe(chain.eventId);
  });

  it('全局流跨链统一递增；单链流各自独立递增（cursor 作用域不可互换）', () => {
    const b = bus();
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'block.new' as EventType, chain: B, payload: {} });
    const third = b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });

    // 全局流：1,2,3
    expect(third.global.cursor).toBe('3');
    // 链 A 流：1,2（B 的事件不占它的号）
    expect(third.chain.cursor).toBe('2');

    expect(b.replayWindow().newest).toBe('3');
    expect(b.replayWindow(A).newest).toBe('2');
    expect(b.replayWindow(B).newest).toBe('1');
  });

  it('跨链订阅收到全局流；单链订阅只收到该链且用链内 cursor', () => {
    const b = bus();
    const globalSeen: string[] = [];
    const chainSeen: string[] = [];
    b.subscribe({}, (e) => globalSeen.push(`${e.chain}:${e.cursor}`));
    b.subscribe({ chain: A }, (e) => chainSeen.push(`${e.chain}:${e.cursor}`));

    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'block.new' as EventType, chain: B, payload: {} });

    expect(globalSeen).toEqual([`${A}:1`, `${B}:2`]);
    expect(chainSeen).toEqual([`${A}:1`]);
  });

  it('types 过滤只投递匹配类型', () => {
    const b = bus();
    const seen: string[] = [];
    b.subscribe({ types: ['tx.finalized'] }, (e) => seen.push(e.type));
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'tx.finalized' as EventType, chain: A, payload: {} });
    expect(seen).toEqual(['tx.finalized']);
  });

  it('addresses 只匹配 contract.event，且按载荷地址过滤', () => {
    const b = bus();
    const seen: string[] = [];
    b.subscribe({ addresses: ['0xaaa'] }, (e) => seen.push(e.type));
    b.publish({ type: 'contract.event' as EventType, chain: A, payload: { address: '0xaaa' } });
    b.publish({ type: 'contract.event' as EventType, chain: A, payload: { address: '0xbbb' } });
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    expect(seen).toEqual(['contract.event']);
  });

  it('close() 幂等，且之后不再收到事件', () => {
    const b = bus();
    const seen: string[] = [];
    const sub = b.subscribe({}, (e) => seen.push(e.type));
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    sub.close();
    sub.close();
    b.publish({ type: 'tx.finalized' as EventType, chain: A, payload: {} });
    expect(seen).toEqual(['tx.included']);
    expect(b.subscriptionCount).toBe(0);
  });

  it('单个订阅者抛错不影响其他订阅者与发布路径（观测失败不改变业务结果）', () => {
    const b = bus();
    const seen: string[] = [];
    b.subscribe({}, () => {
      throw new Error('boom');
    });
    b.subscribe({}, (e) => seen.push(e.type));
    expect(() => b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} })).not.toThrow();
    expect(seen).toEqual(['tx.included']);
  });
});

describe('EventBus 进程内重放（有界，ADR-006）', () => {
  it('afterCursor 只返回其后的全局事件', () => {
    const b = bus();
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'tx.finalized' as EventType, chain: A, payload: {} });
    b.publish({ type: 'block.new' as EventType, chain: B, payload: {} });

    const result = b.replay({ afterCursor: '1' as never });
    expect(result.events.map((e) => e.cursor)).toEqual(['2', '3']);
    expect(result.replayTruncated).toBe(false);
  });

  it('单链重放使用该链的 cursor 空间', () => {
    const b = bus();
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'block.new' as EventType, chain: B, payload: {} });
    b.publish({ type: 'tx.finalized' as EventType, chain: A, payload: {} });

    const result = b.replay({ chain: A, afterCursor: '1' as never });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.cursor).toBe('2');
  });

  it('超出缓冲区窗口时显式报告 replayTruncated（不静默丢历史）', () => {
    const b = bus({ replayCapacity: 2 });
    for (let i = 0; i < 5; i += 1) {
      b.publish({ type: 'tx.included' as EventType, chain: A, payload: { i } });
    }
    const result = b.replay({ afterCursor: '0' as never });
    // 窗口只剩 cursor 4,5。
    expect(result.events.map((e) => e.cursor)).toEqual(['4', '5']);
    expect(result.replayTruncated, '中间有不可重放的段，必须显式告知').toBe(true);
    expect(result.oldestAvailableCursor).toBe('4');
  });

  it('从窗口内请求不报截断', () => {
    const b = bus({ replayCapacity: 3 });
    for (let i = 0; i < 5; i += 1) b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    // 窗口含 3,4,5；从 4 之后请求 → 5，完整。
    const result = b.replay({ afterCursor: '4' as never });
    expect(result.events.map((e) => e.cursor)).toEqual(['5']);
    expect(result.replayTruncated).toBe(false);
  });

  it('replayCapacity 非法时 fail-fast', () => {
    expect(() => new EventBus({ replayCapacity: 0 })).toThrow(RangeError);
    expect(() => new EventBus({ replayCapacity: 1.5 })).toThrow(RangeError);
  });
});
