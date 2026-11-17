/**
 * Solana codec 对真实链上数据的校验（DFR-M3-A02，离线 ground truth）。
 *
 * 为什么需要：手算向量只能证明"我能编码出我以为的样子"。这里用**真实 devnet
 * finalized 区块**的原始交易字节，把我们的 decoder 与**链节点的** `encoding: json`
 * 解析逐字段对照——两套独立实现一致，才说明 wire format 理解正确。
 *
 * 数据是公开链上数据；离线运行（不联网、不需要凭证）。
 */
import { describe, expect, it } from 'vitest';
import { SolanaCodecError, decodeTransactionPayload } from '@dfr/adapter-solana';
import { SOLANA_DEVNET_FIXTURES } from './support/devnet-fixtures.js';

const STATIC = SOLANA_DEVNET_FIXTURES.filter((f) => f.numAddressTableLookups === 0);

describe('Solana codec vs 真实 devnet 区块（M3-A02）', () => {
  it('样本覆盖 legacy、v0（含带 ALT lookup 的 v0）', () => {
    const legacy = SOLANA_DEVNET_FIXTURES.filter((f) => f.version === 'legacy').length;
    const v0 = SOLANA_DEVNET_FIXTURES.filter((f) => f.version === 'v0').length;
    expect(legacy).toBeGreaterThanOrEqual(1);
    expect(v0).toBeGreaterThanOrEqual(1);
    expect(SOLANA_DEVNET_FIXTURES.some((f) => f.numAddressTableLookups > 0)).toBe(true);
  });

  for (const fixture of STATIC) {
    it(`${fixture.version}：账户表 / header / blockhash / 指令数 与链节点解析一致`, () => {
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
    it(`${fixture.version}：每个 programId / 账户下标都落在账户表内`, () => {
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

  it('带 ALT lookup 的 v0 → 显式 fail-closed（需要链上账户表解析，本卡不做）', () => {
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
