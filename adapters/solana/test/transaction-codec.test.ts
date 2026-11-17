/**
 * Solana 交易 codec 测试（DFR-M3-A02）。
 *
 * 权威来源：ADR-028（零新增依赖）、ADR-032、adapter-spec §8.2。
 *
 * 验证手段与 EVM codec 同构：
 *   1. 用**独立**的最简 reference 实现重建关键字节（不调用被测函数），避免"自己证明自己"；
 *   2. 编解码往返（encode → decode 后字段一致）；
 *   3. 公开规范向量（Solana 的 message 格式由官方 SDK 定义，这里用手算向量固定）；
 *   4. fail-closed 负对照（非法 base64/base58/长度/账户下标/版本）。
 */
import { describe, expect, it } from 'vitest';
import {
  SolanaCodecError,
  SolanaBindingError,
  bindSignedTransaction,
  base58Decode,
  base58Encode,
  compileMessage,
  decodeMessage,
  decodeTransactionPayload,
  encodeUnsignedTransaction,
  hexToBytes,
  splitSignatures,
} from '@dfr/adapter-solana';

/* ------------------------------------------------------------------ */
/* 独立 reference：手写 base58 编码与 compact-u16，与被测实现无关      */
/* ------------------------------------------------------------------ */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function refBase58(bytes: readonly number[]): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)]! + out;
    num /= 58n;
  }
  let zeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    zeros += 1;
  }
  return '1'.repeat(zeros) + out;
}

function refCompactU16(value: number): number[] {
  if (value < 0x80) return [value];
  if (value < 0x4000) return [(value & 0x7f) | 0x80, value >> 7];
  return [(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, value >> 14];
}

/** 确定性填充的 32 字节公钥（合法 base58；非任何真实账户）。 */
function pubkey(seed: number): string {
  const bytes = Array.from({ length: 32 }, (_, index) => (seed * 7 + index * 13 + 1) & 0xff);
  return refBase58(bytes);
}

const FEE_PAYER = pubkey(1);
const ALICE = pubkey(2);
const PROGRAM = pubkey(9);
const BLOCKHASH = refBase58(Array.from({ length: 32 }, (_, index) => (index * 3 + 5) & 0xff));

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** 一笔最小转账：fee payer 签名 + 一个可写收款账户 + system program。 */
const transferIntent = {
  feePayer: FEE_PAYER,
  blockhash: BLOCKHASH,
  instructions: [
    {
      programId: SYSTEM_PROGRAM,
      accounts: [{ pubkey: FEE_PAYER, isSigner: true, isWritable: true }, { pubkey: ALICE, isSigner: false, isWritable: true }],
      data: Buffer.from([2, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0]).toString('base64'),
    },
  ],
} as const;

describe('base58 编解码（ADR-028 零依赖）', () => {
  it('编码与独立 reference 一致，且与解码互逆', () => {
    // 空串情形由 base58Decode 显式返回 null（沿用 M2 既有约定），故此处只测非空。
    for (const bytes of [[0], [0, 0, 0, 0], [104, 101, 108, 108, 111], [255, 254, 253], [1, 2, 3, 4, 5, 6, 7, 8]]) {
      const encoded = base58Encode(Uint8Array.from(bytes));
      expect(encoded).toBe(refBase58(bytes));
      expect([...base58Decode(encoded)!]).toEqual(bytes);
    }
  });

  it('全零字节按前导 "1" 处理（32 个零字节 = 32 个 "1"）', () => {
    const zeros = new Uint8Array(32);
    expect(base58Encode(zeros)).toBe('1'.repeat(32));
    expect([...base58Decode('1'.repeat(32))!]).toEqual([...zeros]);
    // 系统程序地址正是 32 个零字节。
    expect(SYSTEM_PROGRAM).toBe('1'.repeat(32));
  });
});

describe('legacy message 编译（公开格式，独立重建）', () => {
  it('header / 账户表 / blockhash / 指令段与手工重建逐字节一致', () => {
    const compiled = compileMessage(transferIntent);

    // 独立重建期望字节。
    const accountKeys = [FEE_PAYER, ALICE, SYSTEM_PROGRAM];
    const expected = Uint8Array.from([
      1, // numRequiredSignatures
      0, // numReadonlySignedAccounts
      1, // numReadonlyUnsignedAccounts（system program 只读非签名）
      ...refCompactU16(accountKeys.length),
      ...accountKeys.flatMap((key) => [...base58Decode(key)!]),
      ...base58Decode(BLOCKHASH)!,
      ...refCompactU16(1), // 一条指令
      2, // programIdIndex = system program 在表中第 2 位
      ...refCompactU16(2), // 两个账户
      0,
      1,
      ...refCompactU16(12), // 数据长度
      2, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0,
    ]);

    expect([...compiled.messageBytes]).toEqual([...expected]);
    expect(compiled.version).toBe('legacy');
    expect(compiled.accountKeys).toEqual(accountKeys);
    expect(compiled.recentBlockhash).toBe(BLOCKHASH);
    expect(compiled.numRequiredSignatures).toBe(1);
  });

  it('fee payer 永远在账户表首位，且被标记为签名者', () => {
    const compiled = compileMessage({
      ...transferIntent,
      instructions: [
        { programId: PROGRAM, accounts: [{ pubkey: ALICE, isSigner: false, isWritable: false }] },
      ],
    });
    expect(compiled.accountKeys[0]).toBe(FEE_PAYER);
    expect(compiled.header.numRequiredSignatures).toBe(1);
  });

  it('同一 pubkey 跨指令合并，权限取并集（可写优先）', () => {
    const compiled = compileMessage({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [
        { programId: PROGRAM, accounts: [{ pubkey: ALICE, isSigner: false, isWritable: false }] },
        { programId: PROGRAM, accounts: [{ pubkey: ALICE, isSigner: false, isWritable: true }] },
      ],
    });
    // ALICE 只出现一次，且在可写非签名组。
    expect(compiled.accountKeys.filter((key) => key === ALICE)).toHaveLength(1);
    const aliceIndex = compiled.accountKeys.indexOf(ALICE);
    expect(aliceIndex).toBe(compiled.header.numRequiredSignatures);
  });
});

describe('v0 message（含版本前缀与空 ALT 段）', () => {
  it('v0 首字节带版本前缀，末尾有空 lookup 计数', () => {
    const compiled = compileMessage({ ...transferIntent, version: 'v0' });
    expect(compiled.messageBytes[0]).toBe(0x80); // VERSION_PREFIX | 0
    expect(compiled.version).toBe('v0');
    // header 从第 1 字节开始。
    expect(compiled.messageBytes[1]).toBe(1);
    // 末尾是 compact-u16(0)。
    expect(compiled.messageBytes[compiled.messageBytes.length - 1]).toBe(0);

    const decoded = decodeMessage(compiled.messageBytes);
    expect(decoded.version).toBe('v0');
    expect(decoded.addressTableLookups).toBe(0);
    expect(decoded.accountKeys).toEqual(compiled.accountKeys);
  });
});

describe('编解码往返', () => {
  it('legacy：encode → decode 后账户/blockhash/指令一致，且判定为未签名', () => {
    const { payload, encoding } = encodeUnsignedTransaction(transferIntent);
    expect(encoding).toBe('base64');

    const decoded = decodeTransactionPayload(payload);
    expect(decoded.version).toBe('legacy');
    expect(decoded.signed).toBe(false);
    expect(decoded.accountKeys).toEqual(compileMessage(transferIntent).accountKeys);
    expect(decoded.recentBlockhash).toBe(BLOCKHASH);
    expect(decoded.instructions).toHaveLength(1);
    const instruction = decoded.instructions[0]!;
    expect(instruction.programId).toBe(SYSTEM_PROGRAM);
    expect(instruction.accountIndices).toEqual([0, 1]);
    expect(Buffer.from(instruction.data, 'base64')).toEqual(
      Buffer.from([2, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0]),
    );
  });

  it('v0：往返一致', () => {
    const { payload } = encodeUnsignedTransaction({ ...transferIntent, version: 'v0' });
    const decoded = decodeTransactionPayload(payload);
    expect(decoded.version).toBe('v0');
    expect(decoded.signed).toBe(false);
  });

  it('多签名者：签名槽位数等于 header 要求，且顺序稳定', () => {
    const { payload, message } = encodeUnsignedTransaction({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [
        {
          programId: PROGRAM,
          accounts: [
            { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
            { pubkey: ALICE, isSigner: true, isWritable: false },
          ],
        },
      ],
    });
    expect(message.numRequiredSignatures).toBe(2);
    const { signatures, messageBytes } = splitSignatures(Buffer.from(payload, 'base64'));
    expect(signatures).toHaveLength(2);
    expect([...messageBytes]).toEqual([...message.messageBytes]);
  });

  it('SOL-01：fee payer 缺签而第二个签名槽非零，整笔交易必须判为未签名', () => {
    const { payload } = encodeUnsignedTransaction({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [{
        programId: PROGRAM,
        accounts: [
          { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
          { pubkey: ALICE, isSigner: true, isWritable: false },
        ],
      }],
    });
    const bytes = Buffer.from(payload, 'base64');
    expect(bytes[0]).toBe(2);
    bytes[1 + 64] = 0x42; // 第二签名槽非零；第 0 槽 64 字节仍全零。
    const partiallySigned = bytes.toString('base64');
    expect(decodeTransactionPayload(partiallySigned).signed).toBe(false);
    expect(() => bindSignedTransaction(partiallySigned, {
      from: FEE_PAYER,
      unsignedPayload: payload,
      expectedHash: base58Encode(new Uint8Array(64)),
    })).toThrowError(SolanaBindingError);
  });

  it('SOL-01：fee payer 有签名但另一必需签名槽缺失，同样不能广播', () => {
    const { payload } = encodeUnsignedTransaction({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [{
        programId: PROGRAM,
        accounts: [
          { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
          { pubkey: ALICE, isSigner: true, isWritable: false },
        ],
      }],
    });
    const bytes = Buffer.from(payload, 'base64');
    bytes[1] = 0x42; // fee payer 槽非零；第二签名槽仍为全零。
    expect(decodeTransactionPayload(bytes.toString('base64')).signed).toBe(false);
  });

  it('SOL-01：所有必需槽都有非零字节时只能证明填充完整，不能证明验签正确', () => {
    const { payload } = encodeUnsignedTransaction({
      feePayer: FEE_PAYER,
      blockhash: BLOCKHASH,
      instructions: [{
        programId: PROGRAM,
        accounts: [
          { pubkey: FEE_PAYER, isSigner: true, isWritable: true },
          { pubkey: ALICE, isSigner: true, isWritable: false },
        ],
      }],
    });
    const bytes = Buffer.from(payload, 'base64');
    bytes[1] = 0x11;
    bytes[1 + 64] = 0x22;
    // This is a signature-presence test: these arbitrary bytes are NOT real Ed25519 signatures.
    expect(decodeTransactionPayload(bytes.toString('base64')).signed).toBe(true);
  });

  it('已签名载荷（非零签名）被识别为 signed=true', () => {
    const { payload } = encodeUnsignedTransaction(transferIntent);
    const bytes = Buffer.from(payload, 'base64');
    // 把第一个签名的首字节改为非零，模拟外部钱包已签名。
    bytes[1] = 0x7f;
    const decoded = decodeTransactionPayload(bytes.toString('base64'));
    expect(decoded.signed).toBe(true);
  });
});

describe('fail-closed 负对照', () => {
  it('拒绝非 base64 载荷', () => {
    expect(() => decodeTransactionPayload('not base64!!!')).toThrow(SolanaCodecError);
  });

  it('拒绝非 base58 / 错误长度的地址与 blockhash', () => {
    expect(() =>
      compileMessage({ ...transferIntent, feePayer: '0invalid' }),
    ).toThrow(/base58|32/u);
    expect(() =>
      compileMessage({ ...transferIntent, blockhash: base58Encode(Uint8Array.from([1, 2, 3])) }),
    ).toThrow(SolanaCodecError);
  });

  it('拒绝不支持的 message 版本号（v0 之上的版本前缀）', () => {
    const bogus = Uint8Array.from([0x80 | 1, 1, 0, 0]);
    expect(() => decodeMessage(bogus)).toThrow(/版本/u);
  });

  it('拒绝越界的 programId 下标与账户下标', () => {
    // 手工构造：账户表 1 个，但 programIdIndex = 5。
    const message = Uint8Array.from([
      1, 0, 0,
      ...refCompactU16(1),
      ...base58Decode(FEE_PAYER)!,
      ...base58Decode(BLOCKHASH)!,
      ...refCompactU16(1), // 一条指令
      5, // programIdIndex 越界
      ...refCompactU16(0),
      ...refCompactU16(0),
    ]);
    expect(() => decodeMessage(message)).toThrow(/越界/u);
  });

  it('拒绝长度不足（截断）', () => {
    expect(() => decodeMessage(Uint8Array.from([1, 0]))).toThrow(SolanaCodecError);
  });

  it('拒绝尾部多余字节（不允许静默忽略）', () => {
    const compiled = compileMessage(transferIntent);
    const withTrailer = Uint8Array.from([...compiled.messageBytes, 99]);
    expect(() => decodeMessage(withTrailer)).toThrow(/多余/u);
  });

  it('v0 且带 ALT lookup 段 → 显式拒绝（需要链上账户表解析）', () => {
    const compiled = compileMessage({ ...transferIntent, version: 'v0' });
    // 把末尾的 compact-u16(0) 改成 compact-u16(1)，模拟存在一个 lookup。
    const bytes = Uint8Array.from(compiled.messageBytes);
    bytes[bytes.length - 1] = 1;
    expect(() => decodeMessage(bytes)).toThrow(/address table lookup/u);
  });

  it('hexToBytes 校验非法/奇数长度', () => {
    expect([...hexToBytes('0xdeadbeef', 'data')]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(() => hexToBytes('0xabc', 'data')).toThrow(/奇数/u);
    expect(() => hexToBytes('0xzz', 'data')).toThrow(/hex/u);
  });
});
