/**
 * 关联标识（requestId / traceId）。
 *
 * 放在 errors 包的原因：`request_id` 是错误封套的必填字段（error-spec 第 2 章），
 * 每一层（Gateway / Core / Adapter / Provider）都要能构造或透传它，
 * 而这些层都依赖 errors 包，不需要再引入一个只做 ID 的独立包。
 */
import { randomBytes } from 'node:crypto';
import type { RequestId } from '@dfr/types';

/** Crockford base32，ULID 规定字符集（去掉 I / L / O / U）。 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const REQUEST_ID_RE = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

/** 生成 `req_<ULID>`（48 bit 时间 + 80 bit 随机）。 */
export function newRequestId(now: number = Date.now()): RequestId {
  const timeChars: string[] = new Array<string>(10);
  let remaining = now;
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = ENCODING[remaining % 32] as string;
    remaining = Math.floor(remaining / 32);
  }

  // 10 字节 = 80 bit → 16 个 base32 字符。
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

/** 校验外部传入的 X-Request-Id 是否符合 `req_<ULID>` 格式。 */
export function isValidRequestId(value: string): boolean {
  return REQUEST_ID_RE.test(value);
}

/**
 * 采用外部 requestId，否则生成新的。
 *
 * 规范（gateway-spec 第 4 章）：格式非法不报错，直接替换为服务端生成的新值。
 */
export function resolveRequestId(candidate?: string | undefined): RequestId {
  if (candidate !== undefined && isValidRequestId(candidate)) return candidate as RequestId;
  return newRequestId();
}
