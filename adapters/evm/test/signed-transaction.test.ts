/**
 * EVM 签名载荷解析与绑定（DFR-M1-C01）。
 *
 * 权威来源：ADR-016 §7、docs/architecture/m1-api-contract.md 第 3 节
 * （"广播前 Adapter 必须从 signedPayload 重新计算或解析 chain ID / from / nonce /
 * to / value-data / txHash，并与保存的 unsigned transaction 一致；客户端提供的
 * expectedHash 只作比较，不能作为真相"）。
 *
 * 本文件用 **真实签名**（viem 纯函数 + 运行时派生的测试私钥）而不是手写向量：
 * from 必须由 secp256k1 恢复得出，手写向量无法证明恢复逻辑正确。
 * 私钥在运行时由字符串派生，因此仓库里不存在任何私钥字面量。
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

/** 运行时派生：仓库内不出现 64 位十六进制私钥字面量（check-secrets 红线的要求）。 */
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

/** 期望抛出 EvmCodecError 且 reason 稳定。 */
async function expectBindingError(
  promise: Promise<unknown>,
  reason: EvmCodecErrorReason,
): Promise<EvmCodecError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error, `期望 EvmCodecError(${reason})，实际 ${String(error)}`).toBeInstanceOf(
    EvmCodecError,
  );
  const typed = error as EvmCodecError;
  expect(typed.reason).toBe(reason);
  return typed;
}

describe('parseSignedTransaction（DFR-M1-C01）', () => {
  it('从真实签名载荷恢复 from / nonce / to / value / data / txHash', async () => {
    const payload = await sign();
    const parsed = await parseSignedTransaction(CHAIN, payload);

    expect(parsed.from).toEqual({ chain: CHAIN, address: TEST_FROM.toLowerCase() });
    expect(parsed.nonce).toBe('7');
    expect(parsed.to).toEqual({ chain: CHAIN, address: TO });
    expect(parsed.value).toBe('1000');
    expect(parsed.data).toBe('0x');
    expect(parsed.type).toBe('eip1559');
    expect(parsed.chainId).toBe(CHAIN_ID);
    // txHash 必须由载荷重新计算，而不是由调用方提供。
    expect(parsed.txHash).toBe(keccak256(payload as `0x${string}`));
  });

  it('返回值里不含签名原文，避免被顺手写进日志或数据库', async () => {
    const payload = await sign();
    const parsed = await parseSignedTransaction(CHAIN, payload);

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(payload);
    for (const key of Object.keys(parsed)) {
      expect(key.toLowerCase()).not.toContain('payload');
      expect(key.toLowerCase()).not.toContain('signed');
    }
  });

  it('未签名载荷 → not_signed（不能拿未签名原文当广播输入）', async () => {
    await expectBindingError(
      parseSignedTransaction(CHAIN, await signUnsignedRaw()),
      'not_signed',
    );
  });

  it('pre-EIP-155 legacy 签名无法确定 chainId → chain_id_unknown', async () => {
    const legacy = await signTransaction({
      privateKey: TEST_KEY,
      transaction: { nonce: 0, gasPrice: 1000000000n, gas: 21000n, to: TO, value: 1n, data: '0x' },
    });
    await expectBindingError(parseSignedTransaction(CHAIN, legacy), 'chain_id_unknown');
  });
});

describe('bindSignedTransaction（DFR-M1-C01）', () => {
  it('签名与保存的 unsigned 载荷逐项一致 → 通过', async () => {
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

  it('from 与记录不一致 → sender_mismatch（用另一个密钥签同一笔交易）', async () => {
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

  it('chainId 与记录不一致 → chain_id_mismatch', async () => {
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

  it.each(cases)('签名后的 %s 与保存载荷不一致 → unsigned_payload_mismatch', async (field, override) => {
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

  it('另一个密钥签出的载荷不会被误判为记录中的发送方（OTHER_FROM 反证）', async () => {
    const payload = await sign({}, OTHER_KEY);
    const parsed = await parseSignedTransaction(CHAIN, payload);
    expect(parsed.from.address).toBe(OTHER_FROM.toLowerCase());
    expect(parsed.from.address).not.toBe(TEST_FROM.toLowerCase());
  });

  it('客户端 expectedHash 与重算结果不一致 → expected_hash_mismatch', async () => {
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

  it('失败信息不含签名原文（脱敏）', async () => {
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

describe('脱敏（error-spec 第 6 章）', () => {
  it('载荷无法解析时也不回显签名原文', async () => {
    const payload = await sign();
    // 截断尾部：RLP 一定解析失败，走 invalid_payload 分支。
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

describe('输入边界（fail-closed）', () => {
  it('记录里的发送方非法 → invalid_expectation（不抛 DFR_* 错误）', async () => {
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

  it('记录里的 unsigned payload 实际已签名 → invalid_expectation', async () => {
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

describe('源码守卫（ADR-016 §1）', () => {
  it('signed-transaction.ts 只导入允许的模块，且不含 client / wallet / 签名能力', () => {
    const source = readFileSync(resolve(here, '..', 'src', 'signed-transaction.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    const allowed = new Set(['viem', '@dfr/types', './address.js', './transaction-codec.js']);
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
      'signTransaction',
      'sendRawTransaction',
    ]) {
      expect(source.includes(banned), `不得出现 ${banned}`).toBe(false);
    }
  });
});

/** 与签名载荷字段完全一致、但**未签名**的载荷：绑定比较的真值来自它。 */
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
