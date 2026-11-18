/**
 * Registry secret scanning (see validation rule 4 in packages/registry/config/README.md).
 *
 * Relationship to scripts/check-secrets.sh: the script scans **repository files**, while this module scans
 * **runtime registry content** (which may come from a local override file or future remote configuration).
 * The two cover different input sources and cannot substitute for each other.
 */

/** Keep the same pattern set as the repository script, so the two rule sets cannot drift. */
const KEY_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'hex-64-private-key', re: /0x[0-9a-fA-F]{64}\b/ },
  { name: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'pem-private-key', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
];

export interface SecretFinding {
  /** JSON path of the hit, e.g. `chains.ethereum-sepolia.displayName`. */
  path: string;
  pattern: string;
  /** Keep only the first few characters, so a suspected secret itself is never written to logs. */
  excerpt: string;
}

/** Recursively scan string values in any structure. */
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
