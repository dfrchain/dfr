// `vault:` credential references (M5 production hardening E4).
//
// The most important rule is not "secrets can be read", but **path escapes must be rejected**:
// if `vault:../../etc/passwd` were treated as a relative path, any file could be read.
// That invariant is tested directly against `resolveVaultPath`, not inferred indirectly from read behavior.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileVaultReader, resolveVaultPath, vaultFromEnv } from '../src/vault.js';

function vaultDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dfr-vault-'));
  mkdirSync(join(root, 'providers'), { recursive: true });
  writeFileSync(join(root, 'providers', 'base-sepolia.key'), 'super-secret\n', 'utf8');
  writeFileSync(join(root, 'empty'), '', 'utf8');
  return root;
}

describe('resolveVaultPath', () => {
  const root = '/run/secrets/dfr';

  it('a normal relative path resolves inside root', () => {
    expect(resolveVaultPath(root, 'providers/base.key')).toBe('/run/secrets/dfr/providers/base.key');
  });

  it('rejects .. escapes', () => {
    expect(resolveVaultPath(root, '../etc/passwd')).toBeUndefined();
    expect(resolveVaultPath(root, '../../etc/passwd')).toBeUndefined();
    // Mid-path escapes are rejected too (not just a prefix check)
    expect(resolveVaultPath(root, 'a/../../etc/passwd')).toBeUndefined();
  });

  it('rejects absolute paths', () => {
    expect(resolveVaultPath(root, '/etc/passwd')).toBeUndefined();
  });

  it('rejects empty paths and root itself', () => {
    expect(resolveVaultPath(root, '')).toBeUndefined();
    expect(resolveVaultPath(root, '.')).toBeUndefined();
  });

  it('allows normal paths containing .', () => {
    expect(resolveVaultPath(root, './providers/base.key')).toBe('/run/secrets/dfr/providers/base.key');
  });
});

describe('FileVaultReader', () => {
  it('reads and strips the trailing newline', () => {
    const reader = new FileVaultReader(vaultDir());
    expect(reader.read('providers/base-sepolia.key')).toBe('super-secret');
  });

  it('a missing entry returns undefined', () => {
    expect(new FileVaultReader(vaultDir()).read('nope')).toBeUndefined();
  });

  it('an empty file counts as not provided (consistent with an empty env: string)', () => {
    expect(new FileVaultReader(vaultDir()).read('empty')).toBeUndefined();
  });

  it('path escapes cannot read files outside the vault', () => {
    const reader = new FileVaultReader(vaultDir());
    // Even if the real file exists, it must not be reachable through the vault
    expect(reader.read('../../../../etc/hosts')).toBeUndefined();
  });
});

describe('vaultFromEnv', () => {
  it('returns undefined when DFR_VAULT_DIR is not set', () => {
    expect(vaultFromEnv({})).toBeUndefined();
    expect(vaultFromEnv({ DFR_VAULT_DIR: '   ' })).toBeUndefined();
  });

  it('returns a usable reader once set', () => {
    const dir = vaultDir();
    const reader = vaultFromEnv({ DFR_VAULT_DIR: dir });
    expect(reader?.read('providers/base-sepolia.key')).toBe('super-secret');
  });
});
