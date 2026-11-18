/**
 * Solana codec verification against real on-chain data (DFR-M3-A02, offline ground truth).
 *
 * Why it is needed: hand-computed vectors only prove "I can encode what I think it looks like". Here, **real devnet
 * finalized block** raw transaction bytes put our decoder side by side with the **chain node's** `encoding: json`
 * parse, field by field — only when two independent implementations agree is the wire format understood correctly.
 *
 * The data is public on-chain data; runs offline (no network, no credentials needed).
 */
import { describe, expect, it } from 'vitest';
import { SolanaCodecError, decodeTransactionPayload } from '@dfr/adapter-solana';
import { SOLANA_DEVNET_FIXTURES } from './support/devnet-fixtures.js';

const STATIC = SOLANA_DEVNET_FIXTURES.filter((f) => f.numAddressTableLookups === 0);

describe('Solana codec vs real devnet blocks (M3-A02)', () => {
  it('samples cover legacy, v0 (including v0 with ALT lookup)', () => {
    const legacy = SOLANA_DEVNET_FIXTURES.filter((f) => f.version === 'legacy').length;
    const v0 = SOLANA_DEVNET_FIXTURES.filter((f) => f.version === 'v0').length;
    expect(legacy).toBeGreaterThanOrEqual(1);
    expect(v0).toBeGreaterThanOrEqual(1);
    expect(SOLANA_DEVNET_FIXTURES.some((f) => f.numAddressTableLookups > 0)).toBe(true);
  });

  for (const fixture of STATIC) {
    it(`${fixture.version}: account table / header / blockhash / instruction count match the chain-node parse`, () => {
      const decoded = decodeTransactionPayload(fixture.blockPayloadBase64);

      expect(decoded.version).toBe(fixture.version);
      expect(decoded.signed).toBe(true);
      expect(decoded.accountKeys).toEqual(fixture.accountKeys);
      expect(decoded.header).toEqual(fixture.header);
      expect(decoded.recentBlockhash).toBe(fixture.recentBlockhash);
      expect(decoded.instructions).toHaveLength(fixture.instructionCount);
      expect(decoded.header.numRequiredSignatures).toBeGreaterThanOrEqual(1);
    });
  }

  for (const fixture of STATIC) {
    it(`${fixture.version}: every programId / account index falls inside the account table`, () => {
      const decoded = decodeTransactionPayload(fixture.blockPayloadBase64);
      for (const instruction of decoded.instructions) {
        expect(instruction.programId).toBe(decoded.accountKeys[instruction.programIdIndex]);
        expect(instruction.programIdIndex).toBeLessThan(decoded.accountKeys.length);
        for (const index of instruction.accountIndices) {
          expect(index).toBeLessThan(decoded.accountKeys.length);
        }
      }
    });
  }

  it('v0 with ALT lookup → explicit fail-closed (needs on-chain account-table resolution; this card does not do it)', () => {
    const withLookup = SOLANA_DEVNET_FIXTURES.find((f) => f.numAddressTableLookups > 0)!;
    let caught: unknown;
    try {
      decodeTransactionPayload(withLookup.blockPayloadBase64);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SolanaCodecError);
    expect((caught as SolanaCodecError).reason).toBe('address_table_lookup_unsupported');
  });
});
