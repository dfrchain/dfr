/**
 * M2-D01: two-chain L3 comparison acceptance.
 *
 * Completion gate (roadmap M2): "two-chain L3 comparison". The point is **not** to run the Adapters again,
 * but to prove EVM and Solana run the **same** set of generic assertions, with differences expressed through
 * data rather than branching.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDfrError } from '@dfr/errors';
import { TWO_CHAINS } from './two-chain-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('M2-D01 two-chain L3 comparison', () => {
  it('the generic contract test has no per-chain-family branches (one set of assertions)', () => {
    const source = readFileSync(resolve(here, 'adapter-contract.ts'), 'utf8');
    // Generic assertions must not branch on family: differences must be expressed via subject data.
    // If someone adds an if to the generic file "to make a new chain pass", this fails immediately (AGENTS.md §6).
    // Match **code** only, not wording that appears in comments as a counterexample:
    // strip line and block comments first, then scan.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\/\/[^\n]*/gu, '');
    const familyBranches = code.match(/family\s*===\s*['"][a-z]+['"]/gu) ?? [];
    expect(
      familyBranches,
      `The generic contract test must not branch on chain family; found: ${familyBranches.join(', ')}`,
    ).toEqual([]);
    // The differences really are **declarative**.
    expect(source).toContain('unsupportedBlockRefs');
  });

  it('both Adapters give the same error code for an "invalid account" (consistent behaviour)', async () => {
    const codes: string[] = [];
    for (const fixture of TWO_CHAINS) {
      try {
        await fixture.getBalanceWithInvalidAccount();
        codes.push('no-error');
      } catch (err) {
        codes.push(isDfrError(err) ? err.code : 'not-dfr-error');
      }
    }
    // Both chains must be DFR_INVALID_ACCOUNT — the same semantics, different chains.
    expect(codes).toEqual(['DFR_INVALID_ACCOUNT', 'DFR_INVALID_ACCOUNT']);
  });

  it('both chains reject the addressing modes they declare unsupported (differences explicitly expressed)', async () => {
    for (const fixture of TWO_CHAINS) {
      expect(
        fixture.unsupportedBlockRefs.length,
        `${fixture.chain.id} must declare at least one unsupported BlockRef branch`,
      ).toBeGreaterThan(0);
      for (const ref of fixture.unsupportedBlockRefs) {
        await expect(
          fixture.getBlockRef(ref),
          `${fixture.chain.id}'s ${ref.kind} addressing must fail closed`,
        ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
      }
    }
  });

  it("each chain's registry capabilities are implemented by its own Adapter (registry ⊆ adapter)", () => {
    for (const fixture of TWO_CHAINS) {
      const declared = new Set(fixture.capabilities().capabilities);
      for (const required of fixture.chain.capabilities) {
        expect(declared.has(required), `${fixture.chain.id} is missing ${required}`).toBe(true);
      }
    }
  });

  it('the two chains have different families but declare the same capability semantics (account.balance / block.read / transaction.read)', () => {
    const families = TWO_CHAINS.map((f) => f.chain.family);
    expect(new Set(families).size, 'the comparison requires two different chain families').toBe(2);
    for (const fixture of TWO_CHAINS) {
      for (const cap of ['account.balance', 'block.read', 'transaction.read']) {
        expect(fixture.capabilities().capabilities).toContain(cap);
      }
    }
  });
});
