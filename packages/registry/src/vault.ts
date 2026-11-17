/**
 * `vault:` 凭据引用解析（ADR-003 允许的三种引用形式之一；M5 生产加固 E4）。
 *
 * 为什么需要一个接口而不是直接读环境变量：ADR-003 规定配置里只放**引用**，
 * 真实密钥由外部秘密管理。`vault:` 表达"这是一个需要秘密管理器解析的路径"，
 * 与 `env:`（进程环境）、`file:`（本地文件）区分开——三者风险等级不同。
 *
 * 默认实现是**文件型 vault**（root 目录 + 相对路径），理由：
 * 1. `pnpm verify` 必须**离线可复现**——不能依赖一个真实的 Vault 服务器；
 * 2. 文件型 vault 与真实 Vault/HashiCorp KMS 的语义同构（mount path → secret），
 *    因此上层代码在切换实现时不需要改契约；
 * 3. 接真实 Vault 时只需注入另一个 `VaultReader`，**不改注册表格式**。
 *
 * 安全约束（本模块自行保证，不依赖调用方）：
 * - **禁止路径逃逸**：`vault:` 路径解析后必须落在 root 目录内。
 *   这一条是硬要求——没有它，`vault:../../etc/shadow` 就能读到任意文件；
 * - 读取失败/不存在一律返回 `undefined`，由调用方按 `missingIsUndefined` 决定
 *   是"公开端点未认证"还是"配置错误"；错误文本**不含路径内容**以外的信息；
 * - 解析结果只存在于内存，由调用方负责不落日志（本模块不记录任何内容）。
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** 秘密解析器：把 `vault:` 的路径解析为明文；未找到返回 `undefined`。 */
export interface VaultReader {
  /**
   * @param path `vault:` 之后的路径部分（例如 `dfr/providers/base-sepolia`）。
   * @returns 秘密明文；不存在或不可读时返回 `undefined`。
   */
  read(path: string): string | undefined;
}

/**
 * 文件型 vault：root 目录下的相对路径。
 *
 * 目录布局示例（`DFR_VAULT_DIR=/run/secrets/dfr`）：
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
      // 空文件视为"未提供"，与 `env:` 里空字符串的处理保持一致。
      return value === '' ? undefined : value;
    } catch {
      return undefined;
    }
  }
}

/**
 * 把 vault 路径解析为 root 内的绝对路径；**越界返回 `undefined`**。
 *
 * 单独导出便于直接测试"路径逃逸被拒绝"这一不变量——它不能只靠读代码确认。
 * 拒绝的情况：绝对路径、`..` 逃逸、解析后落在 root 之外、空路径。
 * 返回 `undefined` 而不是抛错：调用方（resolveCredential）把"未找到"统一处理成
 * `undefined`，避免"越界"与"配置错误"在日志里产生可区分的探针。
 */
export function resolveVaultPath(root: string, path: string): string | undefined {
  if (path === '') return undefined;
  // 绝对路径直接拒绝：`vault:/etc/passwd` 不应被解释为 root 下的某个条目。
  if (isAbsolute(path)) return undefined;

  const candidate = resolve(root, normalize(path));
  const rel = relative(root, candidate);
  // 逃逸判定：`..` 开头，或为空（= root 本身，指向目录而非秘密）。
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  // Windows 盘符切换（C:\）在 POSIX 上不会出现，但保留判断以防御跨平台误用。
  if (isAbsolute(rel)) return undefined;
  return candidate;
}

/**
 * 默认 vault：依据 `DFR_VAULT_DIR` 构造。
 *
 * 未设置时返回 `undefined`，调用方据此报"`vault:` 引用需要配置 DFR_VAULT_DIR"
 * ——**不静默当作缺失**，否则一个需要认证的端点在配置错误时会变成未认证访问。
 */
export function vaultFromEnv(env: NodeJS.ProcessEnv): VaultReader | undefined {
  const dir = env['DFR_VAULT_DIR'];
  if (dir === undefined || dir.trim() === '') return undefined;
  return new FileVaultReader(dir);
}
