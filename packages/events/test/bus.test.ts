/**
 * In-process event bus contract test (M2-C01, ADR-006 / ADR-026).
 *
 * Focused on the semantics ADR-006 explicitly promises that are easy for a later author to "helpfully strengthen" into a lie:
 * - cursor **scope** (global vs single-chain) is not interchangeable;
 * - in-process replay is **bounded**, and truncation must be reported explicitly;
 * - at-least-once, not exactly-once (no dedupe promised).
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

  describe('EventBus publish and subscribe (M2-C01)', () => {
    it('publish returns two events, one per global and chain stream, each with cursor starting at 1', () => {
    const b = bus();
    const { global, chain } = b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    expect(global.cursor).toBe('1');
    expect(chain.cursor).toBe('1');
    expect(global.eventId).toBe(chain.eventId);
  });

    it('global stream increments uniformly across chains; single-chain streams increment independently (cursor scopes not interchangeable)', () => {
    const b = bus();
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'block.new' as EventType, chain: B, payload: {} });
    const third = b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });

    // Global stream: 1,2,3
    expect(third.global.cursor).toBe('3');
    // Chain A stream: 1,2 (B's events do not take its numbers)
    expect(third.chain.cursor).toBe('2');

    expect(b.replayWindow().newest).toBe('3');
    expect(b.replayWindow(A).newest).toBe('2');
    expect(b.replayWindow(B).newest).toBe('1');
  });

    it('cross-chain subscriptions receive the global stream; single-chain subscriptions only receive that chain, with in-chain cursors', () => {
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

    it('types filtering only delivers matching types', () => {
    const b = bus();
    const seen: string[] = [];
    b.subscribe({ types: ['tx.finalized'] }, (e) => seen.push(e.type));
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'tx.finalized' as EventType, chain: A, payload: {} });
    expect(seen).toEqual(['tx.finalized']);
  });

    it('addresses only matches contract.event, filtered by payload address', () => {
    const b = bus();
    const seen: string[] = [];
    b.subscribe({ addresses: ['0xaaa'] }, (e) => seen.push(e.type));
    b.publish({ type: 'contract.event' as EventType, chain: A, payload: { address: '0xaaa' } });
    b.publish({ type: 'contract.event' as EventType, chain: A, payload: { address: '0xbbb' } });
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    expect(seen).toEqual(['contract.event']);
  });

    it('close() is idempotent, and no more events arrive afterwards', () => {
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

    it('one subscriber throwing does not affect other subscribers or the publish path (observation failures do not change business outcomes)', () => {
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

  describe('EventBus in-process replay (bounded, ADR-006)', () => {
    it('afterCursor only returns later global events', () => {
    const b = bus();
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'tx.finalized' as EventType, chain: A, payload: {} });
    b.publish({ type: 'block.new' as EventType, chain: B, payload: {} });

    const result = b.replay({ afterCursor: '1' as never });
    expect(result.events.map((e) => e.cursor)).toEqual(['2', '3']);
    expect(result.replayTruncated).toBe(false);
  });

    it('single-chain replay uses that chain\'s cursor space', () => {
    const b = bus();
    b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    b.publish({ type: 'block.new' as EventType, chain: B, payload: {} });
    b.publish({ type: 'tx.finalized' as EventType, chain: A, payload: {} });

    const result = b.replay({ chain: A, afterCursor: '1' as never });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.cursor).toBe('2');
  });

    it('going beyond the buffer window explicitly reports replayTruncated (no silent history loss)', () => {
    const b = bus({ replayCapacity: 2 });
    for (let i = 0; i < 5; i += 1) {
      b.publish({ type: 'tx.included' as EventType, chain: A, payload: { i } });
    }
    const result = b.replay({ afterCursor: '0' as never });
    // Only cursors 4,5 remain in the window.
    expect(result.events.map((e) => e.cursor)).toEqual(['4', '5']);
    expect(result.replayTruncated, 'there is an unreplayable segment in the middle; it must be reported explicitly').toBe(true);
    expect(result.oldestAvailableCursor).toBe('4');
  });

    it('requesting from inside the window reports no truncation', () => {
    const b = bus({ replayCapacity: 3 });
    for (let i = 0; i < 5; i += 1) b.publish({ type: 'tx.included' as EventType, chain: A, payload: {} });
    // Window contains 3,4,5; requesting after 4 -> 5, complete.
    const result = b.replay({ afterCursor: '4' as never });
    expect(result.events.map((e) => e.cursor)).toEqual(['5']);
    expect(result.replayTruncated).toBe(false);
  });

    it('illegal replayCapacity fails fast', () => {
    expect(() => new EventBus({ replayCapacity: 0 })).toThrow(RangeError);
    expect(() => new EventBus({ replayCapacity: 1.5 })).toThrow(RangeError);
  });
});
