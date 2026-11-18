/**
 * Gateway idempotency coordinator (DFR-M1-C04).
 *
 * The Gateway only turns the HTTP request body into a stable fingerprint and establishes the scope; concurrency, leases, takeovers,
 * replay, and conflict state decisions remain the Transaction IdempotencyStore's job.
 * No records are cached here, and the Store state machine is not duplicated.
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

/** RFC 8785-style M1 JSON subset: UTF-16 key sorting, undefined dropped, array order preserved. */
export function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError('Cannot fingerprint non-JSON input');
  return encoded;
}

/** SHA-256 fingerprint of the request body; headers, requestId, and trace information do not participate. */
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
