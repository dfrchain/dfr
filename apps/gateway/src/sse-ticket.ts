/**
 * SSE single-use tickets (M2-C02, ADR-029).
 *
 * Why they are needed: the browser's native `EventSource` cannot set custom headers, and putting a long-lived API Key in a
 * query would enter access logs, Referer, and browser history. So short-lived, single-use, bound tickets are issued instead,
 * kept only in memory and reclaimed when the TTL expires.
 *
 * ADR-029's hard constraints (implemented one by one):
 *  1. TTL defaults to 30s, capped at 60s (exceeding it is refused, never silently truncated);
 *  2. Single use (CAS): exactly one winner under concurrency; reuse → `DFR_INVALID_TICKET`;
 *  3. Bound to apiKeyId / filter digest / client IP;
 *  4. IP defaults to the direct peer; `X-Forwarded-For`'s last hop is only used when trusted proxies are configured;
 *  5. Failure semantics are uniformly `DFR_INVALID_TICKET` (expired/used/not-found are not distinguished, to prevent enumeration);
 *  6. Tickets are never persisted, never written to disk, and never logged (including traces/spans and error responses).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { EventFilter, Iso8601 } from '@dfr/types';

/** Default TTL (milliseconds). */
export const SSE_TICKET_DEFAULT_TTL_MS = 30_000;
/** Cap (milliseconds): ADR-029 requires TTL ≤ 60s. */
export const SSE_TICKET_MAX_TTL_MS = 60_000;

export interface IssuedTicket {
  /** Single-use ticket string. **Contains no credentials**, only an opaque random value. */
  readonly ticket: string;
  readonly expiresAt: Iso8601;
}

/** Subscription description returned on successful consumption (the filter must equal the issued filter; it cannot be widened). */
export interface ConsumedTicket {
  readonly apiKeyId: string;
  readonly filter: EventFilter;
}

export type ConsumeTicketResult =
  | { readonly kind: 'ok'; readonly ticket: ConsumedTicket }
  /** Expired / used / not found / binding mismatch — **uniformly** return this value, without distinguishing the reason. */
  | { readonly kind: 'invalid' };

export interface SseTicketStoreOptions {
  /** Injection point (for tests). */
  readonly now?: () => number;
  readonly newTicket?: () => string;
  /** Per-key cap on unconsumed tickets; exceeding it fails issuance (mapped to rate limiting by the caller). */
  readonly maxOutstandingPerKey?: number;
}

interface Entry {
  readonly projectId: string;
  readonly apiKeyId: string;
  readonly ip: string;
  readonly filterDigest: string;
  readonly filter: EventFilter;
  readonly expiresAtMs: number;
}

export class SseTicketStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly newTicket: () => string;
  private readonly maxOutstanding: number;

  constructor(options: SseTicketStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newTicket = options.newTicket ?? (() => randomBytes(32).toString('base64url'));
    this.maxOutstanding = options.maxOutstandingPerKey ?? 32;
  }

  /**
   * Issue. An illegal TTL (a non-positive integer or over the cap) throws RangeError — never silently truncated.
   * When one Key's unconsumed tickets exceed the cap, return `null` (the caller handles it per the existing flow-control semantics).
   */
  issue(input: {
    readonly projectId: string;
    readonly apiKeyId: string;
    readonly ip: string;
    readonly filter: EventFilter;
    readonly ttlMs?: number;
  }): IssuedTicket | null {
    const ttl = input.ttlMs ?? SSE_TICKET_DEFAULT_TTL_MS;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > SSE_TICKET_MAX_TTL_MS) {
      throw new RangeError(`ticket TTL must be 1..${SSE_TICKET_MAX_TTL_MS} ms`);
    }
    this.prune();
    if (this.countFor(input.projectId, input.apiKeyId) >= this.maxOutstanding) return null;

    const ticket = this.newTicket();
    // Never overwrite an outstanding bearer credential: even a generator collision
    // must not change an already issued ticket's identity, IP or filter binding.
    if (this.entries.has(ticket)) return null;
    const expiresAtMs = this.now() + ttl;
    this.entries.set(ticket, {
      projectId: input.projectId,
      apiKeyId: input.apiKeyId,
      ip: input.ip,
      filterDigest: digestFilter(input.filter),
      filter: input.filter,
      expiresAtMs,
    });
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() as Iso8601 };
  }

  /**
   * Single-use consumption. **Atomic**: check-then-delete, so only one of two calls succeeds.
   *
   * Verify the binding dimensions: IP, filter digest, and (**if provided**) apiKeyId.
   *
   * Why apiKeyId is optional: in the browser `EventSource` scenario the caller has only the ticket and no header,
   * so the server cannot know "whose Key the caller is". In that case the ticket **itself is the only credential**,
   * and the "consume with a different Key" attack path does not exist. But if the caller also provides a header,
   * it must match the issuer — otherwise one Key's permissions would consume another Key's ticket.
   * Either way, IP and filter must match (they do not depend on caller identity and are always verifiable).
   */
  consume(input: {
    readonly projectId: string;
    readonly ticket: string;
    readonly apiKeyId?: string;
    readonly ip: string;
    readonly filter: EventFilter;
  }): ConsumeTicketResult {
    this.prune();
    const entry = this.entries.get(input.ticket);
    if (entry === undefined) return { kind: 'invalid' };

    // Delete immediately (single use). Even if later binding checks fail, it is not kept — the ticket has already been exposed.
    this.entries.delete(input.ticket);

    if (entry.projectId !== input.projectId) return { kind: 'invalid' };
    if (input.apiKeyId !== undefined && entry.apiKeyId !== input.apiKeyId) return { kind: 'invalid' };
    if (entry.ip !== input.ip) return { kind: 'invalid' };
    if (entry.filterDigest !== digestFilter(input.filter)) return { kind: 'invalid' };
    return { kind: 'ok', ticket: { apiKeyId: entry.apiKeyId, filter: entry.filter } };
  }

  /** Current count of unconsumed tickets (for diagnostics/tests). */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  private countFor(projectId: string, apiKeyId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.projectId === projectId && entry.apiKeyId === apiKeyId) count += 1;
    }
    return count;
  }

  /** Reclaim expired tickets (deleted when the TTL expires, leaving no trace). */
  private prune(): void {
    const now = this.now();
    for (const [ticket, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(ticket);
    }
  }
}

/**
 * Canonical digest of a filter: only an **exactly identical** filter can consume a ticket (ADR-029 point 6:
 * it may only be narrowed, never widened). Stable serialization (sorted keys, arrays keep order) avoids false inequality from different key orders.
 */
export function digestFilter(filter: EventFilter): string {
  return createHash('sha256').update(canonicalJson(filter)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Get the client IP (ADR-029 point 5).
 *
 * By default take the **direct peer**; only when `trustedProxies` is non-empty and the direct peer is in it,
 * trust `X-Forwarded-For`'s **last hop**. Otherwise the header is not trusted (it can be forged).
 */
export function clientIp(input: {
  readonly remoteAddress: string | undefined;
  readonly forwardedFor: string | undefined;
  readonly trustedProxies: readonly string[];
}): string {
  const direct = input.remoteAddress ?? '';
  if (input.trustedProxies.length === 0) return direct;
  if (!input.trustedProxies.includes(direct)) return direct;
  if (input.forwardedFor === undefined) return direct;
  const hops = input.forwardedFor.split(',').map((part) => part.trim()).filter((part) => part !== '');
  return hops.length > 0 ? hops[hops.length - 1] as string : direct;
}
