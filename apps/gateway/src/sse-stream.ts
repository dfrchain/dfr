/**
 * SSE transport (M2-C03, ADR-006 / ADR-025 / ADR-029).
 *
 * Why a separate module: SSE is a **long-lived connection**, unlike the Gateway's "read request → send response → end" model.
 * Stuffing it into dispatch would obscure timeouts, in-flight counting, and connection cleanup in three places.
 *
 * Semantics (consistent with ADR-006, no stronger promises):
 * - **at-least-once**: events may repeat; clients must deduplicate by `eventId`;
 * - **cursors are only valid in-process**: they do not survive restarts;
 * - A disconnect ends the subscription (no server-side buffering compensation is promised); the client reconnects with `afterCursor`;
 * - Comment frames (`: keep-alive`) keep the connection alive and let the client know the server is still there.
 */
import type { ChainEvent, EventFilter } from '@dfr/types';
import type { ServerResponse } from 'node:http';
import type { EventBus, Subscription } from '@dfr/events';

/** Heartbeat interval: keeps the connection alive and makes "the server is still alive" observable. */
export const SSE_KEEPALIVE_MS = 15_000;

/** Bound a single serialized SSE frame and the response's unsent data. */
export const SSE_MAX_FRAME_BYTES = 256 * 1024;
export const SSE_MAX_QUEUED_BYTES = 512 * 1024;
/**
 * Maximum concurrent SSE connections for one API Key within a Gateway process.
 * This is an abuse/exhaustion admission bound, not a billing quota; the process-level cap is still managed separately by
 * `GatewayOptions.maxSseConnections` (default 100).
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
  /** Write one event (the `event:`/`data:`/`id:` triple, per the SSE spec). */
  write(event: ChainEvent): void;
  /** Write a comment frame (heartbeat). */
  keepAlive(): void;
  /** End the response. */
  end(): void;
  readonly closed: boolean;
}

/** Wrap a `ServerResponse` as an SSE write end. Write failures (peer disconnected) do not throw. */
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
      // `id:` lets the browser bring the cursor back via Last-Event-ID on reconnect; `data:` is a single JSON line.
      //
      // Newlines inside JSON would break `data:`'s "one data per line" semantics, so it must be compressed to one line here
      // (JSON.stringify never produces raw newlines by default; \n inside strings is escaped to \\n).
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
        // Disconnected.
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

/** One SSE session: subscribe to the bus → write to the response, and unsubscribe cleanly on close. */
export class SseSession {
  private readonly subscription: Subscription;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(options: SseSessionOptions) {
    const { bus, filter, writer } = options;

    // Order matters. Each of the three ways has a trap:
    //   - Replay first, then subscribe: events published between the two steps are lost;
    //   - Subscribe first, then replay: live events are written out before historical ones — **order reversed**;
    //   - Correct approach: subscribe first (only **buffering**, not writing out), then replay, and finally write out the buffered
    //     events "newer than the latest replayed cursor" in order.
    //
    // The current EventBus's publish/replay are both synchronous, so no real race occurs in practice;
    // but writing it in a form that also holds for an async bus avoids silently dropping events if the bus is ever swapped for an async implementation.
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
      // State honestly: the requested cursor is beyond the buffer window, so complete history cannot be provided.
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

    // Flush the buffer: write only events "later than the latest replayed cursor", avoiding duplicates.
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
    // Heartbeats must not prevent process exit.
    this.timer.unref?.();
  }

  /** Idempotent stop: unsubscribe + stop the heartbeat. */
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
 * SSE response headers. `X-Accel-Buffering: no` stops nginx-like reverse proxies from buffering (otherwise events would pile up unsent,
 * looking like "subscribed but no events arrive"); `Cache-Control: no-cache` prevents intermediate caching.
 */
export function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}
