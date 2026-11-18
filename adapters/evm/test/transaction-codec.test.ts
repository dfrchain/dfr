/**
 * EVM transaction codec pure-function contract tests (DFR-M1-B01).
 *
 * Authoritative sources: ADR-016 (Viem pure utilities), docs/architecture/m1-api-contract.md.
 *
 * Three kinds of evidence in these tests:
 *   1. **Public spec vectors**: EIP-155 examples must match byte for byte (independently verifiable externally);
 *   2. **Independent structural reconstruction**: expected bytes for EIP-2930 / EIP-1559 are rebuilt with `toRlp` from the raw fields
 *      in order, instead of reusing `serializeTransaction`, to avoid "implementation and assertion sharing the same origin";
 *   3. **Negative controls**: JS numbers, hex strings, leading zeros, invalid addresses/data, missing fee fields
 *      or extra ones, and tampered fields must all be rejected.
 *
 * Two more security assertions: the codec makes no network requests, and its source may only import Viem pure utilities
 * (no client / transport / account / wallet).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, toRlp } from 'viem';
import type { DecimalUint } from '@dfr/types';
import {
  assertDecodedMatchesIntent,
  decodeTransactionPayload,
  encodeUnsignedTransaction,
  EvmCodecError,
  type EvmUnsignedIntent,
} from '../src/transaction-codec.js';

const here = dirname(fileURLToPath(import.meta.url));
const codecSource = readFileSync(resolve(here, '..', 'src', 'transaction-codec.ts'), 'utf8');

const dec = (value: string): DecimalUint => value as DecimalUint;

const TO = '0x2222222222222222222222222222222222222222';
const DATA = '0xdeadbeef';

/* ------------------------------------------------------------------ */
/* 1. Public spec vectors: EIP-155                                           */
/* ------------------------------------------------------------------ */

/** EIP-155 spec example (chainId 1, nonce 9, gasPrice 20 gwei, 21000 gas, 1 ETH). */
const EIP155_INTENT: EvmUnsignedIntent = {
  type: 'legacy',
  chainId: dec('1'),
  nonce: dec('9'),
  to: '0x3535353535353535353535353535353535353535',
  value: dec('1000000000000000000'),
  gas: dec('21000'),
  gasPrice: dec('20000000000'),
};

const EIP155_UNSIGNED =
  '0xec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080';
const EIP155_UNSIGNED_HASH =
  '0xdaf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53'; // secret-scan:allow EIP-155 public vector
const EIP155_SIGNED =
  '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83';

describe('EIP-155 legacy public spec vectors (ADR-016 acceptance 1)', () => {
  it('pre-EIP-155 zero signature slots must not treat v=27 as chainId', () => {
    const payload = toRlp(['0x', '0x01', '0x5208', TO, '0x', '0x', '0x1b', '0x', '0x']);
    const decoded = decodeTransactionPayload(payload);
    expect(decoded.signed).toBe(false);
    expect(decoded.chainId).toBeNull();
  });
  it('encode matches the EIP-155 spec example byte for byte, signingHash equals the spec hash', () => {
    const encoded = encodeUnsignedTransaction(EIP155_INTENT);
    expect(encoded.payload).toBe(EIP155_UNSIGNED);
    expect(encoded.type).toBe('legacy');
    expect(encoded.encoding).toBe('hex');
    expect(encoded.chainId).toBe('1');
    expect(encoded.nonce).toBe('9');
    expect(encoded.signingHash).toBe(EIP155_UNSIGNED_HASH);
    expect(encoded.signingHash).toBe(keccak256(EIP155_UNSIGNED));
  });

  it('decode of an unsigned payload returns the spec fields with signed=false', () => {
    const decoded = decodeTransactionPayload(EIP155_UNSIGNED);
    expect(decoded.type).toBe('legacy');
    expect(decoded.chainId).toBe('1');
    expect(decoded.nonce).toBe('9');
    expect(decoded.to).toBe('0x3535353535353535353535353535353535353535');
    expect(decoded.value).toBe('1000000000000000000');
    expect(decoded.gas).toBe('21000');
    expect(decoded.gasPrice).toBe('20000000000');
    expect(decoded.data).toBe('0x');
    expect(decoded.signed).toBe(false);
    expect(decoded.hash).toBe(EIP155_UNSIGNED_HASH);
  });

  it('decode of a signed payload returns signed=true with fields matching the unsigned original', () => {
    const decoded = decodeTransactionPayload(EIP155_SIGNED);
    expect(decoded.signed).toBe(true);
    expect(decoded.type).toBe('legacy');
    expect(decoded.chainId).toBe('1');
    expect(decoded.nonce).toBe('9');
    expect(decoded.to).toBe('0x3535353535353535353535353535353535353535');
    expect(decoded.value).toBe('1000000000000000000');
    expect(decoded.hash).toBe(keccak256(EIP155_SIGNED));
  });
});

/* ------------------------------------------------------------------ */
/* 2. EIP-2930 / EIP-1559: independent structural reconstruction                                */
/* ------------------------------------------------------------------ */

const SEPOLIA_CHAIN_ID = dec('11155111');
const BASE = {
  chainId: SEPOLIA_CHAIN_ID,
  nonce: dec('42'),
  to: TO,
  value: dec('10000000000000000'),
  gas: dec('21000'),
} as const;

describe('EIP-2930 and EIP-1559 encoding (independent toRlp reconstruction)', () => {
  it('typed transactions with all-zero or partly-zero signature slots do not count as signed', () => {
    const prefix = ['0xaa36a7', '0x01', '0x01', '0x02', '0x5208', TO, '0x', '0x', []] as const;
    for (const type of ['0x01', '0x02'] as const) {
      const body = type === '0x01' ? prefix.slice(0, 8) : prefix;
      const accessList = type === '0x01' ? [body[0], body[1], body[2], body[4], body[5], body[6], body[7], []] : body;
      for (const [r, s] of [['0x', '0x'], ['0x01', '0x'], ['0x', '0x01']] as const) {
        const decoded = decodeTransactionPayload(`${type}${toRlp([...accessList, '0x', r, s]).slice(2)}`);
        expect(decoded.signed).toBe(false);
      }
    }
  });
  it('EIP-2930 bytes with an empty accessList match the structural reconstruction', () => {
    const expected =
      '0x01ec83aa36a72a843b9aca00825208942222222222222222222222222222222222222222872386f26fc1000080c0';
    const rebuilt =
      '0x01' +
      toRlp(['0xaa36a7', '0x2a', '0x3b9aca00', '0x5208', TO, '0x2386f26fc10000', '0x', []]).slice(2);
    expect(rebuilt).toBe(expected);

    const encoded = encodeUnsignedTransaction({
      ...BASE,
      type: 'eip2930',
      gasPrice: dec('1000000000'),
    });
    expect(encoded.payload).toBe(expected);
    expect(encoded.signingHash).toBe(keccak256(expected));
  });

  it('EIP-1559 bytes with an empty accessList match the structural reconstruction', () => {
    const expected =
      '0x02f183aa36a72a843b9aca008477359400825208942222222222222222222222222222222222222222872386f26fc1000080c0';
    const rebuilt =
      '0x02' +
      toRlp([
        '0xaa36a7',
        '0x2a',
        '0x3b9aca00',
        '0x77359400',
        '0x5208',
        TO,
        '0x2386f26fc10000',
        '0x',
        [],
      ]).slice(2);
    expect(rebuilt).toBe(expected);

    const encoded = encodeUnsignedTransaction({
      ...BASE,
      type: 'eip1559',
      maxPriorityFeePerGas: dec('1000000000'),
      maxFeePerGas: dec('2000000000'),
    });
    expect(encoded.payload).toBe(expected);
    expect(encoded.signingHash).toBe(keccak256(expected));
  });

  it('EIP-2930 with accessList and data round-trips fully after serialization (round-trip)', () => {
    const encoded = encodeUnsignedTransaction({
      ...BASE,
      type: 'eip2930',
      gasPrice: dec('5000000000'),
      data: DATA,
      accessList: [
        { address: '0x1111111111111111111111111111111111111111', storageKeys: [`0x${'ab'.repeat(32)}`] },
      ],
    });
    const decoded = decodeTransactionPayload(encoded.payload);
    expect(decoded.type).toBe('eip2930');
    expect(decoded.chainId).toBe('11155111');
    expect(decoded.nonce).toBe('42');
    expect(decoded.to).toBe(TO);
    expect(decoded.value).toBe('10000000000000000');
    expect(decoded.gas).toBe('21000');
    expect(decoded.gasPrice).toBe('5000000000');
    expect(decoded.data).toBe(DATA);
    expect(decoded.accessList).toEqual([
      { address: '0x1111111111111111111111111111111111111111', storageKeys: [`0x${'ab'.repeat(32)}`] },
    ]);
    expect(decoded.signed).toBe(false);
  });

  it('all three types pass encode → decode → comparison with the intent', () => {
    const intents: EvmUnsignedIntent[] = [
      EIP155_INTENT,
      { ...BASE, type: 'eip2930', gasPrice: dec('1000000000') },
      { ...BASE, type: 'eip1559', maxPriorityFeePerGas: dec('1000000000'), maxFeePerGas: dec('2000000000') },
    ];
    for (const intent of intents) {
      const encoded = encodeUnsignedTransaction(intent);
      const decoded = decodeTransactionPayload(encoded.payload);
      expect(decoded.type).toBe(encoded.type);
      expect(() => assertDecodedMatchesIntent(decoded, intent)).not.toThrow();
    }
  });

  it('missing type defaults to eip1559, missing data defaults to 0x', () => {
    const withDefaults = encodeUnsignedTransaction({
      ...BASE,
      maxPriorityFeePerGas: dec('1000000000'),
      maxFeePerGas: dec('2000000000'),
    });
    expect(withDefaults.type).toBe('eip1559');
    const explicit = encodeUnsignedTransaction({
      ...BASE,
      type: 'eip1559',
      maxPriorityFeePerGas: dec('1000000000'),
      maxFeePerGas: dec('2000000000'),
      data: '0x',
    });
    expect(withDefaults.payload).toBe(explicit.payload);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Negative controls: value and field validation                                            */
/* ------------------------------------------------------------------ */

function expectCodecError(fn: () => unknown, reason: string): void {
  try {
    fn();
    throw new Error('expected EvmCodecError to be thrown, but the call succeeded');
  } catch (err) {
    expect(err, `expected EvmCodecError(${reason}), got ${String(err)}`).toBeInstanceOf(EvmCodecError);
    expect((err as EvmCodecError).reason).toBe(reason);
  }
}

describe('SEC-CODEC: RLP deserialization must reject invalid on-chain transaction fields', () => {
  const typed = (fields: readonly unknown[]) => (
    `0x01${toRlp(fields as Parameters<typeof toRlp>[0]).slice(2)}`
  );
  const base = ['0x01', '0x', '0x01', '0x5208', TO, '0x', '0x', []] as const;

  it('rejects a nonce with 0x00 or leading zeros instead of treating it as another equivalent transaction intent', () => {
    for (const nonce of ['0x00', '0x0001']) {
      const malformed = typed([...base.slice(0, 1), nonce, ...base.slice(2)]);
      expectCodecError(() => decodeTransactionPayload(malformed), 'invalid_payload');
    }
  });

  it('rejects malformed recipient addresses, accessList addresses, storage keys, and extra tuple fields', () => {
    const invalid = [
      typed([base[0], base[1], base[2], base[3], '0x1234', base[5], base[6], []]),
      typed([base[0], base[1], base[2], base[3], TO, base[5], base[6], [['0x1234', []]]]),
      typed([base[0], base[1], base[2], base[3], TO, base[5], base[6], [[TO, ['0x01']]]]),
      typed([base[0], base[1], base[2], base[3], TO, base[5], base[6], [[TO, [], '0x1234']]]),
    ];
    for (const payload of invalid) {
      expectCodecError(() => decodeTransactionPayload(payload), 'invalid_payload');
    }
  });
});

describe('Value boundaries: always decimal strings, no JS number (ADR-016 acceptance 2)', () => {
  it('rejects JS number (even when the value looks valid)', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({ ...BASE, nonce: 42 as unknown as DecimalUint, type: 'eip1559', maxFeePerGas: dec('1'), maxPriorityFeePerGas: dec('1') }),
      'number_not_allowed',
    );
    expectCodecError(
      () => encodeUnsignedTransaction({ ...EIP155_INTENT, value: 1 as unknown as DecimalUint }),
      'number_not_allowed',
    );
  });

  it('rejects hex strings, negatives, empty strings, fractions, and scientific notation', () => {
    for (const bad of ['0x2a', '-1', '', '4.2', '1e3', ' 42 ', 'abc']) {
      expectCodecError(
        () => encodeUnsignedTransaction({ ...EIP155_INTENT, nonce: bad as DecimalUint }),
        'invalid_decimal',
      );
    }
  });

  it('rejects leading zeros (canonical decimal form required)', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({ ...EIP155_INTENT, nonce: '09' as DecimalUint }),
      'invalid_decimal',
    );
    // '0' itself is valid.
    expect(encodeUnsignedTransaction({ ...EIP155_INTENT, nonce: dec('0') }).nonce).toBe('0');
  });

  it('rejects a non-EVM-address to', () => {
    for (const bad of ['0x1234', '2222222222222222222222222222222222222222', '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz']) {
      expectCodecError(() => encodeUnsignedTransaction({ ...EIP155_INTENT, to: bad }), 'invalid_address');
    }
  });

  it('rejects invalid data (non-0x prefix or odd length)', () => {
    for (const bad of ['deadbeef', '0xabc', '0xzz']) {
      expectCodecError(() => encodeUnsignedTransaction({ ...EIP155_INTENT, data: bad }), 'invalid_hex_data');
    }
  });

  it('rejects unknown transaction types', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({ ...EIP155_INTENT, type: 'eip4844' as never }),
      'unsupported_transaction_type',
    );
  });

  it('fee fields must match the transaction type: missing ones rejected', () => {
    expectCodecError(() => encodeUnsignedTransaction({ ...BASE, type: 'legacy' }), 'missing_fee_field');
    expectCodecError(() => encodeUnsignedTransaction({ ...BASE, type: 'eip2930' }), 'missing_fee_field');
    expectCodecError(
      () => encodeUnsignedTransaction({ ...BASE, type: 'eip1559', maxFeePerGas: dec('1') }),
      'missing_fee_field',
    );
  });

  it('fee fields must match the transaction type: extra ones rejected', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({ ...EIP155_INTENT, maxFeePerGas: dec('1') }),
      'unexpected_fee_field',
    );
    expectCodecError(
      () => encodeUnsignedTransaction({
        ...BASE,
        type: 'eip1559',
        maxFeePerGas: dec('1'),
        maxPriorityFeePerGas: dec('1'),
        gasPrice: dec('1'),
      }),
      'unexpected_fee_field',
    );
  });

  it('rejects conflicting input with maxPriorityFeePerGas > maxFeePerGas', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({
        ...BASE,
        type: 'eip1559',
        maxPriorityFeePerGas: dec('3'),
        maxFeePerGas: dec('2'),
      }),
      'invalid_fee_bounds',
    );
  });

  it('rejects invalid accessList entries', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({
        ...BASE,
        type: 'eip1559',
        maxFeePerGas: dec('1'),
        maxPriorityFeePerGas: dec('1'),
        accessList: [{ address: '0x1234', storageKeys: [] }],
      }),
      'invalid_access_list',
    );
    expectCodecError(
      () => encodeUnsignedTransaction({
        ...BASE,
        type: 'eip1559',
        maxFeePerGas: dec('1'),
        maxPriorityFeePerGas: dec('1'),
        accessList: [{ address: TO, storageKeys: ['0xabc'] }],
      }),
      'invalid_access_list',
    );
  });

  it('rejects invalid payloads (non-hex / truncated / unknown type prefix)', () => {
    expectCodecError(() => decodeTransactionPayload('deadbeef'), 'invalid_payload');
    expectCodecError(() => decodeTransactionPayload('0x02f1'), 'invalid_payload');
    expectCodecError(() => decodeTransactionPayload('0x05c0'), 'unsupported_transaction_type');
    expectCodecError(() => decodeTransactionPayload('0x'), 'invalid_payload');
  });
});

/* ------------------------------------------------------------------ */
/* 4. Negative controls: tampered fields must be rejected by the intent comparison (ADR-016 acceptance 3)          */
/* ------------------------------------------------------------------ */

describe('assertDecodedMatchesIntent rejects tampered fields', () => {
  const intent: EvmUnsignedIntent = {
    type: 'eip1559',
    chainId: SEPOLIA_CHAIN_ID,
    nonce: dec('42'),
    to: TO,
    value: dec('10000000000000000'),
    gas: dec('21000'),
    maxPriorityFeePerGas: dec('1000000000'),
    maxFeePerGas: dec('2000000000'),
  };

  it('passes when untampered', () => {
    const decoded = decodeTransactionPayload(encodeUnsignedTransaction(intent).payload);
    expect(() => assertDecodedMatchesIntent(decoded, intent)).not.toThrow();
  });

  it('tampering with chainId / nonce / to / value / gas / data / fee one by one is rejected', () => {
    const decoded = decodeTransactionPayload(encodeUnsignedTransaction(intent).payload);
    const tampered: Array<Partial<typeof decoded>> = [
      { chainId: dec('1') },
      { nonce: dec('43') },
      { to: '0x1111111111111111111111111111111111111111' },
      { value: dec('1') },
      { gas: dec('21001') },
      { data: DATA },
      { maxFeePerGas: dec('3') },
      { maxPriorityFeePerGas: dec('2') },
      { type: 'legacy' },
    ];
    for (const patch of tampered) {
      expectCodecError(() => assertDecodedMatchesIntent({ ...decoded, ...patch }, intent), 'intent_mismatch');
    }
  });

  it('a tampered signed payload fails comparison with the original intent (simulating the signature-binding check)', () => {
    const decoded = decodeTransactionPayload(EIP155_SIGNED);
    expect(() => assertDecodedMatchesIntent(decoded, EIP155_INTENT)).not.toThrow();
    expectCodecError(
      () => assertDecodedMatchesIntent(decoded, { ...EIP155_INTENT, value: dec('2') }),
      'intent_mismatch',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. Security: no network requests, no wallet clients created                                  */
/* ------------------------------------------------------------------ */

describe('codec security boundary (ADR-016 acceptance 4)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetch is not called during encode/decode', () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error('codec must not make network requests');
    }) as unknown as typeof fetch;

    const encoded = encodeUnsignedTransaction(EIP155_INTENT);
    decodeTransactionPayload(encoded.payload);
    decodeTransactionPayload(EIP155_SIGNED);
    expect(calls).toBe(0);
  });

  it('source only imports Viem pure utilities and DFR types, with no client / transport / account / wallet', () => {
    const specifiers = [...codecSource.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    const allowed = new Set(['viem', '@dfr/types', '@dfr/errors', './address.js', './hex.js']);
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
      'custom(',
      'signTransaction',
      'sendRawTransaction',
    ]) {
      expect(codecSource.includes(banned), `codec must not contain ${banned}`).toBe(false);
    }
  });
});
