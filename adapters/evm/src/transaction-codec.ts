/**
 * EVM 交易编解码纯函数（DFR-M1-B01）。
 *
 * 权威来源：ADR-016、docs/architecture/m1-api-contract.md。
 *
 * 设计约束（逐条对应 ADR-016）：
 *   1. **只使用 Viem 纯工具**：`serializeTransaction`（编码）、`fromRlp`（无损解码）、
 *      `keccak256`（哈希）。不出现 `PublicClient` / `WalletClient` / transport /
 *      account / 签名能力，也不自行实现 RLP 或 secp256k1。
 *   2. **数值一律 bigint / 十进制字符串**。Viem 的 `parseTransaction` 会把
 *      `nonce` 与 `chainId` 降级为 JS `number`，所以本模块**不使用**它解码，
 *      改用 `fromRlp` 逐字段还原，避免任何精度或类型回退。
 *   3. 输入校验 fail-closed：非法十进制、JS number、非法地址 / 数据 / accessList、
 *      费用字段与交易类型不匹配，都必须抛 `EvmCodecError`，不静默纠正。
 *   4. 本模块是纯函数：不发网络请求、不读取私钥、不持有端点或凭证。
 *
 * 边界：本模块只做编解码与结构比较，**不**选 Provider、不写数据库、不决定交易状态。
 */

import { fromRlp, keccak256, serializeTransaction } from 'viem';
import type { DecimalUint } from '@dfr/types';
import { isEvmAddress } from './address.js';

/** M1 支持的 EVM 交易类型（ADR-016 §5）。 */
export type EvmTransactionType = 'legacy' | 'eip2930' | 'eip1559';

/** 稳定的失败原因码；Adapter 负责把它归一化为对外 DFR 错误。 */
export type EvmCodecErrorReason =
  | 'number_not_allowed'
  | 'invalid_decimal'
  | 'invalid_address'
  | 'invalid_hex_data'
  | 'invalid_access_list'
  | 'missing_fee_field'
  | 'unexpected_fee_field'
  | 'invalid_fee_bounds'
  | 'unsupported_transaction_type'
  | 'invalid_payload'
  | 'intent_mismatch'
  // DFR-M1-C01：签名载荷解析与绑定（signed-transaction.ts）
  | 'not_signed'
  | 'chain_id_unknown'
  | 'invalid_signature'
  | 'chain_id_mismatch'
  | 'sender_mismatch'
  | 'unsigned_payload_mismatch'
  | 'expected_hash_mismatch'
  | 'invalid_expectation';

export class EvmCodecError extends Error {
  override readonly name = 'EvmCodecError';
  readonly reason: EvmCodecErrorReason;
  readonly field?: string;

  constructor(reason: EvmCodecErrorReason, message: string, field?: string) {
    super(message);
    this.reason = reason;
    if (field !== undefined) this.field = field;
  }
}

export interface EvmAccessListEntry {
  readonly address: string;
  readonly storageKeys: readonly string[];
}

/** 未签名交易意图。所有数值字段都是规范十进制字符串，禁止 JS number。 */
export interface EvmUnsignedIntent {
  readonly chainId: string;
  readonly nonce: string;
  readonly to: string;
  readonly value: string;
  readonly gas: string;
  /** 调用数据；省略等价于 `0x`（原生转账）。 */
  readonly data?: string;
  readonly type?: EvmTransactionType;
  /** legacy / eip2930 必填。 */
  readonly gasPrice?: string;
  /** eip1559 必填。 */
  readonly maxFeePerGas?: string;
  /** eip1559 必填。 */
  readonly maxPriorityFeePerGas?: string;
  readonly accessList?: readonly EvmAccessListEntry[];
}

export interface EvmUnsignedPayload {
  /** 未签名序列化载荷：外部钱包对它求 keccak256 即得签名哈希。 */
  readonly payload: string;
  readonly encoding: 'hex';
  readonly type: EvmTransactionType;
  readonly chainId: DecimalUint;
  readonly nonce: DecimalUint;
  /** `keccak256(payload)`：未签名时即签名前哈希。 */
  readonly signingHash: string;
}

export interface EvmDecodedTransaction {
  readonly type: EvmTransactionType;
  /** 无法从载荷推导时（pre-EIP-155 legacy）为 null。 */
  readonly chainId: DecimalUint | null;
  readonly nonce: DecimalUint;
  /** null 表示合约创建。 */
  readonly to: string | null;
  readonly value: DecimalUint;
  readonly data: string;
  readonly gas: DecimalUint;
  readonly gasPrice?: DecimalUint;
  readonly maxFeePerGas?: DecimalUint;
  readonly maxPriorityFeePerGas?: DecimalUint;
  readonly accessList: readonly EvmAccessListEntry[];
  /** 载荷是否已带签名。 */
  readonly signed: boolean;
  /** `keccak256(payload)`：未签名时是签名前哈希，已签名时是交易哈希。 */
  readonly hash: string;
}

/* ------------------------------------------------------------------ */
/* 校验辅助                                                            */
/* ------------------------------------------------------------------ */

/** 规范十进制：无前导零（`0` 除外）、无符号、无小数。 */
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const STORAGE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function toBigIntField(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    throw new EvmCodecError(
      'number_not_allowed',
      `${field} 不得使用 JS number（数值一律十进制字符串）`,
      field,
    );
  }
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new EvmCodecError(
      'invalid_decimal',
      `${field} 必须是规范十进制字符串（无前导零、无符号、无小数）`,
      field,
    );
  }
  return BigInt(value);
}

function toDecimal(value: bigint): DecimalUint {
  return value.toString(10) as DecimalUint;
}

/** EVM 交易数值必须采用最短大端 RLP 表示；零仅允许空字节串。 */
function rlpToBigInt(value: string): bigint {
  if (value === '0x') return 0n;
  if (!/^0x(?:[0-9a-f]{2})+$/.test(value) || value.startsWith('0x00')) {
    throw new EvmCodecError('invalid_payload', 'RLP 整数字段不得含前导零或非规范字节');
  }
  return BigInt(value);
}

function normalizeData(value: string | undefined, field: string): string {
  if (value === undefined) return '0x';
  if (!HEX_DATA_RE.test(value)) {
    throw new EvmCodecError(
      'invalid_hex_data',
      `${field} 必须是 0x 前缀的偶数字节十六进制`,
      field,
    );
  }
  return value.toLowerCase();
}

function normalizeAddress(value: string, field: string): string {
  if (!isEvmAddress(value)) {
    throw new EvmCodecError('invalid_address', `${field} 不是合法的 EVM 地址`, field);
  }
  return value.toLowerCase();
}

function normalizeAccessList(
  list: readonly EvmAccessListEntry[] | undefined,
): readonly EvmAccessListEntry[] {
  if (list === undefined) return [];
  return list.map((entry) => {
    // accessList 内部问题统一归为 invalid_access_list，便于调用方区分
    // "目标地址非法" 与 "访问列表非法" 两类修复动作。
    let address: string;
    try {
      address = normalizeAddress(entry.address, 'accessList.address');
    } catch {
      throw new EvmCodecError(
        'invalid_access_list',
        'accessList.address 不是合法的 EVM 地址',
        'accessList.address',
      );
    }
    const storageKeys = entry.storageKeys.map((key) => {
      if (!STORAGE_KEY_RE.test(key)) {
        throw new EvmCodecError(
          'invalid_access_list',
          'accessList.storageKeys 必须是 0x + 32 字节十六进制',
          'accessList.storageKeys',
        );
      }
      return key.toLowerCase();
    });
    return { address, storageKeys };
  });
}

/** 编码时用于喂给 Viem 的最小结构（全部 bigint / hex，绝不出现 number）。 */
interface CanonicalIntent {
  readonly type: EvmTransactionType;
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly gas: bigint;
  readonly data: string;
  readonly accessList: readonly EvmAccessListEntry[];
  readonly gasPrice?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
}

function requireFee(value: string | undefined, field: string): bigint {
  if (value === undefined) {
    throw new EvmCodecError('missing_fee_field', `${field} 对该交易类型是必填项`, field);
  }
  return toBigIntField(value, field);
}

function rejectFee(value: string | undefined, field: string, type: EvmTransactionType): void {
  if (value !== undefined) {
    throw new EvmCodecError(
      'unexpected_fee_field',
      `${field} 不适用于 ${type} 交易`,
      field,
    );
  }
}

function canonicalizeIntent(intent: EvmUnsignedIntent): CanonicalIntent {
  const type = intent.type ?? 'eip1559';
  if (type !== 'legacy' && type !== 'eip2930' && type !== 'eip1559') {
    throw new EvmCodecError(
      'unsupported_transaction_type',
      `M1 只支持 legacy / eip2930 / eip1559，收到 ${String(intent.type)}`,
      'type',
    );
  }

  const chainId = toBigIntField(intent.chainId, 'chainId');
  const nonce = toBigIntField(intent.nonce, 'nonce');
  const value = toBigIntField(intent.value, 'value');
  const gas = toBigIntField(intent.gas, 'gas');
  const to = normalizeAddress(intent.to, 'to');
  const data = normalizeData(intent.data, 'data');
  const accessList = normalizeAccessList(intent.accessList);

  if (type === 'eip1559') {
    rejectFee(intent.gasPrice, 'gasPrice', type);
    const maxFeePerGas = requireFee(intent.maxFeePerGas, 'maxFeePerGas');
    const maxPriorityFeePerGas = requireFee(intent.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
    if (maxPriorityFeePerGas > maxFeePerGas) {
      throw new EvmCodecError(
        'invalid_fee_bounds',
        'maxPriorityFeePerGas 不得大于 maxFeePerGas',
        'maxPriorityFeePerGas',
      );
    }
    return {
      type, chainId, nonce, to, value, gas, data, accessList, maxFeePerGas, maxPriorityFeePerGas,
    };
  }

  rejectFee(intent.maxFeePerGas, 'maxFeePerGas', type);
  rejectFee(intent.maxPriorityFeePerGas, 'maxPriorityFeePerGas', type);
  if (type === 'legacy' && accessList.length > 0) {
    throw new EvmCodecError('unexpected_fee_field', 'legacy 交易不支持 accessList', 'accessList');
  }
  const gasPrice = requireFee(intent.gasPrice, 'gasPrice');
  return { type, chainId, nonce, to, value, gas, data, accessList, gasPrice };
}

/* ------------------------------------------------------------------ */
/* 编码                                                                */
/* ------------------------------------------------------------------ */

/**
 * 原生转账 / 带 data 的未签名交易序列化。
 *
 * 返回值中的 `payload` 直接交给外部钱包签名；`signingHash` 便于调用方核对钱包
 * 展示的签名对象，但**不**替代钱包自己的哈希计算。
 */
export function encodeUnsignedTransaction(intent: EvmUnsignedIntent): EvmUnsignedPayload {
  const canonical = canonicalizeIntent(intent);

  // Viem 的 TypeScript 把 chainId 声明为 number，但运行时接受 bigint。
  // DFR 政策禁止把链上数值降级为 number，因此这里在 viem 边界做一次显式断言，
  // 并由 golden vector 测试证明运行行为符合预期。
  const tx = {
    type: canonical.type,
    chainId: canonical.chainId,
    nonce: canonical.nonce,
    to: canonical.to,
    value: canonical.value,
    gas: canonical.gas,
    data: canonical.data,
    ...(canonical.accessList.length > 0 ? { accessList: canonical.accessList } : {}),
    ...(canonical.gasPrice !== undefined ? { gasPrice: canonical.gasPrice } : {}),
    ...(canonical.maxFeePerGas !== undefined ? { maxFeePerGas: canonical.maxFeePerGas } : {}),
    ...(canonical.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas: canonical.maxPriorityFeePerGas }
      : {}),
  };

  let payload: string;
  try {
    payload = serializeTransaction(
      tx as unknown as Parameters<typeof serializeTransaction>[0],
    ).toLowerCase();
  } catch (cause) {
    throw new EvmCodecError(
      'invalid_payload',
      `无法序列化交易：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return {
    payload,
    encoding: 'hex',
    type: canonical.type,
    chainId: toDecimal(canonical.chainId),
    nonce: toDecimal(canonical.nonce),
    signingHash: keccak256(payload as `0x${string}`),
  };
}

/* ------------------------------------------------------------------ */
/* 解码                                                                */
/* ------------------------------------------------------------------ */

type RlpField = string | readonly RlpField[];

function asArray(fields: RlpField, type: EvmTransactionType): readonly RlpField[] {
  if (typeof fields === 'string') {
    throw new EvmCodecError('invalid_payload', `${type} 载荷必须是 RLP 列表`);
  }
  return fields;
}

function asBytes(value: RlpField | undefined, label: string): string {
  if (typeof value !== 'string') {
    throw new EvmCodecError('invalid_payload', `${label} 必须是字节串`);
  }
  return value.toLowerCase();
}

function asBigInt(value: RlpField | undefined, label: string): bigint {
  const hex = asBytes(value, label);
  try {
    return rlpToBigInt(hex);
  } catch {
    throw new EvmCodecError('invalid_payload', `${label} 不是合法的整数编码`);
  }
}

function decodeAccessList(value: RlpField | undefined): readonly EvmAccessListEntry[] {
  if (value === undefined || typeof value === 'string') {
    // 空列表被 RLP 编码为 0xc0，fromRlp 会解成 []，因此字符串这里只能是非法输入。
    if (value === '0xc0') return [];
    throw new EvmCodecError('invalid_payload', 'accessList 必须是列表');
  }
  return value.map((entry) => {
    if (typeof entry === 'string' || entry.length !== 2) {
      throw new EvmCodecError('invalid_payload', 'accessList 项必须是 [address, storageKeys] 二元列表');
    }
    const address = asBytes(entry[0], 'accessList.address');
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      throw new EvmCodecError('invalid_payload', 'accessList.address 必须为 20 字节地址');
    }
    const keys = entry[1];
    if (keys === undefined || typeof keys === 'string') {
      throw new EvmCodecError('invalid_payload', 'accessList.storageKeys 必须是列表');
    }
    const storageKeys = keys.map((key) => asBytes(key, 'accessList.storageKeys'));
    if (storageKeys.some((key) => !/^0x[0-9a-f]{64}$/.test(key))) {
      throw new EvmCodecError('invalid_payload', 'accessList.storageKeys 必须为 32 字节');
    }
    return { address, storageKeys };
  });
}

function emptyToNull(value: string): string | null {
  if (value === '0x') return null;
  if (!/^0x[0-9a-f]{40}$/.test(value)) {
    throw new EvmCodecError('invalid_payload', '接收地址必须为空（合约创建）或恰好 20 字节');
  }
  return value;
}

/**
 * 从序列化载荷还原 DFR 领域字段。
 *
 * 已签名与未签名载荷都能解析：`signed` 由签名字段的存在推导，`hash` 始终是
 * `keccak256(payload)`（未签名即签名前哈希，已签名即交易哈希）。
 */
export function decodeTransactionPayload(payload: string): EvmDecodedTransaction {
  if (typeof payload !== 'string' || !HEX_DATA_RE.test(payload) || payload === '0x') {
    throw new EvmCodecError('invalid_payload', '载荷必须是 0x 前缀的偶数字节十六进制');
  }

  const firstByte = Number.parseInt(payload.slice(2, 4), 16);

  let type: EvmTransactionType;
  let body = payload;
  if (firstByte === 0x01) {
    type = 'eip2930';
    body = `0x${payload.slice(4)}`;
  } else if (firstByte === 0x02) {
    type = 'eip1559';
    body = `0x${payload.slice(4)}`;
  } else if (firstByte <= 0x7f) {
    // 0x00 / 0x03…0x7f 都不是 M1 承诺的交易类型（EIP-4844 / 7702 等）。
    throw new EvmCodecError(
      'unsupported_transaction_type',
      `不支持的 EVM 交易类型前缀 0x${firstByte.toString(16).padStart(2, '0')}`,
    );
  } else {
    type = 'legacy';
  }

  let rlp: RlpField;
  try {
    rlp = fromRlp(body as `0x${string}`) as RlpField;
  } catch {
    throw new EvmCodecError('invalid_payload', '载荷不是合法的 RLP 交易编码');
  }

  const fields = asArray(rlp, type);
  const hash = keccak256(payload as `0x${string}`);

  /* legacy：[nonce, gasPrice, gas, to, value, data, (chainId|v), (0|r), (0|s)] */
  if (type === 'legacy') {
    if (fields.length !== 6 && fields.length !== 9) {
      throw new EvmCodecError('invalid_payload', `legacy 载荷字段数非法：${fields.length}`);
    }
    let chainId: DecimalUint | null = null;
    let signed = false;
    if (fields.length === 9) {
      const v = asBigInt(fields[6], 'v');
      const r = asBigInt(fields[7], 'r');
      const s = asBigInt(fields[8], 's');
      // 两个签名标量都必须存在；半零载荷不是已签名交易。
      signed = r !== 0n && s !== 0n;
      // EIP-155：v = chainId * 2 + 35/36；pre-EIP-155 的 27/28 推导不出 chainId。
      chainId = signed ? (v >= 35n ? toDecimal((v - 35n) / 2n) : null)
        : (v === 27n || v === 28n ? null : toDecimal(v));
    }
    return {
      type,
      chainId,
      nonce: toDecimal(asBigInt(fields[0], 'nonce')),
      to: emptyToNull(asBytes(fields[3], 'to')),
      value: toDecimal(asBigInt(fields[4], 'value')),
      data: asBytes(fields[5], 'data'),
      gas: toDecimal(asBigInt(fields[2], 'gas')),
      gasPrice: toDecimal(asBigInt(fields[1], 'gasPrice')),
      accessList: [],
      signed,
      hash,
    };
  }

  /* eip2930：[chainId, nonce, gasPrice, gas, to, value, data, accessList(, yParity, r, s)] */
  if (type === 'eip2930') {
    if (fields.length !== 8 && fields.length !== 11) {
      throw new EvmCodecError('invalid_payload', `eip2930 载荷字段数非法：${fields.length}`);
    }
    return {
      type,
      chainId: toDecimal(asBigInt(fields[0], 'chainId')),
      nonce: toDecimal(asBigInt(fields[1], 'nonce')),
      gasPrice: toDecimal(asBigInt(fields[2], 'gasPrice')),
      gas: toDecimal(asBigInt(fields[3], 'gas')),
      to: emptyToNull(asBytes(fields[4], 'to')),
      value: toDecimal(asBigInt(fields[5], 'value')),
      data: asBytes(fields[6], 'data'),
      accessList: decodeAccessList(fields[7]),
      signed: fields.length === 11 && asBigInt(fields[9], 'r') !== 0n && asBigInt(fields[10], 's') !== 0n,
      hash,
    };
  }

  /* eip1559：[chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList(, ...)] */
  if (fields.length !== 9 && fields.length !== 12) {
    throw new EvmCodecError('invalid_payload', `eip1559 载荷字段数非法：${fields.length}`);
  }
  return {
    type,
    chainId: toDecimal(asBigInt(fields[0], 'chainId')),
    nonce: toDecimal(asBigInt(fields[1], 'nonce')),
    maxPriorityFeePerGas: toDecimal(asBigInt(fields[2], 'maxPriorityFeePerGas')),
    maxFeePerGas: toDecimal(asBigInt(fields[3], 'maxFeePerGas')),
    gas: toDecimal(asBigInt(fields[4], 'gas')),
    to: emptyToNull(asBytes(fields[5], 'to')),
    value: toDecimal(asBigInt(fields[6], 'value')),
    data: asBytes(fields[7], 'data'),
    accessList: decodeAccessList(fields[8]),
    signed: fields.length === 12 && asBigInt(fields[10], 'r') !== 0n && asBigInt(fields[11], 's') !== 0n,
    hash,
  };
}

/* ------------------------------------------------------------------ */
/* 结构比较                                                            */
/* ------------------------------------------------------------------ */

/** 供比较使用的规范化视图：全部 lowercase hex + 十进制字符串。 */
function canonicalView(tx: EvmDecodedTransaction): string {
  const accessList = tx.accessList.map((entry) => [entry.address, entry.storageKeys]);
  return JSON.stringify({
    type: tx.type,
    chainId: tx.chainId,
    nonce: tx.nonce,
    to: tx.to,
    value: tx.value,
    gas: tx.gas,
    data: tx.data,
    gasPrice: tx.gasPrice ?? null,
    maxFeePerGas: tx.maxFeePerGas ?? null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
    accessList,
  });
}

/**
 * 校验载荷与原未签名意图逐字段一致。
 *
 * ADR-016 §7 要求广播前用重新解析的载荷与原 intent 比较；本函数是该校验的纯函数内核，
 * 任何字段（chainId / nonce / to / value / gas / data / fee / accessList）不一致都拒绝。
 * 不比较签名：`signed` 与 `hash` 是载荷自身的属性，不属于意图。
 */
export function assertDecodedMatchesIntent(
  decoded: EvmDecodedTransaction,
  intent: EvmUnsignedIntent,
): void {
  const expected = encodeUnsignedTransaction(intent);
  const expectedDecoded = decodeTransactionPayload(expected.payload);
  if (canonicalView(decoded) !== canonicalView(expectedDecoded)) {
    throw new EvmCodecError(
      'intent_mismatch',
      '载荷字段与原未签名交易意图不一致',
    );
  }
}
