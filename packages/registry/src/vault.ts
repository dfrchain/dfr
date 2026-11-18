/**
 * Resolving `vault:` credential references (one of the three reference forms ADR-003 allows; M5 production hardening E4).
 *
 * Why an interface instead of reading environment variables directly: ADR-003 requires configuration to hold only **references**,
 * with real secrets held by an external secret manager. `vault:` expresses "this is a path a secret manager must resolve",
 * distinct from `env:` (process environment) and `file:` (local file) — the three carry different risk levels.
 *
 * The default implementation is a **file-based vault** (root directory + relative path), for these reasons:
 * 1. `pnpm verify` must be **reproducible offline** — it cannot depend on a real Vault server;
 * 2. A file-based vault is semantically isomorphic to a real Vault/HashiCorp KMS (mount path → secret),
 *    so upper layers need no contract change when switching implementations;
 * 3. Connecting a real Vault only requires injecting another `VaultReader`, with **no change to the registry format**.
 *
 * Security constraints (guaranteed by this module itself, not by callers):
 * - **No path escapes**: a resolved `vault:` path must land inside the root directory.
 *   This is a hard requirement — without it, `vault:../../etc/shadow` could read any file;
 * - Read failures / missing entries always return `undefined`; the caller decides via `missingIsUndefined` whether that means
 *   "public endpoint, unauthenticated" or "configuration error"; error text carries **no information beyond the path content**;
 * - Resolution results live only in memory, and callers are responsible for not logging them (this module logs nothing).
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** Secret resolver: resolves a `vault:` path to plaintext; returns `undefined` when not found. */
export interface VaultReader {
  /**
   * @param path The path part after `vault:` (e.g. `dfr/providers/base-sepolia`).
   * @returns The secret plaintext; `undefined` when missing or unreadable.
   */
  read(path: string): string | undefined;
}

/**
 * File-based vault: relative paths under a root directory.
 *
 * Example directory layout (`DFR_VAULT_DIR=/run/secrets/dfr`):
 * ```text
 * /run/secrets/dfr/providers/base-sepolia.key   ← vault:providers/base-sepolia.key
 * ```
 */
export class FileVaultReader implements VaultReader {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  read(path: string): string | undefined {
    const target = resolveVaultPath(this.#root, path);
    if (target === undefined) return undefined;
    try {
      const value = readFileSync(target, 'utf8').trim();
      // An empty file counts as "not provided", consistent with how empty strings are handled in `env:`.
      return value === '' ? undefined : value;
    } catch {
      return undefined;
    }
  }
}

/**
 * Resolve a vault path to an absolute path inside root; **return `undefined` when out of bounds**.
 *
 * Exported separately so the "path escapes are rejected" invariant can be tested directly — reading the code alone cannot confirm it.
 * Rejected cases: absolute paths, `..` escapes, paths resolving outside root, empty paths.
 * Returns `undefined` instead of throwing: the caller (resolveCredential) uniformly treats "not found" as
 * `undefined`, so "out of bounds" and "configuration error" cannot produce distinguishable probes in logs.
 */
export function resolveVaultPath(root: string, path: string): string | undefined {
  if (path === '') return undefined;
  // Absolute paths are rejected outright: `vault:/etc/passwd` must not be read as an entry under root.
  if (isAbsolute(path)) return undefined;

  const candidate = resolve(root, normalize(path));
  const rel = relative(root, candidate);
  // Escape check: starts with `..`, or is empty (= root itself, a directory rather than a secret).
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  // Windows drive switching (C:\) cannot occur on POSIX, but the check is kept to guard against cross-platform misuse.
  if (isAbsolute(rel)) return undefined;
  return candidate;
}

/**
 * Default vault: built from `DFR_VAULT_DIR`.
 *
 * Returns `undefined` when unset, so the caller reports "`vault:` references require DFR_VAULT_DIR to be configured"
 * — **never silently treated as missing**, or an endpoint needing authentication would become unauthenticated access on a configuration error.
 */
export function vaultFromEnv(env: NodeJS.ProcessEnv): VaultReader | undefined {
  const dir = env['DFR_VAULT_DIR'];
  if (dir === undefined || dir.trim() === '') return undefined;
  return new FileVaultReader(dir);
}
