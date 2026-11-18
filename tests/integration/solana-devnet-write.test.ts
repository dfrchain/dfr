/**
 * D02: Solana devnet real write-to-chain (build → external signing → single broadcast → confirm → finalize).
 *
 * Skipped by default. Enable explicitly (requires a **funded** devnet account):
 *
 *   DFR_RUN_SOLANA_WRITE=1 \
 *   DFR_SOLANA_KEYPAIR=/path/to/id.json \
 *   DFR_PROVIDER_SOLANA_DEVNET_PRIMARY_URL=https://api.devnet.solana.com \
 *   pnpm vitest run tests/integration/solana-devnet-write.test.ts
 *
 * Signing is done **externally** (this test uses a local test account to play the external signer, see support/solana-signer).
 * The server never touches private keys (ADR-007/009). Only non-sensitive evidence is recorded (txHash / slot / finality).
 *
 * If the account has no funds: the broadcast fails for insufficient fees, and this test gives a clear skip message (no fabricated success).
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

/** Fill a real signature into the unsigned payload (with zero signature slots) using an external keypair. */
function signUnsigned(payloadBase64: string, sign: (m: Uint8Array) => Uint8Array): string {
  const bytes = fromBase64(payloadBase64, 'payload');
  const { signatures, messageBytes } = splitSignatures(bytes);
  const sig = sign(messageBytes);
  // Single-signature transaction: replace the first (and only) slot with the real signature.
  const out = Buffer.alloc(1 + signatures.length * 64 + messageBytes.length);
  out[0] = signatures.length;
  signatures.forEach((slot, index) => {
    const value = index === 0 ? sig : slot;
    Buffer.from(value).copy(out, 1 + index * 64);
  });
  Buffer.from(messageBytes).copy(out, 1 + signatures.length * 64);
  return out.toString('base64');
}

describe.skipIf(!ENABLED)('Solana devnet real write-to-chain (M3-D02)', () => {
  it('build → external signing → single broadcast → confirm (real devnet)', async () => {
    const core = makeCore();
    const keypair = loadSolanaKeypair(process.env['DFR_SOLANA_KEYPAIR']!);
    const from = base58Encode(keypair.publicKeyBytes);

    const unsigned = await core.buildTransaction(
      DEVNET,
      {
        chain: DEVNET,
        from: { chain: DEVNET, address: from },
        to: { chain: DEVNET, address: from }, // self-transfer 0 SOL: only verifies the chain, moves no funds
        value: { asset: { kind: 'native', chain: DEVNET }, amount: '0' },
      } as never,
      ctx,
    );
    expect(unsigned.meta.recentBlockhash).toBeTruthy();

    const signedPayload = signUnsigned(unsigned.payload, keypair.sign);
    const txHash = base58Encode(splitSignatures(fromBase64(signedPayload, 'payload')).signatures[0]!);

    // Note: if the account has no funds, the node rejects with -32002 "Attempt to debit an account but found no
    // record of a prior credit" -- this is a real failure, **not** swallowed, no fabricated success.
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

    // A just-broadcast transaction may not be on-chain yet: bounded polling. When Core cannot find it, it throws
    // DFR_TRANSACTION_NOT_FOUND ("not found on-chain") -- this is **temporary**, not a failure; keep polling.
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
    // Only record non-sensitive evidence.
    console.log(`D02 evidence: txHash=${txHash} finality=${confirmation!.finality} status=${confirmation!.status}`);
  }, 120_000);
});
