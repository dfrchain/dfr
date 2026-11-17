/**
 * EVM 交易编解码纯函数契约测试（DFR-M1-B01）。
 *
 * 权威来源：ADR-016（Viem 纯工具函数）、docs/architecture/m1-api-contract.md。
 *
 * 本测试的三类证据：
 *   1. **公开规范向量**：EIP-155 示例必须逐字节一致（外部可独立复核）；
 *   2. **独立结构重建**：EIP-2930 / EIP-1559 的期望字节用 `toRlp` 从字段原始
 *      顺序重建，而不是复用 `serializeTransaction`，避免"实现与断言同源"；
 *   3. **负对照**：JS number、十六进制字符串、前导零、非法地址/数据、费用字段缺失
 *      或多余、篡改字段都必须被拒绝。
 *
 * 另有两项安全断言：codec 不发网络请求，且源码只允许导入 Viem 的纯工具函数
 * （不得出现 client / transport / account / wallet）。
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
/* 1. 公开规范向量：EIP-155                                           */
/* ------------------------------------------------------------------ */

/** EIP-155 规范示例（chainId 1，nonce 9，gasPrice 20 gwei，21000 gas，1 ETH）。 */
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

describe('EIP-155 legacy 公开规范向量（ADR-016 验收 1）', () => {
  it('pre-EIP-155 的零签名槽不能把 v=27 当作 chainId', () => {
    const payload = toRlp(['0x', '0x01', '0x5208', TO, '0x', '0x', '0x1b', '0x', '0x']);
    const decoded = decodeTransactionPayload(payload);
    expect(decoded.signed).toBe(false);
    expect(decoded.chainId).toBeNull();
  });
  it('encode 逐字节等于 EIP-155 规范示例，signingHash 等于规范哈希', () => {
    const encoded = encodeUnsignedTransaction(EIP155_INTENT);
    expect(encoded.payload).toBe(EIP155_UNSIGNED);
    expect(encoded.type).toBe('legacy');
    expect(encoded.encoding).toBe('hex');
    expect(encoded.chainId).toBe('1');
    expect(encoded.nonce).toBe('9');
    expect(encoded.signingHash).toBe(EIP155_UNSIGNED_HASH);
    expect(encoded.signingHash).toBe(keccak256(EIP155_UNSIGNED));
  });

  it('decode 未签名载荷返回规范字段且 signed=false', () => {
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

  it('decode 已签名载荷返回 signed=true 且字段与未签名原文一致', () => {
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
/* 2. EIP-2930 / EIP-1559：独立结构重建                                */
/* ------------------------------------------------------------------ */

const SEPOLIA_CHAIN_ID = dec('11155111');
const BASE = {
  chainId: SEPOLIA_CHAIN_ID,
  nonce: dec('42'),
  to: TO,
  value: dec('10000000000000000'),
  gas: dec('21000'),
} as const;

describe('EIP-2930 与 EIP-1559 编码（独立 toRlp 重建）', () => {
  it('typed 交易全零或部分零签名槽不能算已签名', () => {
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
  it('EIP-2930 空 accessList 的字节与结构重建一致', () => {
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

  it('EIP-1559 空 accessList 的字节与结构重建一致', () => {
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

  it('EIP-2930 带 accessList 与 data 时序列化后可完整还原（round-trip）', () => {
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

  it('三种类型都能 encode → decode → 与 intent 比较通过', () => {
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

  it('缺省 type 时使用 eip1559，缺省 data 时使用 0x', () => {
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
/* 3. 负对照：数值与字段校验                                            */
/* ------------------------------------------------------------------ */

function expectCodecError(fn: () => unknown, reason: string): void {
  try {
    fn();
    throw new Error('期望抛出 EvmCodecError，但调用成功');
  } catch (err) {
    expect(err, `期望 EvmCodecError(${reason})，实际 ${String(err)}`).toBeInstanceOf(EvmCodecError);
    expect((err as EvmCodecError).reason).toBe(reason);
  }
}

describe('SEC-CODEC: RLP 反序列化必须拒绝非法链上交易字段', () => {
  const typed = (fields: readonly unknown[]) => (
    `0x01${toRlp(fields as Parameters<typeof toRlp>[0]).slice(2)}`
  );
  const base = ['0x01', '0x', '0x01', '0x5208', TO, '0x', '0x', []] as const;

  it('拒绝带 0x00 或前导零的 nonce，而不是当作另一个等价交易意图', () => {
    for (const nonce of ['0x00', '0x0001']) {
      const malformed = typed([...base.slice(0, 1), nonce, ...base.slice(2)]);
      expectCodecError(() => decodeTransactionPayload(malformed), 'invalid_payload');
    }
  });

  it('拒绝畸形接收地址、accessList 地址、storage key 及多余元组字段', () => {
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

describe('数值边界：一律十进制字符串，禁止 JS number（ADR-016 验收 2）', () => {
  it('拒绝 JS number（即使值看起来合法）', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({ ...BASE, nonce: 42 as unknown as DecimalUint, type: 'eip1559', maxFeePerGas: dec('1'), maxPriorityFeePerGas: dec('1') }),
      'number_not_allowed',
    );
    expectCodecError(
      () => encodeUnsignedTransaction({ ...EIP155_INTENT, value: 1 as unknown as DecimalUint }),
      'number_not_allowed',
    );
  });

  it('拒绝十六进制字符串、负数、空串、小数与科学计数法', () => {
    for (const bad of ['0x2a', '-1', '', '4.2', '1e3', ' 42 ', 'abc']) {
      expectCodecError(
        () => encodeUnsignedTransaction({ ...EIP155_INTENT, nonce: bad as DecimalUint }),
        'invalid_decimal',
      );
    }
  });

  it('拒绝前导零（要求规范十进制形式）', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({ ...EIP155_INTENT, nonce: '09' as DecimalUint }),
      'invalid_decimal',
    );
    // '0' 本身合法。
    expect(encodeUnsignedTransaction({ ...EIP155_INTENT, nonce: dec('0') }).nonce).toBe('0');
  });

  it('拒绝非 EVM 地址的 to', () => {
    for (const bad of ['0x1234', '2222222222222222222222222222222222222222', '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz']) {
      expectCodecError(() => encodeUnsignedTransaction({ ...EIP155_INTENT, to: bad }), 'invalid_address');
    }
  });

  it('拒绝非法 data（非 0x 前缀或奇数长度）', () => {
    for (const bad of ['deadbeef', '0xabc', '0xzz']) {
      expectCodecError(() => encodeUnsignedTransaction({ ...EIP155_INTENT, data: bad }), 'invalid_hex_data');
    }
  });

  it('拒绝未知交易类型', () => {
    expectCodecError(
      () => encodeUnsignedTransaction({ ...EIP155_INTENT, type: 'eip4844' as never }),
      'unsupported_transaction_type',
    );
  });

  it('费用字段必须与交易类型匹配：缺失拒绝', () => {
    expectCodecError(() => encodeUnsignedTransaction({ ...BASE, type: 'legacy' }), 'missing_fee_field');
    expectCodecError(() => encodeUnsignedTransaction({ ...BASE, type: 'eip2930' }), 'missing_fee_field');
    expectCodecError(
      () => encodeUnsignedTransaction({ ...BASE, type: 'eip1559', maxFeePerGas: dec('1') }),
      'missing_fee_field',
    );
  });

  it('费用字段必须与交易类型匹配：多余拒绝', () => {
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

  it('拒绝 maxPriorityFeePerGas > maxFeePerGas 的矛盾输入', () => {
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

  it('拒绝非法 accessList 项', () => {
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

  it('拒绝非法载荷（非十六进制 / 截断 / 未知类型前缀）', () => {
    expectCodecError(() => decodeTransactionPayload('deadbeef'), 'invalid_payload');
    expectCodecError(() => decodeTransactionPayload('0x02f1'), 'invalid_payload');
    expectCodecError(() => decodeTransactionPayload('0x05c0'), 'unsupported_transaction_type');
    expectCodecError(() => decodeTransactionPayload('0x'), 'invalid_payload');
  });
});

/* ------------------------------------------------------------------ */
/* 4. 负对照：篡改字段必须被 intent 比较拒绝（ADR-016 验收 3）          */
/* ------------------------------------------------------------------ */

describe('assertDecodedMatchesIntent 拒绝被篡改的字段', () => {
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

  it('未篡改时通过', () => {
    const decoded = decodeTransactionPayload(encodeUnsignedTransaction(intent).payload);
    expect(() => assertDecodedMatchesIntent(decoded, intent)).not.toThrow();
  });

  it('逐一篡改 chainId / nonce / to / value / gas / data / fee 都被拒绝', () => {
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

  it('篡改后的签名载荷与原 intent 比较失败（模拟签名绑定检查）', () => {
    const decoded = decodeTransactionPayload(EIP155_SIGNED);
    expect(() => assertDecodedMatchesIntent(decoded, EIP155_INTENT)).not.toThrow();
    expectCodecError(
      () => assertDecodedMatchesIntent(decoded, { ...EIP155_INTENT, value: dec('2') }),
      'intent_mismatch',
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. 安全：不发网络、不产生钱包客户端                                  */
/* ------------------------------------------------------------------ */

describe('codec 安全边界（ADR-016 验收 4）', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('encode/decode 期间不调用 fetch', () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error('codec 不应发网络请求');
    }) as unknown as typeof fetch;

    const encoded = encodeUnsignedTransaction(EIP155_INTENT);
    decodeTransactionPayload(encoded.payload);
    decodeTransactionPayload(EIP155_SIGNED);
    expect(calls).toBe(0);
  });

  it('源码只导入 Viem 纯工具与 DFR 类型，不出现 client / transport / account / wallet', () => {
    const specifiers = [...codecSource.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    const allowed = new Set(['viem', '@dfr/types', '@dfr/errors', './address.js', './hex.js']);
    for (const specifier of specifiers) {
      expect(allowed.has(specifier as string), `不允许导入 ${specifier}`).toBe(true);
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
      expect(codecSource.includes(banned), `codec 不得出现 ${banned}`).toBe(false);
    }
  });
});
