/**
 * D02：Solana devnet 真实写链（build → 外部签名 → 单次 broadcast → confirm → finalize）。
 *
 * 默认跳过。显式开启（需要**有资金的** devnet 账户）：
 *
 *   DFR_RUN_SOLANA_WRITE=1 \
 *   DFR_SOLANA_KEYPAIR=/path/to/id.json \
 *   DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL=https://api.devnet.solana.com \
 *   pnpm vitest run tests/integration/solana-devnet-write.test.ts
 *
 * 签名由**外部**完成（本测试用本地测试账户扮演外部签名者，见 support/solana-signer）。
 * 服务端从不接触私钥（ADR-007/009）。只记录非敏感证据（txHash / slot / finality）。
 *
 * 若账户无资金：广播会因手续费不足失败，本测试给出明确 skip 提示（不伪造成功）。
 */
import { describe, expect, it } from 'vitest';
import { DfrCore } from '@dfr/core';
import { SolanaAdapter } from '@dfr/adapter-solana';
import { EvmAdapter } from '@dfr/adapter-evm';
import { ChainRegistry } from '@dfr/registry';
import { createInMemoryTransactionStores } from '../e2e/support/in-memory-transaction-stores.js';
import { loadSolanaKeypair } from './support/solana-signer.js';
import { base58Encode, splitSignatures, fromBase64 } from '@dfr/adapter-solana';

const ENABLED =
  process.env['DFR_RUN_SOLANA_WRITE'] === '1' &&
  typeof process.env['DFR_SOLANA_KEYPAIR'] === 'string' &&
  process.env['DFR_SOLANA_KEYPAIR'].length > 0;

const DEVNET = 'solana-devnet' as never;
const RPC =
  process.env['DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL'] ?? 'https://api.devnet.solana.com';

function makeCore(): DfrCore {
  const registry = ChainRegistry.load({
    env: {
      DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL: RPC,
      DFR_PROVIDER_ETHEREUM_SEPOLIA_PRIMARY_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
      DFR_PROVIDER_ETHEREUM_SEPOLIA_SECONDARY_URL: 'https://1rpc.io/sepolia',
    },
  });
  return new DfrCore({
    registry,
    adapters: [
      { id: 'evm', version: '0.1.0', create: (chain) => new EvmAdapter({ chain }) },
      { id: 'solana', version: '0.1.0', create: (chain) => new SolanaAdapter({ chain }) },
    ],
    milestone: 'M2',
    transactionStores: createInMemoryTransactionStores(),
  });
}

const ctx = {
  requestId: 'req_01J8Z6W3Q2K9M4ABCDEFGHJKMN' as never,
  signal: new AbortController().signal,
};

/** 用外部 keypair 给未签名载荷（带零签名槽位）填写真实签名。 */
function signUnsigned(payloadBase64: string, sign: (m: Uint8Array) => Uint8Array): string {
  const bytes = fromBase64(payloadBase64, 'payload');
  const { signatures, messageBytes } = splitSignatures(bytes);
  const sig = sign(messageBytes);
  // 单签名交易：把第一个（也是唯一）槽位替换为真实签名。
  const out = Buffer.alloc(1 + signatures.length * 64 + messageBytes.length);
  out[0] = signatures.length;
  signatures.forEach((slot, index) => {
    const value = index === 0 ? sig : slot;
    Buffer.from(value).copy(out, 1 + index * 64);
  });
  Buffer.from(messageBytes).copy(out, 1 + signatures.length * 64);
  return out.toString('base64');
}

describe.skipIf(!ENABLED)('Solana devnet 真实写链（M3-D02）', () => {
  it('build → 外部签名 → 单次 broadcast → confirm（真实 devnet）', async () => {
    const core = makeCore();
    const keypair = loadSolanaKeypair(process.env['DFR_SOLANA_KEYPAIR']!);
    const from = base58Encode(keypair.publicKeyBytes);

    const unsigned = await core.buildTransaction(
      DEVNET,
      {
        chain: DEVNET,
        from: { chain: DEVNET, address: from },
        to: { chain: DEVNET, address: from }, // 自转 0 SOL：只验证链路，不动资金
        value: { asset: { kind: 'native', chain: DEVNET }, amount: '0' },
      } as never,
      ctx,
    );
    expect(unsigned.meta.recentBlockhash).toBeTruthy();

    const signedPayload = signUnsigned(unsigned.payload, keypair.sign);
    const txHash = base58Encode(splitSignatures(fromBase64(signedPayload, 'payload')).signatures[0]!);

    // 注：若账户无资金，节点会以 -32002 "Attempt to debit an account but found no
    // record of a prior credit" 拒绝——这是真实失败，**不**吞掉、不伪造成功。
    const broadcast = await core.broadcastTransaction(
      DEVNET,
      {
        schemaVersion: '1',
        chain: DEVNET,
        unsigned,
        signedPayload,
        expectedHash: txHash,
        signerRef: 'external:local-test-keypair',
      },
      ctx,
      { expectedFrom: { chain: DEVNET, address: from }, expectedUnsignedPayload: unsigned.payload },
    );
    expect(broadcast.accepted).toBe(true);
    expect(broadcast.ref).toEqual({ kind: 'hash', hash: txHash });

    // 刚广播的交易可能尚未上链：有界轮询。Core 在查不到时抛
    // DFR_TRANSACTION_NOT_FOUND（"链上未找到"）——这是**暂时的**，不是失败，继续轮询。
    let confirmation: Awaited<ReturnType<typeof core.observeConfirmation>> | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        confirmation = await core.observeConfirmation(DEVNET, txHash, 'confirmed' as never, ctx);
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== 'DFR_TRANSACTION_NOT_FOUND') throw err;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    expect(confirmation).toBeDefined();
    expect(['included', 'confirmed', 'finalized']).toContain(confirmation!.finality);
    // 只记录非敏感证据。
    console.log(`D02 evidence: txHash=${txHash} finality=${confirmation!.finality} status=${confirmation!.status}`);
  }, 120_000);
});
