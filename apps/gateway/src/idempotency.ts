/**
 * Gateway 幂等协调器（DFR-M1-C04）。
 *
 * Gateway 只负责把 HTTP 请求体变成稳定指纹并建立作用域；并发、租约、接管、
 * replay 与 conflict 的状态判定仍由 Transaction 的 IdempotencyStore 负责。
 * 这里不缓存记录，也不复制 Store 状态机。
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  BeginIdempotencyResult,
  CompleteIdempotencyInput,
  CompleteIdempotencyResult,
  IdempotencyScope,
  IdempotencyStore,
} from '@dfr/transaction';

const DEFAULT_LEASE_TTL_MS = 30_000;

/** Encode directly rather than reconstructing an object: JSON.stringify
 *  reorders integer-like object keys independently of insertion order. */
function canonicalize(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    // Match JSON array semantics: missing/undefined elements encode as null.
    return `[${value.map((entry) => canonicalize(entry) ?? 'null').join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      // RFC 8785: property names sort by UTF-16 code units, never locale.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => {
        const encoded = canonicalize(entry);
        return encoded === undefined ? null : `${JSON.stringify(key)}:${encoded}`;
      })
      .filter((entry): entry is string => entry !== null);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** RFC 8785 风格的 M1 JSON 子集：UTF-16 键排序、undefined 丢弃、数组顺序保留。 */
export function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError('Cannot fingerprint non-JSON input');
  return encoded;
}

/** 请求体 SHA-256 指纹；header、requestId 与 trace 信息不参与。 */
export function fingerprintRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface GatewayIdempotencyCoordinatorOptions {
  readonly leaseTtlMs?: number;
  readonly ownerToken?: () => string;
}

export class GatewayIdempotencyCoordinator {
  private readonly leaseTtlMs: number;
  private readonly ownerToken: () => string;

  constructor(
    private readonly store: IdempotencyStore,
    options: GatewayIdempotencyCoordinatorOptions = {},
  ) {
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.ownerToken = options.ownerToken ?? randomUUID;
  }

  async acquire(scope: IdempotencyScope, body: unknown): Promise<BeginIdempotencyResult> {
    return this.store.begin({
      scope,
      fingerprint: fingerprintRequest(body),
      ownerToken: this.ownerToken(),
      leaseTtlMs: this.leaseTtlMs,
    });
  }

  async complete(input: CompleteIdempotencyInput): Promise<CompleteIdempotencyResult> {
    return this.store.complete(input);
  }
}
