/**
 * 进程内事件总线（M2-C01，ADR-006 / ADR-026）。
 *
 * 语义（与 ADR-006 一致，不含任何更强承诺）：
 * - **at-least-once**：订阅者可能收到重复，必须按 `eventId` 去重；
 * - **cursor 仅在进程生命周期内有效**：不跨重启，不跨进程；
 * - **订阅作用域内单调**：`filter.chain` 省略时在跨链合并流上统一分配，
 *   指定时按该链各自分配；两种作用域的 cursor **不可互换**；
 * - **有界重放**：`afterCursor` 只能重放仍在环形缓冲区中的事件；超出即明确告知
 *   （`replayTruncated`），而不是静默丢掉一段历史。
 *
 * 本模块不 import Core / Adapter / Transaction / Storage，也不做持久化。
 */

import { randomUUID } from 'node:crypto';
import type { ChainEvent, ChainId, Cursor, EventFilter, Iso8601 } from '@dfr/types';

/** 默认环形缓冲容量：进程内重放窗口。可按部署调整。 */
export const DEFAULT_REPLAY_CAPACITY = 1_000;

export interface EventBusOptions {
  /** 保留最近多少个事件用于进程内重放。 */
  readonly replayCapacity?: number;
  /** 注入点（测试用）：事件 ID 与时间。 */
  readonly newEventId?: () => string;
  readonly now?: () => string;
  /** 注入点（测试用）：cursor 起始值。 */
  readonly initialCursor?: bigint;
}

export interface PublishInput<T> {
  readonly type: ChainEvent<T>['type'];
  readonly chain: ChainId;
  readonly payload: T;
  readonly blockRef?: ChainEvent<T>['blockRef'];
  readonly txRef?: ChainEvent<T>['txRef'];
}

/** 订阅句柄：`close()` 幂等，之后不再收到任何事件。 */
export interface Subscription {
  readonly id: string;
  readonly filter: EventFilter;
  close(): void;
  /** 供测试与运维观察：已投递事件数。 */
  readonly delivered: number;
}

export interface ReplayResult<T = unknown> {
  readonly events: readonly ChainEvent<T>[];
  /**
   * 请求的 `afterCursor` 早于缓冲区最早事件 → 中间有一段已无法重放。
   * 调用方**必须**据此判断是否接受"不完整重放"，不得当作完整历史。
   */
  readonly replayTruncated: boolean;
  readonly oldestAvailableCursor?: Cursor;
}

/**
 * 事件总线。
 *
 * cursor 分配按**订阅作用域**隔离：全局流一个计数器，每条链一个计数器。
 * 这样"跨链订阅"与"单链订阅"各自的 cursor 单调，且互不干扰。
 */
export class EventBus {
  private readonly capacity: number;
  private readonly newEventId: () => string;
  private readonly now: () => string;

  /** 全局流（filter.chain 省略时使用）的 cursor 与缓冲区。 */
  private globalCursor: bigint;
  private readonly globalBuffer: ChainEvent[] = [];

  /** 每链流（filter.chain 指定时使用）。 */
  private readonly chainCursors = new Map<string, bigint>();
  private readonly chainBuffers = new Map<string, ChainEvent[]>();

  private readonly subscriptions = new Map<string, { filter: EventFilter; listener: (e: ChainEvent) => void; delivered: number; closed: boolean }>();

  constructor(options: EventBusOptions = {}) {
    this.capacity = options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new RangeError('replayCapacity 必须是正整数');
    }
    this.newEventId = options.newEventId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.globalCursor = options.initialCursor ?? 0n;
  }

  /**
   * 发布一个事件。**同时**进入全局流与对应链流，各自分配独立 cursor。
   *
   * 为什么要两份：ADR-006 的 A-24 修正规定 cursor 的作用域由订阅时的 filter 决定。
   * 若只分配一个 cursor，跨链订阅与单链订阅就会互相"跳号"，消费者无法按自己的
   * 作用域重放。
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

    // 投递给匹配的活跃订阅者（at-least-once：不做去重，由消费端负责）。
    for (const entry of this.subscriptions.values()) {
      if (entry.closed) continue;
      if (!matches(entry.filter, globalEvent, chainEvent)) continue;
      const delivered = scopeOf(entry.filter) === 'global' ? globalEvent : chainEvent;
      entry.delivered += 1;
      try {
        entry.listener(delivered);
      } catch {
        // 单个订阅者的异常不得影响其他订阅者或发布路径（与"观测失败不影响业务"同约定）。
      }
    }

    return { global: globalEvent, chain: chainEvent };
  }

  /** 订阅。返回句柄；`close()` 幂等。 */
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
   * 按 filter 在对应作用域内重放。**仅进程内**：只覆盖仍在缓冲区中的事件。
   *
   * 不传 `afterCursor` 时从缓冲区最早处开始（即"尽可能完整地重放"）。
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
      // 缓冲区最早事件的 cursor 已经大于 afterCursor → 中间有空档。
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

  /** 当前活跃订阅数（运维/测试观察用）。 */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** 缓冲区中可用于重放的最早/最新 cursor（诊断用）。 */
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
    // 环形缓冲：超出容量即丢弃最旧的（因此重放窗口有界，见 replayTruncated）。
    if (buffer.length > this.capacity) buffer.splice(0, buffer.length - this.capacity);
  }
}

function scopeOf(filter: EventFilter): 'global' | 'chain' {
  return filter.chain === undefined ? 'global' : 'chain';
}

function matches(filter: EventFilter, globalEvent: ChainEvent, chainEvent: ChainEvent): boolean {
  // 作用域决定投递哪一个：跨链订阅收全局流，单链订阅收链流。
  if (scopeOf(filter) === 'chain' && globalEvent.chain !== filter.chain) {
    // 单链订阅只应收到该链的事件。缺了这条判断，链 B 的事件也会投给链 A 的订阅者
    // （cursor 作用域因此失去意义）。
    return false;
  }
  const event = scopeOf(filter) === 'global' ? globalEvent : chainEvent;
  return matchesTypesAndAddresses(filter, event);
}

function matchesTypesAndAddresses(filter: EventFilter, event: ChainEvent): boolean {
  if (filter.types !== undefined && !filter.types.includes(event.type)) return false;
  if (filter.addresses !== undefined) {
    // `addresses` 过滤的是"合约/程序事件"；非 contract.event 一律不匹配。
    if (event.type !== 'contract.event') return false;
    const payload = event.payload as { address?: unknown } | null;
    const address = typeof payload === 'object' && payload !== null ? payload.address : undefined;
    if (typeof address !== 'string' || !filter.addresses.includes(address)) return false;
  }
  return true;
}
