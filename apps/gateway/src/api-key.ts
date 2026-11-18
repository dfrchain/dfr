/**
 * API Key issuance (developer-product task 03, item 2: "check authentication / API keys").
 *
 * Before this module the only way to obtain a key was for an operator to hand-compute
 * `sha256(secret+pepper)` and paste it into the deployment env — a step developers cannot do and
 * operators get wrong. This is the supported, testable issuance path.
 *
 * Security contract (unchanged from the auth spec):
 * - The plaintext key is returned **once** to the caller and never persisted here;
 * - Only `sha256(secret + pepper)` is meant to reach configuration;
 * - `keyId` is not a secret and may appear in audit logs;
 * - Issuance does not log, print, or store the secret implicitly.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { hashSecret } from './auth.js';

const KEY_ID_RE = /^[A-Za-z0-9]{8}$/;
const KEY_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export interface IssueApiKeyOptions {
  /** Must match the target deployment's `DFR_M0_API_KEY_PEPPER`. */
  pepper: string;
  /** Optional fixed 8-char base62 id (for planned rotation); random when omitted. */
  keyId?: string;
  /** Echoed back for the caller's convenience; never part of the credential. */
  projectId?: string;
}

export interface IssuedApiKey {
  /** 8-char base62 key id embedded in the key. */
  keyId: string;
  /** 43-char base64url secret. Shown once; never store it. */
  secret: string;
  /** Complete credential, sent as `x-dfr-key`. */
  apiKey: string;
  /** `sha256(secret + pepper)` hex — the only value that belongs in configuration. */
  hash: string;
  projectId?: string;
}

/** Generate a key that `verifyApiKey` will accept, without persisting the plaintext. */
export function issueApiKey(options: IssueApiKeyOptions): IssuedApiKey {
  if (typeof options.pepper !== 'string' || options.pepper === '') {
    throw new TypeError('issueApiKey: pepper is required');
  }
  const keyId = options.keyId ?? randomKeyId();
  if (!KEY_ID_RE.test(keyId)) {
    throw new TypeError('issueApiKey: keyId must be exactly 8 base62 characters');
  }
  // 32 random bytes -> 43 base64url chars, inside the auth regex's 20..64 range.
  const secret = randomBytes(32).toString('base64url');
  const apiKey = `dfr_${keyId}_${secret}`;
  return {
    keyId,
    secret,
    apiKey,
    hash: hashSecret(secret, options.pepper),
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
  };
}

function randomKeyId(): string {
  let id = '';
  for (let i = 0; i < 8; i += 1) id += KEY_ID_ALPHABET[randomInt(0, KEY_ID_ALPHABET.length)];
  return id;
}
