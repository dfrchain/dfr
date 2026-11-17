/**
 * M0 单租户静态 API Key 鉴权（见 docs/architecture/auth-tenancy-spec-v0.1.md 第 3 章）。
 *
 * 形式：`dfr_<keyId>_<secret>`
 * 存储：只存 sha256(secret + pepper)，比较使用恒定时间算法。
 *
 * 安全约束：
 * - "keyId 不存在"与"哈希不匹配"必须返回同一个错误，避免枚举；
 * - 明文 Key 不得进入日志、指标、错误详情；
 * - 支持 current + previous 双活，使轮换不中断服务。
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
   * 当前 Key 的 keyId（8 位 base62）。
   *
   * 审计修正 A-27：M0 最初只存哈希，导致 `dfr_<任意 keyId>_<正确 secret>` 也能通过 ——
   * 规范要求"keyId 不存在 → 401 DFR_UNAUTHENTICATED"，因此 keyId 必须与哈希一起绑定校验。
   * keyId 不是秘密，可以出现在审计日志中。
   */
  keyId: string;
  /** 当前生效的 Key 哈希（hex，sha256(secret+pepper)）。 */
  currentHash: string;
  /** 轮换期间的旧 keyId；可选。 */
  previousKeyId?: string | undefined;
  /** 轮换期间的旧 Key 哈希；可选。 */
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
  /** 统一为 DFR_UNAUTHENTICATED，不区分 keyId 是否存在。 */
  reason: 'missing' | 'malformed' | 'mismatch';
}

export type AuthResult = AuthSuccess | AuthFailure;

export function hashSecret(secret: string, pepper: string): string {
  return createHash('sha256').update(`${secret}${pepper}`).digest('hex');
}

/**
 * 恒定时间比较两个 hex 哈希。
 *
 * 长度不同时**仍然**执行一次比较，避免通过响应时间区分"长度不对"与"值不对"。
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    // 用等长缓冲做一次无害比较，保持时间特征一致。
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

  // keyId 必须匹配当前或上一版；不匹配与哈希不匹配返回同一失败原因，不泄漏差异。
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

/** 作用域检查：链与能力。 */
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
