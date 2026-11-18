/**
 * External-signer test helper (prerequisite for DFR-M1-E03).
 *
 * Why it lives under the adapter's test/: `viem` may only exist in `adapters/evm` (ADR-016 §2,
 * guarded by tests/contract/module-boundaries.test.ts ("only adapters/evm may depend on viem").
 * E2E needs "the caller's own signer" to build real signatures, but viem must not be added to the `tests` package for that.
 * So the signing helper stays in the package that already declares viem, referenced by E2E via a relative path.
 *
 * This file is only referenced by tests and is not part of the production export surface (`src/index.ts` does not export it).
 */
import { keccak256, toBytes } from 'viem';
import { privateKeyToAddress, signTransaction } from 'viem/accounts';
import { decodeTransactionPayload } from '../../src/transaction-codec.js';

/** Derive the test private key from a label at runtime: no private-key literals appear in the repo. */
export function deriveTestPrivateKey(label: string): `0x${string}` {
  return keccak256(toBytes(label));
}

export function addressOf(privateKey: `0x${string}`): string {
  return privateKeyToAddress(privateKey);
}

/** `keccak256(signed payload)` = the transaction hash a real endpoint returns. */
export function transactionHashOf(signedPayload: string): string {
  return keccak256(signedPayload as `0x${string}`);
}

export interface ExternalSignature {
  readonly signedPayload: `0x${string}`;
  readonly expectedHash: string;
}

/**
 * Simulate "the caller's own signer": decode the unsigned EIP-1559 payload produced by build back into fields,
 * and re-sign with the given private key.
 *
 * `overrides` builds **binding-mismatch** negative controls: the signature itself is valid, but the fields do not match the DFR record,
 * so the Adapter's `bindSignedTransaction` must reject it without broadcasting.
 */
export async function signUnsignedPayload(input: {
  readonly unsignedPayload: string;
  readonly privateKey: `0x${string}`;
  readonly chainId: number;
  readonly overrides?: { readonly nonce?: bigint; readonly to?: string; readonly value?: bigint };
}): Promise<ExternalSignature> {
  const decoded = decodeTransactionPayload(input.unsignedPayload);
  if (decoded.signed) {
    throw new Error('signUnsignedPayload: expected an unsigned payload, but the input is already signed');
  }
  if (decoded.to === null) {
    throw new Error('signUnsignedPayload: contract creation is not supported in tests (empty to)');
  }
  const nonce = input.overrides?.nonce ?? BigInt(decoded.nonce);
  // Viem currently types the signing input nonce as number; the test nonce is far below 2^53,
  // but it is still checked explicitly so "silent precision loss" never leaks into the test helper.
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('signUnsignedPayload: nonce exceeds the safe-integer range');
  }
  const signedPayload = await signTransaction({
    privateKey: input.privateKey,
    transaction: {
      chainId: input.chainId,
      nonce: Number(nonce),
      to: (input.overrides?.to ?? decoded.to) as `0x${string}`,
      value: input.overrides?.value ?? BigInt(decoded.value),
      data: decoded.data as `0x${string}`,
      gas: BigInt(decoded.gas),
      maxFeePerGas: BigInt(decoded.maxFeePerGas ?? '0'),
      maxPriorityFeePerGas: BigInt(decoded.maxPriorityFeePerGas ?? '0'),
      type: 'eip1559',
    },
  });
  return { signedPayload, expectedHash: keccak256(signedPayload as `0x${string}`) };
}
