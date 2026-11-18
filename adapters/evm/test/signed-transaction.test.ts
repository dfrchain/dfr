/**
 * EVM signed-payload parsing and binding (DFR-M1-C01).
 *
 * Authoritative sources: ADR-016 §7, docs/architecture/m1-api-contract.md Section 3
 * ("before broadcast, the Adapter must recompute or re-parse chain ID / from / nonce /
 * to / value-data / txHash from signedPayload and match them against the saved unsigned transaction; the client-provided
 * expectedHash is only for comparison and cannot serve as ground truth").
 *
 * This file uses **real signatures** (viem pure functions + test private keys derived at runtime) instead of hand-written vectors:
 * from must be recovered via secp256k1; hand-written vectors cannot prove the recovery logic correct.
 * Private keys are derived from strings at runtime, so no private-key literals exist in the repo.
 */
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAddress, signTransaction } from 'viem/accounts';
import type { ChainId, DecimalUint } from '@dfr/types';
import {
  bindSignedTransaction,
  EvmCodecError,
  parseSignedTransaction,
  type EvmCodecErrorReason,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CHAIN = 'ethereum-sepolia' as ChainId;
const CHAIN_ID = '11155111' as DecimalUint;
const TO = '0x2222222222222222222222222222222222222222' as const;

/** Derived at runtime: no 64-hex-digit private-key literals appear in the repo (required by the check-secrets red line). */
const TEST_KEY = keccak256(toBytes('dfr-m1-c01-signer'));
const TEST_FROM = privateKeyToAddress(TEST_KEY);
const OTHER_KEY = keccak256(toBytes('dfr-m1-c01-other-signer'));
const OTHER_FROM = privateKeyToAddress(OTHER_KEY);

interface TestTx {
  chainId: number;
  nonce: number;
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  type: 'eip1559';
  accessList?: { address: `0x${string}`; storageKeys: `0x${string}`[] }[];
}

const TX: TestTx = {
  chainId: 11155111,
  nonce: 7,
  to: TO,
  value: 1000n,
  data: '0x',
  gas: 21000n,
  maxFeePerGas: 3000000000n,
  maxPriorityFeePerGas: 1000000000n,
  type: 'eip1559',
};

async function sign(
  overrides: Partial<TestTx> = {},
  privateKey: `0x${string}` = TEST_KEY,
): Promise<string> {
  return signTransaction({ privateKey, transaction: { ...TX, ...overrides } });
}

/** Expect an EvmCodecError with a stable reason. */
async function expectBindingError(
  promise: Promise<unknown>,
  reason: EvmCodecErrorReason,
): Promise<EvmCodecError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error, `expected EvmCodecError(${reason}), got ${String(error)}`).toBeInstanceOf(
    EvmCodecError,
  );
  const typed = error as EvmCodecError;
  expect(typed.reason).toBe(reason);
  return typed;
}

describe('parseSignedTransaction (DFR-M1-C01)', () => {
  it('recovers from / nonce / to / value / data / txHash from a really signed payload', async () => {
    const payload = await sign();
    const parsed = await parseSignedTransaction(CHAIN, payload);

    expect(parsed.from).toEqual({ chain: CHAIN, address: TEST_FROM.toLowerCase() });
    expect(parsed.nonce).toBe('7');
    expect(parsed.to).toEqual({ chain: CHAIN, address: TO });
    expect(parsed.value).toBe('1000');
    expect(parsed.data).toBe('0x');
    expect(parsed.type).toBe('eip1559');
    expect(parsed.chainId).toBe(CHAIN_ID);
    // txHash must be recomputed from the payload, not provided by the caller.
    expect(parsed.txHash).toBe(keccak256(payload as `0x${string}`));
  });

  it('return value contains no raw signature, so it is not casually written into logs or databases', async () => {
    const payload = await sign();
    const parsed = await parseSignedTransaction(CHAIN, payload);

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(payload);
    for (const key of Object.keys(parsed)) {
      expect(key.toLowerCase()).not.toContain('payload');
      expect(key.toLowerCase()).not.toContain('signed');
    }
  });

  it('unsigned payload → not_signed (an unsigned payload cannot be used as broadcast input)', async () => {
    await expectBindingError(
      parseSignedTransaction(CHAIN, await signUnsignedRaw()),
      'not_signed',
    );
  });

  it('pre-EIP-155 legacy signature cannot determine chainId → chain_id_unknown', async () => {
    const legacy = await signTransaction({
      privateKey: TEST_KEY,
      transaction: { nonce: 0, gasPrice: 1000000000n, gas: 21000n, to: TO, value: 1n, data: '0x' },
    });
    await expectBindingError(parseSignedTransaction(CHAIN, legacy), 'chain_id_unknown');
  });
});

describe('bindSignedTransaction (DFR-M1-C01)', () => {
  it('signature matches the saved unsigned payload item by item → pass', async () => {
    const payload = await sign();
    const unsigned = await bindSignedTransaction(payload, {
      chain: CHAIN,
      expectedChainId: CHAIN_ID,
      from: { chain: CHAIN, address: TEST_FROM },
      unsignedPayload: await signUnsignedRaw(),
      expectedHash: keccak256(payload as `0x${string}`),
    });

    expect(unsigned.nonce).toBe('7');
    expect(unsigned.txHash).toBe(keccak256(payload as `0x${string}`));
  });

  it('from differs from the record → sender_mismatch (sign the same transaction with a different key)', async () => {
    const payload = await sign({}, OTHER_KEY);
    await expectBindingError(
      bindSignedTransaction(payload, {
        chain: CHAIN,
        expectedChainId: CHAIN_ID,
        from: { chain: CHAIN, address: TEST_FROM },
        unsignedPayload: await signUnsignedRaw(),
      }),
      'sender_mismatch',
    );
  });

  it('chainId differs from the record → chain_id_mismatch', async () => {
    const payload = await sign({ chainId: 84532 });
    await expectBindingError(
      bindSignedTransaction(payload, {
        chain: CHAIN,
        expectedChainId: CHAIN_ID,
        from: { chain: CHAIN, address: TEST_FROM },
        unsignedPayload: await signUnsignedRaw(),
      }),
      'chain_id_mismatch',
    );
  });

  const cases: readonly (readonly [string, Partial<TestTx>])[] = [
    ['nonce', { nonce: 8 }],
    ['to', { to: '0x3333333333333333333333333333333333333333' }],
    ['value', { value: 2000n }],
    ['data', { data: '0xdeadbeef' }],
    ['gas', { gas: 50000n }],
    ['maxFeePerGas', { maxFeePerGas: 4000000000n }],
    [
      'accessList',
      {
        accessList: [
          {
            address: '0x4444444444444444444444444444444444444444' as const,
            storageKeys: [`0x${'11'.repeat(32)}` as `0x${string}`],
          },
        ],
      },
    ],
  ];

  it.each(cases)('signed %s differs from the saved payload → unsigned_payload_mismatch', async (field, override) => {
    const payload = await sign(override);
    const error = await expectBindingError(
      bindSignedTransaction(payload, {
        chain: CHAIN,
        expectedChainId: CHAIN_ID,
        from: { chain: CHAIN, address: TEST_FROM },
        unsignedPayload: await signUnsignedRaw(),
      }),
      'unsigned_payload_mismatch',
    );
    expect(error.field).toBe(field);
  });

  it('a payload signed by another key must not be mistaken for the sender in the record (OTHER_FROM counter-proof)', async () => {
    const payload = await sign({}, OTHER_KEY);
    const parsed = await parseSignedTransaction(CHAIN, payload);
    expect(parsed.from.address).toBe(OTHER_FROM.toLowerCase());
    expect(parsed.from.address).not.toBe(TEST_FROM.toLowerCase());
  });

  it('client expectedHash differs from the recomputed result → expected_hash_mismatch', async () => {
    const payload = await sign();
    await expectBindingError(
      bindSignedTransaction(payload, {
        chain: CHAIN,
        expectedChainId: CHAIN_ID,
        from: { chain: CHAIN, address: TEST_FROM },
        unsignedPayload: await signUnsignedRaw(),
        expectedHash: `0x${'ab'.repeat(32)}`,
      }),
      'expected_hash_mismatch',
    );
  });

  it('failure messages contain no raw signature (redacted)', async () => {
    const payload = await sign({ value: 999n });
    const error = await expectBindingError(
      bindSignedTransaction(payload, {
        chain: CHAIN,
        expectedChainId: CHAIN_ID,
        from: { chain: CHAIN, address: TEST_FROM },
        unsignedPayload: await signUnsignedRaw(),
      }),
      'unsigned_payload_mismatch',
    );

    const fragment = payload.slice(4, 40);
    expect(error.message).not.toContain(fragment);
    expect(JSON.stringify(error)).not.toContain(fragment);
    expect(String(error)).not.toContain(fragment);
  });
});

describe('Redaction (error-spec Chapter 6)', () => {
  it('unparsable payloads do not echo the raw signature either', async () => {
    const payload = await sign();
    // Truncate the tail: RLP parsing must fail, taking the invalid_payload branch.
    const malformed = payload.slice(0, payload.length - 6);
    const error = await parseSignedTransaction(CHAIN, malformed).then(
      () => undefined,
      (err: unknown) => err as EvmCodecError,
    );

    expect(error).toBeInstanceOf(EvmCodecError);
    const fragment = payload.slice(4, 40);
    expect(error!.message).not.toContain(fragment);
    expect(String(error)).not.toContain(fragment);
    expect(JSON.stringify({ ...error })).not.toContain(fragment);
  });
});

describe('Input boundaries (fail-closed)', () => {
  it('invalid sender in the record → invalid_expectation (no DFR_* error thrown)', async () => {
    const payload = await sign();
    await expectBindingError(
      bindSignedTransaction(payload, {
        chain: CHAIN,
        expectedChainId: CHAIN_ID,
        from: { chain: CHAIN, address: '0xnot-an-address' },
        unsignedPayload: await signUnsignedRaw(),
      }),
      'invalid_expectation',
    );
  });

  it('recorded unsigned payload is actually signed → invalid_expectation', async () => {
    const payload = await sign();
    await expectBindingError(
      bindSignedTransaction(payload, {
        chain: CHAIN,
        expectedChainId: CHAIN_ID,
        from: { chain: CHAIN, address: TEST_FROM },
        unsignedPayload: payload,
      }),
      'invalid_expectation',
    );
  });
});

describe('Source guard (ADR-016 §1)', () => {
  it('signed-transaction.ts only imports allowed modules, with no client / wallet / signing capability', () => {
    const source = readFileSync(resolve(here, '..', 'src', 'signed-transaction.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    const allowed = new Set(['viem', '@dfr/types', './address.js', './transaction-codec.js']);
    for (const specifier of specifiers) {
      expect(allowed.has(specifier as string), `import not allowed: ${specifier}`).toBe(true);
    }
    for (const banned of [
      'createPublicClient',
      'createWalletClient',
      'privateKeyToAccount',
      'mnemonicToAccount',
      'http(',
      'webSocket(',
      'fallback(',
      'signTransaction',
      'sendRawTransaction',
    ]) {
      expect(source.includes(banned), `must not appear: ${banned}`).toBe(false);
    }
  });
});

/** A payload identical to the signed payload in every field but **unsigned**: the binding comparison takes its ground truth from it. */
async function signUnsignedRaw(): Promise<string> {
  const { serializeTransaction } = await import('viem');
  return serializeTransaction({
    chainId: 11155111,
    nonce: 7,
    to: TO,
    value: 1000n,
    data: '0x',
    gas: 21000n,
    maxFeePerGas: 3000000000n,
    maxPriorityFeePerGas: 1000000000n,
    type: 'eip1559',
  });
}
