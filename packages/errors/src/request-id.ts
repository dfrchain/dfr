/**
 * Correlation identifiers (requestId / traceId).
 *
 * Why it lives in the errors package: `request_id` is a required field of the error envelope (error-spec chapter 2),
 * and every layer (Gateway / Core / Adapter / Provider) must be able to construct or pass it through,
 * while all of those layers already depend on the errors package, so no separate ID-only package is needed.
 */
import { randomBytes } from 'node:crypto';
import type { RequestId } from '@dfr/types';

/** Crockford base32, the ULID character set (I / L / O / U removed). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const REQUEST_ID_RE = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Generate `req_<ULID>` (48-bit time + 80-bit randomness). */
export function newRequestId(now: number = Date.now()): RequestId {
  const timeChars: string[] = new Array<string>(10);
  let remaining = now;
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = ENCODING[remaining % 32] as string;
    remaining = Math.floor(remaining / 32);
  }

  // 10 bytes = 80 bits -> 16 base32 characters.
  const bytes = randomBytes(10);
  let random = 0n;
  for (const byte of bytes) random = (random << 8n) | BigInt(byte);
  const randomChars: string[] = new Array<string>(16);
  for (let i = 15; i >= 0; i -= 1) {
    randomChars[i] = ENCODING[Number(random & 31n)] as string;
    random >>= 5n;
  }

  return `req_${timeChars.join('')}${randomChars.join('')}` as RequestId;
}

/** Validate whether an externally supplied X-Request-Id matches the `req_<ULID>` format. */
export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value);
}

/**
 * Take the external requestId, otherwise generate a new one.
 *
 * Spec (gateway-spec chapter 4): an illegally formatted value is not an error; it is replaced directly with a server-generated value.
 */
export function resolveRequestId(candidate?: string | undefined): RequestId {
  if (candidate !== undefined && isValidRequestId(candidate)) return candidate as RequestId;
  return newRequestId();
}
