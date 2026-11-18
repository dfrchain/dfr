/**
 * API Key issuance contract (developer-product task 03).
 *
 * The commercial acceptance bar starts with "obtain an API key". These tests pin the supported
 * issuance path to the same credential format and hash function the Gateway verifies with, so an
 * issued key cannot be a near-miss of the auth contract.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { issueApiKey, verifyApiKey, hashSecret, type StaticApiKeyConfig } from '../src/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PEPPER = 'issuance-test-pepper';

function configFor(issued: { keyId: string; hash: string }): StaticApiKeyConfig {
  return {
    keyId: issued.keyId,
    currentHash: issued.hash,
    pepper: PEPPER,
    projectId: 'issuance',
    scope: { chains: '*', capabilities: '*', allowWrite: false },
  };
}

describe('issueApiKey', () => {
  it('produces a key in the documented format that the Gateway verifier accepts', () => {
    const issued = issueApiKey({ pepper: PEPPER });
    expect(issued.apiKey).toMatch(/^dfr_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20,64}$/);
    expect(issued.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.hash).not.toContain(issued.secret);

    const result = verifyApiKey(issued.apiKey, configFor(issued));
    expect(result).toMatchObject({ ok: true, keyId: issued.keyId, projectId: 'issuance' });
  });

  it('binds the hash to the pepper (a different deployment pepper rejects the key)', () => {
    const issued = issueApiKey({ pepper: PEPPER });
    expect(verifyApiKey(issued.apiKey, configFor(issued)).ok).toBe(true);
    expect(
      verifyApiKey(issued.apiKey, { ...configFor(issued), pepper: 'other-pepper', currentHash: hashSecret(issued.secret, 'other-pepper') }).ok,
    ).toBe(true); // sanity: hash and pepper agree
    expect(
      verifyApiKey(issued.apiKey, { ...configFor(issued), pepper: 'other-pepper' }).ok,
    ).toBe(false);
  });

  it('generates a fresh secret and key id on every call', () => {
    const keys = new Set(Array.from({ length: 8 }, () => issueApiKey({ pepper: PEPPER }).apiKey));
    expect(keys.size).toBe(8);
  });

  it('accepts an explicit 8-char key id and rejects malformed ones', () => {
    const issued = issueApiKey({ pepper: PEPPER, keyId: 'Rotate01', projectId: 'proj-1' });
    expect(issued.keyId).toBe('Rotate01');
    expect(issued.projectId).toBe('proj-1');
    expect(verifyApiKey(issued.apiKey, configFor(issued)).ok).toBe(true);

    expect(() => issueApiKey({ pepper: PEPPER, keyId: 'short' })).toThrow(TypeError);
    expect(() => issueApiKey({ pepper: PEPPER, keyId: 'bad-chars' })).toThrow(TypeError);
    expect(() => issueApiKey({ pepper: '' })).toThrow(TypeError);
  });
});

describe('scripts/issue-api-key.ts', () => {
  it('prints a machine-readable key whose hash verifies, and never echoes the pepper', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        '--experimental-transform-types',
        '--import',
        './scripts/ts-runtime/register.mjs',
        'scripts/issue-api-key.ts',
        '--project',
        'cli-project',
        '--json',
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DFR_M0_API_KEY_PEPPER: PEPPER },
        encoding: 'utf8',
      },
    );
    const parsed = JSON.parse(stdout) as {
      apiKey: string;
      keyId: string;
      hash: string;
      projectId: string;
    };
    expect(parsed.projectId).toBe('cli-project');
    expect(parsed.apiKey).toMatch(/^dfr_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20,64}$/);
    expect(verifyApiKey(parsed.apiKey, configFor(parsed)).ok).toBe(true);
    expect(stdout).not.toContain(PEPPER);
  }, 30_000);

  it('fails closed without a pepper', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-strip-types',
          '--experimental-transform-types',
          '--import',
          './scripts/ts-runtime/register.mjs',
          'scripts/issue-api-key.ts',
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, DFR_M0_API_KEY_PEPPER: '' },
          encoding: 'utf8',
          stdio: 'pipe',
        },
      ),
    ).toThrow();
  }, 30_000);
});
