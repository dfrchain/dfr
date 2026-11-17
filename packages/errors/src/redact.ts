/**
 * 错误与日志脱敏（见 docs/architecture/error-spec-v0.1.md 第 6 章）。
 *
 * 强制约束：错误字段中不得出现私钥、助记词、API Key、Token、JWT、Cookie、
 * RPC endpoint 的 query string、Authorization header、签名原文。
 *
 * 本模块是"最后一道闸门"：即使上游 Provider 或 Adapter 把原始报文带进错误，
 * 出口也会被这里清洗一遍。清洗规则是**确定性**的，便于单元测试回归。
 */

/** 单个 message 的最大长度，避免上游把整份 JSON 塞进 detail。 */
const MAX_MESSAGE_LENGTH = 300;

/**
 * 凭证类参数 / 赋值。
 *
 * 前导边界字符不能是 `_`，否则 `private_key=` 里的 `key=` 会被误当成参数名。
 */
const CREDENTIAL_PARAM_RE =
  /((?:^|[\s?&,;])(?:api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|signature|sig)=)[^&\s#]*/gi;

/** HTTP Authorization / Bearer / Basic。 */
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const BASIC_AUTH_RE = /(Basic\s+)[A-Za-z0-9+/=]{8,}/gi;

/** 常见厂商 Key 前缀。 */
const VENDOR_KEY_RE =
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|xox[abprs])-[A-Za-z0-9_-]{12,}/g;

/** JWT（三段 base64url）。 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** 私钥 / 助记词 / secret 的赋值形式（可选引号包裹）。 */
const SECRET_ASSIGN_RE =
  /(private[_-]?key|mnemonic|seed[_-]?phrase|secret[_-]?key|secret)(["'\s:=]{1,4})(["']?)(?!\[redacted)[^\s"',;]{6,}/gi;

/** `0x` + 64 hex 且被标注为 key：只在这一明确上下文里替换。 */
const LABELED_HEX64_RE =
  /(private[_-]?key|secret|key)(["'\s:=]{1,4})0x[0-9a-fA-F]{64}/gi;

/** 控制字符（除 tab / 换行）。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * 清洗一段自由文本：替换凭证、截断长度、去控制字符。
 */
export function redactText(input: string): string {
  let out = input;
  out = out.replace(CREDENTIAL_PARAM_RE, '$1[redacted]');
  out = out.replace(BEARER_RE, '$1[redacted]');
  out = out.replace(BASIC_AUTH_RE, '$1[redacted]');
  out = out.replace(JWT_RE, '[redacted-jwt]');
  out = out.replace(LABELED_HEX64_RE, '$1$2[redacted-key]');
  out = out.replace(SECRET_ASSIGN_RE, '$1$2$3[redacted]');
  out = out.replace(VENDOR_KEY_RE, '[redacted-key]');
  out = out.replace(CONTROL_CHARS_RE, '');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > MAX_MESSAGE_LENGTH) out = `${out.slice(0, MAX_MESSAGE_LENGTH)}…`;
  return out;
}

const SENSITIVE_KEY_RE =
  /(pass(word|wd)?|secret|token|api[_-]?key|apikey|credential|authorization|cookie|private[_-]?key|mnemonic|seed|signedpayload|signature)/i;

const MAX_DETAIL_DEPTH = 5;
const MAX_DETAIL_KEYS = 50;

/**
 * 递归清洗 details：删除凭证类键，限制深度与键数量。
 *
 * 返回值一定是可 JSON 序列化的普通对象，避免循环引用导致错误处理本身失败。
 */
export function redactDetails(
  value: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (depth > MAX_DETAIL_DEPTH) return undefined;
  if (value === null || typeof value !== 'object') return undefined;

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_DETAIL_KEYS) break;
    count += 1;
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizeValue(raw, depth + 1);
  }
  return out;
}

function sanitizeValue(raw: unknown, depth: number): unknown {
  if (typeof raw === 'string') return redactText(raw);
  if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) return raw;
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const items = raw.slice(0, MAX_DETAIL_KEYS).map((v) => sanitizeValue(v, depth + 1));
    return items.some((v) => v !== undefined) ? items : undefined;
  }
  if (typeof raw === 'object') {
    const nested = redactDetails(raw, depth);
    return nested;
  }
  return String(raw);
}
