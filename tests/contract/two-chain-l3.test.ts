/**
 * M2-D01：两链 L3 对照验收。
 *
 * 完成门（roadmap M2）："两链 L3 对照"。重点**不是**再跑一遍 Adapter，
 * 而是证明 EVM 与 Solana 跑的是**同一套**通用断言，差异通过数据表达而非分叉。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDfrError } from '@dfr/errors';
import { TWO_CHAINS } from './two-chain-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('M2-D01 两链 L3 对照', () => {
  it('通用契约测试里不存在按链族分叉的分支（同一套断言）', () => {
    const source = readFileSync(resolve(here, 'adapter-contract.ts'), 'utf8');
    // 通用断言不得按 family 分支：差异必须由 subject 数据表达。
    // 若有人为了"让新链通过"在通用文件里加 if，这条会立刻失败（AGENTS.md §6）。
    // 只匹配**代码**，不匹配注释里作为反例出现的字样：
    // 先去掉行内注释与块注释，再扫描。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\/\/[^\n]*/gu, '');
    const familyBranches = code.match(/family\s*===\s*['"][a-z]+['"]/gu) ?? [];
    expect(
      familyBranches,
      `通用契约测试不得按链族分叉，发现：${familyBranches.join(', ')}`,
    ).toEqual([]);
    // 差异确实是**声明式**的。
    expect(source).toContain('unsupportedBlockRefs');
  });

  it('两个 Adapter 对"非法账户"给出同一个错误码（行为一致）', async () => {
    const codes: string[] = [];
    for (const fixture of TWO_CHAINS) {
      try {
        await fixture.getBalanceWithInvalidAccount();
        codes.push('no-error');
      } catch (err) {
        codes.push(isDfrError(err) ? err.code : 'not-dfr-error');
      }
    }
    // 两链都必须是 DFR_INVALID_ACCOUNT —— 同一套语义，不同链。
    expect(codes).toEqual(['DFR_INVALID_ACCOUNT', 'DFR_INVALID_ACCOUNT']);
  });

  it('两链都拒绝自己声明的、不支持的定位方式（差异被显式表达）', async () => {
    for (const fixture of TWO_CHAINS) {
      expect(
        fixture.unsupportedBlockRefs.length,
        `${fixture.chain.id} 应声明至少一个不支持的 BlockRef 分支`,
      ).toBeGreaterThan(0);
      for (const ref of fixture.unsupportedBlockRefs) {
        await expect(
          fixture.getBlockRef(ref),
          `${fixture.chain.id} 的 ${ref.kind} 定位应 fail-closed`,
        ).rejects.toMatchObject({ code: 'DFR_UNSUPPORTED_CAPABILITY' });
      }
    }
  });

  it('两链各自的 registry 能力都被自己的 Adapter 实现（registry ⊆ adapter）', () => {
    for (const fixture of TWO_CHAINS) {
      const declared = new Set(fixture.capabilities().capabilities);
      for (const required of fixture.chain.capabilities) {
        expect(declared.has(required), `${fixture.chain.id} 缺少 ${required}`).toBe(true);
      }
    }
  });

  it('两链的 family 不同、但都声明同一套能力语义（account.balance / block.read / transaction.read）', () => {
    const families = TWO_CHAINS.map((f) => f.chain.family);
    expect(new Set(families).size, '对照要求两条不同的链族').toBe(2);
    for (const fixture of TWO_CHAINS) {
      for (const cap of ['account.balance', 'block.read', 'transaction.read']) {
        expect(fixture.capabilities().capabilities).toContain(cap);
      }
    }
  });
});
