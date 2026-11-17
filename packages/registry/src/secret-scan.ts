/**
 * 注册表密钥扫描（见 packages/registry/config/README.md 校验规则第 4 条）。
 *
 * 与 scripts/check-secrets.sh 的关系：脚本扫描**仓库文件**，本模块扫描
 * **运行时的注册表内容**（可能来自本地覆盖文件或未来的远端配置）。
 * 两者覆盖不同输入来源，不能互相替代。
 */

/** 与仓库脚本保持同一组模式，避免两套规则漂移。 */
const KEY_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'hex-64-private-key', re: /0x[0-9a-fA-F]{64}\b/ },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'pem-private-key', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
];

export interface SecretFinding {
  /** 命中位置的 JSON 路径，例如 `chains.ethereum-sepolia.displayName`。 */
  path: string;
  pattern: string;
  /** 只保留前若干字符，避免把疑似密钥本体写进日志。 */
  excerpt: string;
}

/** 递归扫描任意结构中的字符串值。 */
export function scanForSecrets(value: unknown, path = '$'): SecretFinding[] {
  const findings: SecretFinding[] = [];

  const visit = (node: unknown, nodePath: string): void => {
    if (typeof node === 'string') {
      for (const { name, re } of KEY_PATTERNS) {
        const match = re.exec(node);
        if (match !== null) {
          findings.push({ path: nodePath, pattern: name, excerpt: `${match[0].slice(0, 8)}…` });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${nodePath}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        visit(child, `${nodePath}.${key}`);
      }
    }
  };

  visit(value, path);
  return findings;
}
