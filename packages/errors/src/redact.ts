/**
 * Error and log redaction (see docs/architecture/error-spec-v0.1.md chapter 6).
 *
 * Hard constraint: error fields must never contain private keys, mnemonics, API keys, tokens, JWTs, cookies,
 * the RPC endpoint query string, Authorization header, or raw signatures.
 *
 * This module is the "last gate": even if an upstream Provider or Adapter carries the raw message into an error,
 * it is scrubbed here at the exit. The scrubbing rules are **deterministic**, so unit tests can regress on them.
 */

/** Maximum length of a single message, so an upstream cannot stuff an entire JSON document into detail. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * Credential-like parameters / assignments.
 *
 * The leading boundary character must not be `_`, otherwise the `key=` in `private_key=` would be mistaken for a parameter name.
 */
const CREDENTIAL_PARAM_RE =
  /((?:^|[\s?&,;])(?:api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|signature|sig)=)[^&\s#]*/gi;

/** HTTP Authorization / Bearer <redacted> Basic. */
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const BASIC_AUTH_RE = /(Basic\s+)[A-Za-z0-9+/=]{8,}/gi;

/** Common vendor key prefixes. */
const VENDOR_KEY_RE =
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|xox[abprs])-[A-Za-z0-9_-]{12,}/g;

/** JWT (three base64url segments). */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Private key / mnemonic / secret assignment forms (optional quotes around the value). */
const SECRET_ASSIGN_RE =
  /(private[_-]?key|mnemonic|seed[_-]?phrase|secret[_-]?key|secret)(["'\s:=]{1,4})(["']?)(?!\[redacted)[^\s"',;]{6,}/gi;

/** `0x` + 64 hex chars flagged as a key: replaced only in this explicit context. */
const LABELED_HEX64_RE =
  /(private[_-]?key|secret|key)(["'\s:=]{1,4})0x[0-9a-fA-F]{64}/gi;

/** Control characters (except tab / newline). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Scrub a free-text segment: replace credentials, truncate length, strip control characters.
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
 * Recursively scrub details: remove credential-like keys, limit depth and key count.
 *
 * The return value is always a JSON-serializable plain object, so a circular reference cannot break error handling itself.
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
