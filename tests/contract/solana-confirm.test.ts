/**
 * Solana Adapter observeConfirmation 测试（DFR-M3-C02）。
 *
 * 权威来源：ADR-031（commitment 三级映射）、m3-taskbook C02。
 * 离线：mock Provider 按 commitment 返回不同结果。
 */
import { describe, expect, it } from 'vitest';
import { createDfrError } from '@dfr/errors';
import { SolanaAdapter } from '@dfr/adapter-solana';
import type { Chain, ChainId } from '@dfr/types';
import { makeContext } from './adapter-contract.js';

const DEVNET = 'solana-devnet' as ChainId;
const SIGNATURE = '1'.repeat(64); // 合法形状的 64 字节签名

const chain: Chain = {
  id: DEVNET,
  displayName: 'Solana Devnet',
  family: 'solana',
  network: 'devnet',
  adapter: { id: 'solana', version: '^0.1.0' },
  finality: { kind: 'commitment', levels: ['processed', 'confirmed'] },
  finalityStatus: 'unverified',
  capabilities: ['account.balance', 'block.read', 'transaction.read', 'transaction.build', 'transaction.simulate', 'transaction.broadcast'],
};

/** 按 commitment 分层应答：finalized / confirmed 有、processed 有。 */
function handlersByCommitment(map: Record<string, unknown>) {
  return {
    getTransaction: (params: readonly unknown[]) => {
      const opts = params[1] as { commitment?: string } | undefined;
      const value = map[opts?.commitment ?? 'processed'] ?? null;
      return value;
    },
  };
}

const txAt = (slot: number, err: unknown = null) => ({
  slot,
  blockTime: 1_700_000_000,
  transaction: { signatures: [SIGNATURE], message: { accountKeys: [], recentBlockhash: 'x' } },
  meta: { err, fee: 5000, computeUnitsConsumed: 150, logMessages: [] },
});

describe('Solana observeConfirmation（M3-C02）', () => {
  const adapter = new SolanaAdapter({ chain });

  it('finalized 可用时：status=finalized，finality=finalized，带 slot', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ finalized: txAt(100) }));
    const obs = await adapter.observeConfirmation(ctx, { txHash: SIGNATURE });
    expect(obs).not.toBeNull();
    expect(obs!.status).toBe('finalized');
    expect(obs!.finality).toBe('finalized');
    expect(obs!.blockRef).toEqual({ kind: 'slot', slot: '100' });
    // Solana 不伪造 canonicalBlockHash（getTransaction 不返回区块哈希）。
    expect(obs!.canonicalBlockHash).toBeUndefined();
  });

  it('只在 confirmed 可见时：status=confirmed，finality=confirmed', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ confirmed: txAt(90) }));
    const obs = await adapter.observeConfirmation(ctx, { txHash: SIGNATURE });
    expect(obs!.status).toBe('confirmed');
    expect(obs!.finality).toBe('confirmed');
  });

  it('只在 processed 可见时：finality=included（ADR-031：processed→included）', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ processed: txAt(80) }));
    const obs = await adapter.observeConfirmation(ctx, { txHash: SIGNATURE });
    expect(obs!.status).toBe('included');
    expect(obs!.finality).toBe('included');
  });

  it('执行失败但已确认：status=reverted，finality 照实报告', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ finalized: txAt(70, { InstructionError: [0, 'Custom'] }) }));
    const obs = await adapter.observeConfirmation(ctx, { txHash: SIGNATURE });
    expect(obs!.status).toBe('reverted');
    expect(obs!.finality).toBe('finalized');
  });

  it('三级都查不到 → null（上层保持 unknown，不假装状态）', async () => {
    const ctx = makeContext(chain, handlersByCommitment({}));
    expect(await adapter.observeConfirmation(ctx, { txHash: SIGNATURE })).toBeNull();
  });

  it('cluster 不支持 processed commitment（devnet 实测）→ 跳过该档位，不当作失败', async () => {
    // devnet 的 getTransaction 对 processed 返回 -32602 "Method does not support
    // commitment below `confirmed`"。finalized/confirmed 查不到时也不能因此抛错。
    const ctx = makeContext(chain, {
      getTransaction: (params: readonly unknown[]) => {
        const opts = params[1] as { commitment?: string } | undefined;
        if (opts?.commitment === 'processed') {
          throw createDfrError('DFR_PROVIDER_INVALID_RESPONSE', {
            requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
            chain: DEVNET,
            message: 'Method does not support commitment below `confirmed`',
            chainError: { message: 'Method does not support commitment below `confirmed`' },
          });
        }
        return null;
      },
    });
    expect(await adapter.observeConfirmation(ctx, { txHash: SIGNATURE })).toBeNull();
  });

  it('非法签名 → DFR_INVALID_REQUEST（形状校验在 Adapter）', async () => {
    const ctx = makeContext(chain, handlersByCommitment({ finalized: txAt(1) }));
    await expect(
      adapter.observeConfirmation(ctx, { txHash: 'not-a-signature' }),
    ).rejects.toMatchObject({ code: 'DFR_INVALID_REQUEST' });
  });
});
