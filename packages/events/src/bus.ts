/**
 * In-process event bus (M2-C01, ADR-006 / ADR-026).
 *
 * Semantics (matching ADR-006, with no stronger promises):
 * - **at-least-once**: subscribers may receive duplicates and must dedupe by `eventId`;
 * - **cursor valid only within the process lifetime**: not across restarts, not across processes;
 * - **monotonic within the subscription scope**: when `filter.chain` is omitted, cursors are allocated uniformly on the merged cross-chain stream;
 *   when specified, each chain allocates its own; cursors from the two scopes are **not interchangeable**;
 * - **bounded replay**: `afterCursor` can only replay events still in the ring buffer; going beyond is reported explicitly
 *   (`replayTruncated`) instead of silently dropping a slice of history.
 *
 * This module does not import Core / Adapter / Transaction / Storage, and does no persistence.
 */

import { randomUUID } from 'node:crypto';
import type { ChainEvent, ChainId, Cursor, EventFilter, Iso8601 } from '@dfr/types';

/** Default ring-buffer capacity: the in-process replay window. Adjustable per deployment. */
export const DEFAULT_REPLAY_CAPACITY = 1_000;

export interface EventBusOptions {
  /** How many recent events to retain for in-process replay. */
  readonly replayCapacity?: number;
  /** Injection point (for tests): event ID and time. */
  readonly newEventId?: () => string;
  readonly now?: () => string;
  /** Injection point (for tests): cursor start value. */
  readonly initialCursor?: bigint;
}

export interface PublishInput<T> {
  readonly type: ChainEvent<T>['type'];
  readonly chain: ChainId;
  readonly payload: T;
  readonly blockRef?: ChainEvent<T>['blockRef'];
  readonly txRef?: ChainEvent<T>['txRef'];
}

/** Subscription handle: `close()` is idempotent; no more events arrive afterwards. */
export interface Subscription {
  readonly id: string;
  readonly filter: EventFilter;
  close(): void;
  /** For test and ops observation: number of events delivered. */
  readonly delivered: number;
}

export interface ReplayResult<T = unknown> {
  readonly events: readonly ChainEvent<T>[];
  /**
   * The requested `afterCursor` predates the earliest event in the buffer -> a middle slice can no longer be replayed.
   * The caller **must** use this to decide whether to accept an "incomplete replay"; it must not be treated as complete history.
   */
  readonly replayTruncated: boolean;
  readonly oldestAvailableCursor?: Cursor;
}

/**
 * Event bus.
 *
 * Cursor allocation is isolated by **subscription scope**: one counter for the global stream, one per chain.
 * That way "cross-chain subscriptions" and "single-chain subscriptions" each have monotonic cursors, without interfering with each other.
 */
export class EventBus {
  private readonly capacity: number;
  private readonly newEventId: () => string;
  private readonly now: () => string;

  /** Cursor and buffer of the global stream (used when filter.chain is omitted). */
  private globalCursor: bigint;
  private readonly globalBuffer: ChainEvent[] = [];

  /** Per-chain streams (used when filter.chain is specified). */
  private readonly chainCursors = new Map<string, bigint>();
  private readonly chainBuffers = new Map<string, ChainEvent[]>();

  private readonly subscriptions = new Map<string, { filter: EventFilter; listener: (e: ChainEvent) => void; delivered: number; closed: boolean }>();

  constructor(options: EventBusOptions = {}) {
    this.capacity = options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new RangeError('replayCapacity must be a positive integer');
    }
    this.newEventId = options.newEventId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.globalCursor = options.initialCursor ?? 0n;
  }

  /**
   * Publish an event. It enters **both** the global stream and the matching chain stream, each with its own cursor.
   *
   * Why two copies: ADR-006 fix A-24 states that cursor scope is decided by the filter at subscribe time.
   * With a single cursor, cross-chain and single-chain subscriptions would "skip numbers" on each other, and consumers could not
   * replay within their own scope.
   */
  publish<T>(input: PublishInput<T>): { global: ChainEvent<T>; chain: ChainEvent<T> } {
    const eventId = this.newEventId();
    const occurredAt = this.now() as Iso8601;
    const base = {
      eventId,
      type: input.type,
      chain: input.chain,
      payload: input.payload,
      schemaVersion: '1' as const,
      occurredAt,
      ...(input.blockRef !== undefined ? { blockRef: input.blockRef } : {}),
      ...(input.txRef !== undefined ? { txRef: input.txRef } : {}),
    };

    this.globalCursor += 1n;
    const globalEvent = { ...base, cursor: this.globalCursor.toString(10) as Cursor } as ChainEvent<T>;
    this.push(this.globalBuffer, globalEvent);

    const chainKey = input.chain as string;
    const chainCursor = (this.chainCursors.get(chainKey) ?? 0n) + 1n;
    this.chainCursors.set(chainKey, chainCursor);
    const chainEvent = { ...base, cursor: chainCursor.toString(10) as Cursor } as ChainEvent<T>;
    let buffer = this.chainBuffers.get(chainKey);
    if (buffer === undefined) {
      buffer = [];
      this.chainBuffers.set(chainKey, buffer);
    }
    this.push(buffer, chainEvent);

    // Deliver to matching active subscribers (at-least-once: no dedupe; the consumer is responsible).
    for (const entry of this.subscriptions.values()) {
      if (entry.closed) continue;
      if (!matches(entry.filter, globalEvent, chainEvent)) continue;
      const delivered = scopeOf(entry.filter) === 'global' ? globalEvent : chainEvent;
      entry.delivered += 1;
      try {
        entry.listener(delivered);
      } catch {
        // One subscriber's exception must not affect other subscribers or the publish path (same convention as "observation failures do not affect business").
      }
    }

    return { global: globalEvent, chain: chainEvent };
  }

  /** Subscribe. Returns a handle; `close()` is idempotent. */
  subscribe(filter: EventFilter, listener: (event: ChainEvent) => void): Subscription {
    const id = this.newEventId();
    const entry = { filter, listener, delivered: 0, closed: false };
    this.subscriptions.set(id, entry);
    return {
      id,
      filter,
      close: () => {
        entry.closed = true;
        this.subscriptions.delete(id);
      },
      get delivered() {
        return entry.delivered;
      },
    };
  }

  /**
   * Replay within the filter's scope. **In-process only**: covers only events still in the buffer.
   *
   * Without `afterCursor`, start from the earliest point in the buffer (i.e. "replay as completely as possible").
   */
  replay<T = unknown>(filter: EventFilter): ReplayResult<T> {
    const scope = scopeOf(filter);
    const buffer = (scope === 'global'
      ? this.globalBuffer
      : this.chainBuffers.get(filter.chain as string) ?? []) as ChainEvent<T>[];

    const oldest = buffer[0]?.cursor;
    let truncated = false;
    let start = 0;
    if (filter.afterCursor !== undefined) {
      const after = BigInt(filter.afterCursor);
      // The earliest event's cursor in the buffer already exceeds afterCursor -> there is a gap in the middle.
      if (oldest !== undefined && BigInt(oldest) > after + 1n) truncated = true;
      start = buffer.findIndex((e) => BigInt(e.cursor) > after);
      if (start === -1) start = buffer.length;
    }

    const events = buffer.slice(start).filter((e) => matchesTypesAndAddresses(filter, e));
    return {
      events,
      replayTruncated: truncated,
      ...(oldest !== undefined ? { oldestAvailableCursor: oldest } : {}),
    };
  }

  /** Current active subscription count (for ops/test observation). */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** Earliest/latest replayable cursor in the buffer (for diagnostics). */
  replayWindow(chain?: ChainId): { oldest?: Cursor; newest?: Cursor; size: number } {
    const buffer = chain === undefined
      ? this.globalBuffer
      : this.chainBuffers.get(chain as string) ?? [];
    return {
      ...(buffer[0] !== undefined ? { oldest: buffer[0].cursor } : {}),
      ...(buffer[buffer.length - 1] !== undefined ? { newest: buffer[buffer.length - 1]!.cursor } : {}),
      size: buffer.length,
    };
  }

  private push(buffer: ChainEvent[], event: ChainEvent): void {
    buffer.push(event);
    // Ring buffer: exceeding capacity drops the oldest (so the replay window is bounded, see replayTruncated).
    if (buffer.length > this.capacity) buffer.splice(0, buffer.length - this.capacity);
  }
}

function scopeOf(filter: EventFilter): 'global' | 'chain' {
  return filter.chain === undefined ? 'global' : 'chain';
}

function matches(filter: EventFilter, globalEvent: ChainEvent, chainEvent: ChainEvent): boolean {
  // Scope decides which one to deliver: cross-chain subscriptions get the global stream, single-chain subscriptions get the chain stream.
  if (scopeOf(filter) === 'chain' && globalEvent.chain !== filter.chain) {
    // A single-chain subscription should only receive events from that chain. Without this check, chain B's events would also go to chain A's subscribers
    // (and cursor scope would lose its meaning).
    return false;
  }
  const event = scopeOf(filter) === 'global' ? globalEvent : chainEvent;
  return matchesTypesAndAddresses(filter, event);
}

function matchesTypesAndAddresses(filter: EventFilter, event: ChainEvent): boolean {
  if (filter.types !== undefined && !filter.types.includes(event.type)) return false;
  if (filter.addresses !== undefined) {
    // `addresses` filters "contract/program events"; anything that is not a contract.event never matches.
    if (event.type !== 'contract.event') return false;
    const payload = event.payload as { address?: unknown } | null;
    const address = typeof payload === 'object' && payload !== null ? payload.address : undefined;
    if (typeof address !== 'string' || !filter.addresses.includes(address)) return false;
  }
  return true;
}
