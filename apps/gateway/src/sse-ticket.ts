/**
 * SSE 一次性票据（M2-C02，ADR-029）。
 *
 * 为什么需要：浏览器原生 `EventSource` 无法设置自定义 header，长期 API Key 放进
 * query 会进入访问日志、Referer 与浏览器历史。因此签发**短时、单次、绑定**的票据，
 * 只在内存中保存，TTL 到期即回收。
 *
 * ADR-029 的硬约束（逐条落实）：
 *  1. TTL 默认 30s，上限 60s（超过拒绝，不静默截断）；
 *  2. 单次消费（CAS），并发只有一个赢家；重复使用 → `DFR_INVALID_TICKET`；
 *  3. 绑定 apiKeyId / filter 摘要 / 客户端 IP；
 *  4. IP 默认取直连对端；仅当配置了可信代理时看 `X-Forwarded-For` 最后一跳；
 *  5. 失败语义统一 `DFR_INVALID_TICKET`（不区分过期/已用/未找到，避免枚举）；
 *  6. 票据不落库、不落盘、不进日志（含 trace/span 与错误响应）。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { EventFilter, Iso8601 } from '@dfr/types';

/** 默认 TTL（毫秒）。 */
export const SSE_TICKET_DEFAULT_TTL_MS = 30_000;
/** 上限（毫秒）：ADR-029 规定 TTL ≤ 60s。 */
export const SSE_TICKET_MAX_TTL_MS = 60_000;

export interface IssuedTicket {
  /** 一次性票据串。**不包含任何凭证**，仅是不透明随机值。 */
  readonly ticket: string;
  readonly expiresAt: Iso8601;
}

/** 消费成功时返回的订阅描述（filter 只能等于签发时的 filter，不能扩大）。 */
export interface ConsumedTicket {
  readonly apiKeyId: string;
  readonly filter: EventFilter;
}

export type ConsumeTicketResult =
  | { readonly kind: 'ok'; readonly ticket: ConsumedTicket }
  /** 过期 / 已用 / 未找到 / 绑定不匹配——**统一**返回此值，不区分原因。 */
  | { readonly kind: 'invalid' };

export interface SseTicketStoreOptions {
  /** 注入点（测试用）。 */
  readonly now?: () => number;
  readonly newTicket?: () => string;
  /** 单 Key 未消费票据上限；超出时签发失败（由调用方映射为限流）。 */
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
   * 签发。TTL 非法（非正整数或超过上限）时抛 RangeError —— 不静默截断。
   * 同一 Key 未消费票据超限时返回 `null`（调用方按既有流控语义处理）。
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
      throw new RangeError(`ticket TTL 必须是 1..${SSE_TICKET_MAX_TTL_MS} 毫秒`);
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
   * 一次性消费。**原子**：先检查再删除，两次调用只有一个成功。
   *
   * 校验绑定维度：IP、filter 摘要，以及（**若提供**）apiKeyId。
   *
   * 为什么 apiKeyId 可选：浏览器 `EventSource` 场景下调用方只有票据、没有 header，
   * 服务端无法得知"调用者的 Key 是谁"。此时票据**本身就是唯一凭证**，
   * "换 Key 消费"这条攻击路径不存在。但若调用方同时提供了 header，
   * 就必须与签发者一致——否则等于用一个 Key 的权限消费了另一个 Key 的票据。
   * 无论哪种情况，IP 与 filter 都必须匹配（它们与调用方身份无关，恒可校验）。
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

    // 立即删除（单次消费）。即使后续绑定校验失败也不保留——票据已暴露过。
    this.entries.delete(input.ticket);

    if (entry.projectId !== input.projectId) return { kind: 'invalid' };
    if (input.apiKeyId !== undefined && entry.apiKeyId !== input.apiKeyId) return { kind: 'invalid' };
    if (entry.ip !== input.ip) return { kind: 'invalid' };
    if (entry.filterDigest !== digestFilter(input.filter)) return { kind: 'invalid' };
    return { kind: 'ok', ticket: { apiKeyId: entry.apiKeyId, filter: entry.filter } };
  }

  /** 当前未消费票据数（诊断/测试用）。 */
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

  /** 回收过期票据（TTL 到期即删，不留痕迹）。 */
  private prune(): void {
    const now = this.now();
    for (const [ticket, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(ticket);
    }
  }
}

/**
 * filter 的规范化摘要：只有**完全一致**的 filter 才能消费票据（ADR-029 第 6 点：
 * 只能收窄不能扩大）。用稳定序列化（键排序、数组保留顺序）避免键序不同导致的假不等。
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
 * 取客户端 IP（ADR-029 第 5 点）。
 *
 * 默认取**直连对端**；仅当 `trustedProxies` 非空且直连对端在其中时，
 * 才采信 `X-Forwarded-For` 的**最后一跳**。否则不信任该头（可伪造）。
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
