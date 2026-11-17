// `vault:` 凭据引用（M5 生产加固 E4）。
//
// 最关键的一条不是"能读到秘密"，而是**路径逃逸必须被拒绝**：
// `vault:../../etc/passwd` 若被解释为相对路径，就能读到任意文件。
// 该不变量直接测 `resolveVaultPath`，不通过读取行为间接推断。
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

  it('正常相对路径解析到 root 内', () => {
    expect(resolveVaultPath(root, 'providers/base.key')).toBe('/run/secrets/dfr/providers/base.key');
  });

  it('拒绝 .. 逃逸', () => {
    expect(resolveVaultPath(root, '../etc/passwd')).toBeUndefined();
    expect(resolveVaultPath(root, '../../etc/passwd')).toBeUndefined();
    // 中间段逃逸同样拒绝（不是只查前缀）
    expect(resolveVaultPath(root, 'a/../../etc/passwd')).toBeUndefined();
  });

  it('拒绝绝对路径', () => {
    expect(resolveVaultPath(root, '/etc/passwd')).toBeUndefined();
  });

  it('拒绝空路径与 root 自身', () => {
    expect(resolveVaultPath(root, '')).toBeUndefined();
    expect(resolveVaultPath(root, '.')).toBeUndefined();
  });

  it('允许含 . 的正常路径', () => {
    expect(resolveVaultPath(root, './providers/base.key')).toBe('/run/secrets/dfr/providers/base.key');
  });
});

describe('FileVaultReader', () => {
  it('读取并去掉尾随换行', () => {
    const reader = new FileVaultReader(vaultDir());
    expect(reader.read('providers/base-sepolia.key')).toBe('super-secret');
  });

  it('不存在的条目返回 undefined', () => {
    expect(new FileVaultReader(vaultDir()).read('nope')).toBeUndefined();
  });

  it('空文件视为未提供（与 env: 空字符串一致）', () => {
    expect(new FileVaultReader(vaultDir()).read('empty')).toBeUndefined();
  });

  it('路径逃逸读不到 vault 之外的文件', () => {
    const reader = new FileVaultReader(vaultDir());
    // 即便真实文件存在，也不得通过 vault 读到
    expect(reader.read('../../../../etc/hosts')).toBeUndefined();
  });
});

describe('vaultFromEnv', () => {
  it('未设置 DFR_VAULT_DIR 时返回 undefined', () => {
    expect(vaultFromEnv({})).toBeUndefined();
    expect(vaultFromEnv({ DFR_VAULT_DIR: '   ' })).toBeUndefined();
  });

  it('设置后返回可用 reader', () => {
    const dir = vaultDir();
    const reader = vaultFromEnv({ DFR_VAULT_DIR: dir });
    expect(reader?.read('providers/base-sepolia.key')).toBe('super-secret');
  });
});
