/**
 * M0 single-tenant static API Key authentication (see docs/architecture/auth-tenancy-spec-v0.1.md chapter 3).
 *
 * Form: `dfr_<keyId>_<secret>`
 * Storage: only sha256(secret + pepper) is stored; comparison uses a constant-time algorithm.
 *
 * Security constraints:
 * - "keyId does not exist" and "hash mismatch" must return the same error, to prevent enumeration;
 * - Plaintext keys must never enter logs, metrics, or error details;
 * - current + previous dual-active is supported, so rotation does not interrupt service.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { CapabilityId, ChainId } from '@dfr/types';

const KEY_FORMAT_RE = /^dfr_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{20,64})$/;

export interface ApiKeyScope {
  chains: readonly ChainId[] | '*';
  capabilities: readonly CapabilityId[] | '*';
  allowWrite: boolean;
  ipAllowlist?: readonly string[];
}

export interface StaticApiKeyConfig {
  /**
   * The current Key's keyId (8-char base62).
   *
   * Audit fix A-27: M0 originally stored only the hash, so `dfr_<any keyId>_<correct secret>` could also pass —
   * the spec requires "unknown keyId → 401 DFR_UNAUTHENTICATED", so keyId must be validated bound together with the hash.
   * keyId is not a secret and may appear in audit logs.
   */
  keyId: string;
  /** Hash of the currently active Key (hex, sha256(secret+pepper)). */
  currentHash: string;
  /** Previous keyId during rotation; optional. */
  previousKeyId?: string | undefined;
  /** Previous Key hash during rotation; optional. */
  previousHash?: string | undefined;
  pepper: string;
  scope: ApiKeyScope;
  projectId: string;
}

export interface AuthSuccess {
  ok: true;
  keyId: string;
  projectId: string;
  scope: ApiKeyScope;
}

export interface AuthFailure {
  ok: false;
  /** Unified as DFR_UNAUTHENTICATED, without distinguishing whether the keyId exists. */
  reason: 'missing' | 'malformed' | 'mismatch';
}

export type AuthResult = AuthSuccess | AuthFailure;

export function hashSecret(secret: string, pepper: string): string {
  return createHash('sha256').update(`${secret}${pepper}`).digest('hex');
}

/**
 * Constant-time comparison of two hex hashes.
 *
 * When lengths differ, a comparison is **still** performed once, so response timing cannot distinguish "wrong length" from "wrong value".
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    // Do one harmless comparison with equal-length buffers to keep the timing profile consistent.
    const filler = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, filler);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function verifyApiKey(headerValue: string | undefined, config: StaticApiKeyConfig): AuthResult {
  if (headerValue === undefined || headerValue === '') return { ok: false, reason: 'missing' };
  const match = KEY_FORMAT_RE.exec(headerValue);
  if (match === null) return { ok: false, reason: 'malformed' };

  const keyId = match[1] as string;
  const secret = match[2] as string;

  // keyId must match the current or previous version; a mismatch returns the same failure reason as a hash mismatch, leaking no difference.
  const keyIdKnown = keyId === config.keyId || keyId === config.previousKeyId;
  if (!keyIdKnown) return { ok: false, reason: 'mismatch' };

  const candidate = hashSecret(secret, config.pepper);
  const matchesCurrent = keyId === config.keyId && constantTimeEqualHex(candidate, config.currentHash);
  const matchesPrevious =
    keyId === config.previousKeyId &&
    config.previousHash !== undefined &&
    config.previousHash !== ''
      ? constantTimeEqualHex(candidate, config.previousHash)
      : false;

  if (!matchesCurrent && !matchesPrevious) return { ok: false, reason: 'mismatch' };
  return { ok: true, keyId, projectId: config.projectId, scope: config.scope };
}

/** Scope check: chains and capabilities. */
export function scopeAllows(
  scope: ApiKeyScope,
  args: { chain?: string; capability?: CapabilityId },
): boolean {
  if (args.chain !== undefined && scope.chains !== '*') {
    if (!scope.chains.includes(args.chain as ChainId)) return false;
  }
  if (args.capability !== undefined && scope.capabilities !== '*') {
    if (!scope.capabilities.includes(args.capability)) return false;
  }
  return true;
}
