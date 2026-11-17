/**
 * SSE 传输（M2-C03，ADR-006 / ADR-025 / ADR-029）。
 *
 * 为什么单独成模块：SSE 是**长连接**，与 Gateway 的"读请求 → 发响应 → 结束"模型不同。
 * 把它塞进 dispatch 会让超时、在途计数、连接清理三处都变得隐晦。
 *
 * 语义（与 ADR-006 一致，不做更强承诺）：
 * - **at-least-once**：事件可能重复，客户端必须按 `eventId` 去重；
 * - **cursor 仅进程内有效**：不跨重启；
 * - 断线即结束本次订阅（不承诺服务端缓冲补偿）；重连由客户端用 `afterCursor` 发起；
 * - 注释帧（`: keep-alive`）用于保持连接并让客户端感知服务端仍在。
 */
import type { ChainEvent, EventFilter } from '@dfr/types';
import type { ServerResponse } from 'node:http';
import type { EventBus, Subscription } from '@dfr/events';

/** 心跳间隔：既保活，也让"服务端还活着"可被观测。 */
export const SSE_KEEPALIVE_MS = 15_000;

/** Bound a single serialized SSE frame and the response's unsent data. */
export const SSE_MAX_FRAME_BYTES = 256 * 1024;
export const SSE_MAX_QUEUED_BYTES = 512 * 1024;
/**
 * 单个 API Key 在一个 Gateway 进程内的并发 SSE 连接上限。
 * 这是防滥用/防耗尽的准入界限，不是计费配额；进程级上限仍由
 * `GatewayOptions.maxSseConnections`（默认 100）单独管理。
 */
export const SSE_MAX_CONNECTIONS_PER_KEY = 8;
export const SSE_MAX_CONNECTIONS_PER_SERVER = 256;

/**
 * Process-local connection admission (not a billing or global quota).
 * Each Gateway server instance owns one registry. A close callback releases
 * a slot once, even if both request-abort and response-close are observed.
 */
export class SseConnectionRegistry {
  private readonly perKey = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly perKeyLimit = SSE_MAX_CONNECTIONS_PER_KEY,
    private readonly totalLimit = SSE_MAX_CONNECTIONS_PER_SERVER,
  ) {
    if (!Number.isSafeInteger(perKeyLimit) || perKeyLimit < 1 ||
        !Number.isSafeInteger(totalLimit) || totalLimit < 1) {
      throw new RangeError('SSE connection limits must be positive integers');
    }
  }

  acquire(key: string): (() => void) | null {
    const active = this.perKey.get(key) ?? 0;
    if (active >= this.perKeyLimit || this.total >= this.totalLimit) return null;
    this.perKey.set(key, active + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const next = (this.perKey.get(key) ?? 1) - 1;
      if (next <= 0) this.perKey.delete(key);
      else this.perKey.set(key, next);
    };
  }

  get activeConnections(): number { return this.total; }
  countFor(key: string): number { return this.perKey.get(key) ?? 0; }
}

export interface SseWriter {
  /** 写入一个事件（`event:`/`data:`/`id:` 三段，符合 SSE 规范）。 */
  write(event: ChainEvent): void;
  /** 写注释帧（心跳）。 */
  keepAlive(): void;
  /** 结束响应。 */
  end(): void;
  readonly closed: boolean;
}

/** 把一个 `ServerResponse` 包装为 SSE 写端。写入失败（对端已断开）不抛错。 */
export function createSseWriter(res: ServerResponse): SseWriter {
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const failClosed = (): void => {
    if (closed) return;
    closed = true;
    // A slow consumer cannot retain unbounded ServerResponse buffers.
    // Destroy rather than end: end() may keep queued data in memory until
    // a permanently stalled peer starts draining again.
    try { res.destroy(); } catch { /* already closed */ }
  };

  const writeRaw = (chunk: string): void => {
    if (closed) return;
    if (Buffer.byteLength(chunk, 'utf8') > SSE_MAX_FRAME_BYTES ||
        res.writableLength >= SSE_MAX_QUEUED_BYTES) {
      failClosed();
      return;
    }
    try {
      // Node returns false as soon as the underlying writable crosses its
      // highWaterMark. SSE replay is best-effort: disconnect and let the
      // client reconnect instead of allocating an unbounded in-memory queue.
      if (!res.write(chunk) || res.writableLength >= SSE_MAX_QUEUED_BYTES) {
        failClosed();
      }
    } catch {
      failClosed();
    }
  };

  return {
    write(event) {
      // `id:` 让浏览器在重连时通过 Last-Event-ID 带回游标；`data:` 是 JSON 单行。
      //
      // JSON 里的换行会被 `data:` 的"每行一个 data"语义破坏，因此这里必须压成单行
      // （JSON.stringify 默认不产生裸换行，字符串里的 \n 会被转义为 \\n）。
      writeRaw(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    keepAlive() {
      writeRaw(': keep-alive\n\n');
    },
    end() {
      if (closed) return;
      closed = true;
      try {
        res.end();
      } catch {
        // 已断开。
      }
    },
    get closed() {
      return closed;
    },
  };
}

export interface SseSessionOptions {
  readonly bus: EventBus;
  readonly filter: EventFilter;
  readonly writer: SseWriter;
  readonly keepAliveMs?: number;
}

/** 一个 SSE 会话：订阅总线 → 写入响应，并在关闭时干净退订。 */
export class SseSession {
  private readonly subscription: Subscription;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(options: SseSessionOptions) {
    const { bus, filter, writer } = options;

    // 顺序很关键。三种写法各有陷阱：
    //   - 先 replay 再 subscribe：两步之间发布的事件会丢；
    //   - 先 subscribe 再 replay：实时事件先写出去，历史事件后写，**顺序颠倒**；
    //   - 正确做法：先 subscribe（此时只**缓冲**不写出），再 replay，最后把缓冲里
    //     "比已重放的最新游标更新"的事件按序写出。
    //
    // 当前 EventBus 的 publish/replay 都是同步的，因此实际上不会真的产生竞态；
    // 但把它写成对异步总线也成立的形式，可以避免将来把总线换成异步实现时静默丢事件。
    const pending: ChainEvent[] = [];
    let buffering = true;
    this.subscription = bus.subscribe(filter, (event: ChainEvent) => {
      if (this.stopped) return;
      if (buffering) {
        pending.push(event);
        return;
      }
      writer.write(event);
    });

    const replayed = bus.replay(filter);
    for (const event of replayed.events) writer.write(event as ChainEvent);
    if (replayed.replayTruncated) {
      // 诚实告知：请求的游标已超出缓冲窗口，无法提供完整历史。
      writer.write({
        eventId: `truncated_${Date.now()}`,
        cursor: (replayed.oldestAvailableCursor ?? '0') as never,
        type: 'chain.reorg',
        chain: (filter.chain ?? 'unknown') as never,
        payload: {
          note: 'replay window truncated; oldest available cursor returned',
          replayTruncated: true,
        },
        schemaVersion: '1',
        occurredAt: new Date().toISOString() as never,
      } as ChainEvent);
    }

    // 冲洗缓冲：只写"比重放的最新游标更靠后"的事件，避免重复。
    const lastReplayed = replayed.events.at(-1)?.cursor;
    for (const event of pending) {
      if (lastReplayed !== undefined && BigInt(event.cursor) <= BigInt(lastReplayed)) continue;
      writer.write(event);
    }
    buffering = false;

    this.timer = setInterval(() => {
      if (this.stopped || writer.closed) {
        this.stop();
        return;
      }
      writer.keepAlive();
    }, options.keepAliveMs ?? SSE_KEEPALIVE_MS);
    // 心跳不应阻止进程退出。
    this.timer.unref?.();
  }

  /** 幂等停止：退订 + 停心跳。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.subscription.close();
  }

  get active(): boolean {
    return !this.stopped;
  }
}

/**
 * SSE 响应头。`X-Accel-Buffering: no` 让 nginx 类反代不缓冲（否则事件会攒着不发，
 * 表现为"订阅成功但收不到事件"）；`Cache-Control: no-cache` 防止中间缓存。
 */
export function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}
