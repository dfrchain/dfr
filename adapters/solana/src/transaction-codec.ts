/**
 * Solana 交易编解码纯函数（DFR-M3-A02）。
 *
 * 权威来源：ADR-028（供应链）、ADR-032（blockhash 是排序前提）、
 * `docs/architecture/adapter-spec-v0.1.md` §8.2、EVM 版 `adapters/evm/src/transaction-codec.ts`。
 *
 * 设计约束（与 EVM codec 同构）：
 *   1. **零新增依赖**（ADR-028）：不引入 `@solana/web3.js`。这里只做 legacy / v0
 *      message 的二进制编解码，用仓库已有的 base58 工具；不实现 ed25519、不实现 RPC。
 *   2. **数值一律十进制字符串 / 字节**：不出现 JS `number` 作为金额或高度；
 *      compact-u16 只在"计数"这种必然很小的量上使用，不做数值语义。
 *   3. **输入校验 fail-closed**：非法 base64 / base58、错误长度、越界账户下标、
 *      版本不支持，一律抛 `SolanaCodecError`，不静默纠正。
 *   4. 纯函数：不发网络请求、不读私钥、不持有端点或凭证。
 *
 * 边界：本模块只做编解码与结构比较，**不**选 Provider、不写数据库、不决定交易状态。
 * address table lookup 需要链访问（解析 ALT 账户），本卡 fail-closed 拒绝，留待后续。
 */

import { base58Decode, base58Encode } from './base58.js';

/** 支持的 message 版本（ADR-032 / Solana 交易格式）。 */
export type SolanaTransactionVersion = 'legacy' | 'v0';

/** 稳定的失败原因码；Adapter 负责把它归一化为对外 DFR 错误。 */
export type SolanaCodecErrorReason =
  | 'invalid_base64'
  | 'invalid_base58'
  | 'invalid_address'
  | 'invalid_blockhash'
  | 'invalid_hex_data'
  | 'unsupported_version'
  | 'invalid_payload'
  | 'truncated'
  | 'invalid_compact_u16'
  | 'invalid_header'
  | 'account_index_out_of_range'
  | 'too_many_accounts'
  | 'address_table_lookup_unsupported'
  | 'intent_mismatch';

export class SolanaCodecError extends Error {
  override readonly name = 'SolanaCodecError';
  readonly reason: SolanaCodecErrorReason;
  readonly field?: string;

  constructor(reason: SolanaCodecErrorReason, message: string, field?: string) {
    super(message);
    this.reason = reason;
    if (field !== undefined) this.field = field;
  }
}

/** 32 字节公钥 / blockhash 的字节长度。 */
const PUBKEY_BYTES = 32;
/** 64 字节 ed25519 签名。 */
const SIGNATURE_BYTES = 64;
/** legacy message 头部长度。 */
const HEADER_BYTES = 3;
/** account keys 下标是 u8，因此最多 256 个。 */
const MAX_ACCOUNTS = 256;
/** v0 版本前缀：首字节高位置 1，低 7 位是版本号。 */
const VERSION_PREFIX = 0x80;
const V0 = 0;

/**
 * 一条指令里某个账户的角色（决定 header 与账户排序）。
 *
 * 与 Solana `AccountMeta` 对齐；这是构造合法 message 的最小信息，缺了它无法推导
 * header 的三个计数，也无法确定账户顺序。
 */
export interface SolanaAccountMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface SolanaInstructionIntent {
  readonly programId: string;
  readonly accounts?: readonly SolanaAccountMeta[];
  /** 指令数据；base64（省略等价于空数据）。 */
  readonly data?: string;
}

/** 未签名交易意图。`feePayer` 必定是第一个签名者（Solana 规则）。 */
export interface SolanaUnsignedIntent {
  readonly feePayer: string;
  readonly blockhash: string;
  readonly instructions: readonly SolanaInstructionIntent[];
  /** 默认 `legacy`；`v0` 会写入版本前缀并附加空的 ALT lookup 段。 */
  readonly version?: SolanaTransactionVersion;
}

/** 编译后的 message（可被外部钱包签名的字节）。 */
export interface SolanaCompiledMessage {
  readonly version: SolanaTransactionVersion;
  /** message 字节（= 需要签名的部分）。 */
  readonly messageBytes: Uint8Array;
  readonly accountKeys: readonly string[];
  readonly header: SolanaMessageHeader;
  readonly recentBlockhash: string;
  readonly numRequiredSignatures: number;
}

export interface SolanaMessageHeader {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
}

/** 已解码交易（可来自未签名载荷或已签名载荷）。 */
export interface SolanaDecodedTransaction {
  readonly version: SolanaTransactionVersion;
  readonly signed: boolean;
  /** 签名的 base58 表示（64 字节）；未签名时为 64 字节零的 base58。交易哈希 = 第 0 个。 */
  readonly signatures: readonly string[];
  /** 账户表（含 program id）；顺序与 message 一致。 */
  readonly accountKeys: readonly string[];
  readonly header: SolanaMessageHeader;
  readonly recentBlockhash: string;
  readonly instructions: readonly SolanaDecodedInstruction[];
  /** 非空时表示带 ALT lookup（本卡 fail-closed，不会出现）。 */
  readonly addressTableLookups: number;
}

export interface SolanaDecodedInstruction {
  readonly programIdIndex: number;
  readonly programId: string;
  readonly accountIndices: readonly number[];
  /** base64 编码的指令数据。 */
  readonly data: string;
}

/* ------------------------------------------------------------------ */
/* base64（Node Buffer）                                               */
/* ------------------------------------------------------------------ */

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(value: string, field: string): Uint8Array {
  // Buffer 对非法 base64 宽容（会丢弃非法字符），因此必须回环重编码校验，
  // 否则会静默接受垃圾输入。允许末尾 padding 的等价写法。
  const canonical = (text: string): string => text.replace(/=+$/u, '');
  const buf = Buffer.from(value, 'base64');
  if (canonical(buf.toString('base64')) !== canonical(value)) {
    throw new SolanaCodecError('invalid_base64', `不是合法的 base64：${field}`, field);
  }
  return Uint8Array.from(buf);
}

/* ------------------------------------------------------------------ */
/* compact-u16（Solana 变长计数）                                      */
/* ------------------------------------------------------------------ */

function encodeCompactU16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new SolanaCodecError('invalid_compact_u16', `compact-u16 越界：${value}`);
  }
  if (value < 0x80) return Uint8Array.from([value]);
  if (value < 0x4000) {
    return Uint8Array.from([(value & 0x7f) | 0x80, (value >> 7) & 0xff]);
  }
  return Uint8Array.from([(value & 0x7f) | 0x80, ((value >> 7) & 0x7f) | 0x80, (value >> 14) & 0xff]);
}

function decodeCompactU16(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let index = 0; index < 3; index += 1) {
    if (cursor >= bytes.length) {
      throw new SolanaCodecError('truncated', 'compact-u16 读取越界');
    }
    const byte = bytes[cursor]!;
    value |= (byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  throw new SolanaCodecError('invalid_compact_u16', 'compact-u16 超过 3 字节');
}

/* ------------------------------------------------------------------ */
/* base58 <-> 定长字节                                                 */
/* ------------------------------------------------------------------ */

function decodeFixed(value: string, size: number, reason: 'invalid_address' | 'invalid_blockhash', field: string): Uint8Array {
  if (value.length === 0) {
    throw new SolanaCodecError(reason, `${field} 不能为空`, field);
  }
  const bytes = base58Decode(value);
  if (bytes === null || bytes.length !== size) {
    throw new SolanaCodecError(reason, `${field} 不是合法的 base58/${size} 字节`, field);
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* message 编译                                                        */
/* ------------------------------------------------------------------ */

interface AccountEntry {
  readonly pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
  /** 是否是 program id（非签名、只读，必须排在只读非签名组）。 */
  isProgramId: boolean;
}

/**
 * 收集并规范化账户表。
 *
 * Solana 规则：签名者在前（fee payer 必须第一个），其后是可写非签名者，
 * 最后是只读非签名者（program id 属于这一类）。同一 pubkey 合并，权限取"并集"
 * （任一指令要求可写/签名，则该账户整体可写/签名）。
 */
function collectAccounts(intent: SolanaUnsignedIntent): AccountEntry[] {
  const map = new Map<string, AccountEntry>();
  const ensure = (pubkey: string): AccountEntry => {
    const existing = map.get(pubkey);
    if (existing !== undefined) return existing;
    const created: AccountEntry = { pubkey, isSigner: false, isWritable: false, isProgramId: false };
    map.set(pubkey, created);
    return created;
  };

  // fee payer：必须是签名者且可写（它支付费用）。
  const payer = ensure(intent.feePayer);
  payer.isSigner = true;
  payer.isWritable = true;

  for (const instruction of intent.instructions) {
    for (const meta of instruction.accounts ?? []) {
      const entry = ensure(meta.pubkey);
      if (meta.isSigner) entry.isSigner = true;
      if (meta.isWritable) entry.isWritable = true;
    }
    ensure(instruction.programId).isProgramId = true;
  }

  return [...map.values()];
}

function orderAccounts(entries: readonly AccountEntry[], feePayer: string): AccountEntry[] {
  const signers = entries.filter((e) => e.isSigner);
  // fee payer 必须排第一（Solana 规则）；其余签名者：先可写后只读。
  signers.sort((a, b) => {
    if (a.pubkey === feePayer) return -1;
    if (b.pubkey === feePayer) return 1;
    return Number(b.isWritable) - Number(a.isWritable);
  });
  const writableNonSigners = entries.filter((e) => !e.isSigner && e.isWritable);
  const readonlyNonSigners = entries.filter((e) => !e.isSigner && !e.isWritable);
  return [...signers, ...writableNonSigners, ...readonlyNonSigners];
}

export function compileMessage(intent: SolanaUnsignedIntent): SolanaCompiledMessage {
  const version = intent.version ?? 'legacy';
  if (version !== 'legacy' && version !== 'v0') {
    throw new SolanaCodecError('unsupported_version', `不支持的 message 版本：${String(version)}`);
  }
  if (intent.instructions.length > 0xffff) {
    throw new SolanaCodecError('invalid_payload', 'instruction 数量超过 compact-u16 上限');
  }

  const ordered = orderAccounts(collectAccounts(intent), intent.feePayer);
  if (ordered.length > MAX_ACCOUNTS) {
    throw new SolanaCodecError('too_many_accounts', `账户数 ${ordered.length} 超过 ${MAX_ACCOUNTS}`);
  }
  const indexOf = new Map(ordered.map((entry, index) => [entry.pubkey, index]));

  const numRequiredSignatures = ordered.filter((e) => e.isSigner).length;
  const readonlySigned = ordered.slice(0, numRequiredSignatures).filter((e) => !e.isWritable).length;
  const readonlyUnsigned = ordered.slice(numRequiredSignatures).filter((e) => !e.isWritable).length;
  const header: SolanaMessageHeader = {
    numRequiredSignatures,
    numReadonlySignedAccounts: readonlySigned,
    numReadonlyUnsignedAccounts: readonlyUnsigned,
  };

  const chunks: Uint8Array[] = [];
  if (version === 'v0') chunks.push(Uint8Array.from([VERSION_PREFIX | V0]));
  chunks.push(Uint8Array.from([numRequiredSignatures, readonlySigned, readonlyUnsigned]));
  chunks.push(encodeCompactU16(ordered.length));
  for (const entry of ordered) {
    chunks.push(decodeFixed(entry.pubkey, PUBKEY_BYTES, 'invalid_address', 'accountKeys'));
  }
  chunks.push(decodeFixed(intent.blockhash, PUBKEY_BYTES, 'invalid_blockhash', 'recentBlockhash'));
  chunks.push(encodeCompactU16(intent.instructions.length));
  for (const instruction of intent.instructions) {
    const programIndex = indexOf.get(instruction.programId);
    if (programIndex === undefined) {
      throw new SolanaCodecError('invalid_payload', '指令的 programId 未进入账户表');
    }
    const accounts = instruction.accounts ?? [];
    chunks.push(Uint8Array.from([programIndex]));
    chunks.push(encodeCompactU16(accounts.length));
    for (const meta of accounts) {
      const index = indexOf.get(meta.pubkey);
      if (index === undefined) {
        throw new SolanaCodecError('invalid_payload', '指令账户未进入账户表');
      }
      chunks.push(Uint8Array.from([index]));
    }
    const data = instruction.data === undefined ? new Uint8Array() : fromBase64(instruction.data, 'instruction.data');
    chunks.push(encodeCompactU16(data.length));
    chunks.push(data);
  }
  // v0 必须携带 address table lookup 段；本卡只产出**空** lookup。
  if (version === 'v0') chunks.push(encodeCompactU16(0));

  return {
    version,
    messageBytes: concat(chunks),
    accountKeys: ordered.map((e) => e.pubkey),
    header,
    recentBlockhash: intent.blockhash,
    numRequiredSignatures,
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 产出未签名交易载荷：**带签名槽位**的完整交易（签名为 64 个零字节）。
 *
 * 为什么不是裸 message：外部钱包既可能接受完整交易（Web3.js
 * `serialize({ requireAllSignatures: false })` 的形态），也需要拿到确切的 message 字节；
 * 带零槽位的完整交易两者都覆盖（去掉签名前缀即得到 message）。
 */
export function encodeUnsignedTransaction(intent: SolanaUnsignedIntent): {
  readonly payload: string;
  readonly encoding: 'base64';
  readonly message: SolanaCompiledMessage;
} {
  const message = compileMessage(intent);
  const prefix = concat([
    encodeCompactU16(message.numRequiredSignatures),
    ...Array.from({ length: message.numRequiredSignatures }, () => new Uint8Array(SIGNATURE_BYTES)),
  ]);
  const payload = concat([prefix, message.messageBytes]);
  return { payload: toBase64(payload), encoding: 'base64', message };
}

/** 从完整交易载荷中剥离签名段，返回 message 字节与是否已签名。 */
export function splitSignatures(payload: Uint8Array): {
  readonly signatures: readonly Uint8Array[];
  readonly messageBytes: Uint8Array;
} {
  const count = decodeCompactU16(payload, 0);
  let offset = count.next;
  const signatures: Uint8Array[] = [];
  for (let index = 0; index < count.value; index += 1) {
    if (offset + SIGNATURE_BYTES > payload.length) {
      throw new SolanaCodecError('truncated', '签名段越界');
    }
    signatures.push(payload.slice(offset, offset + SIGNATURE_BYTES));
    offset += SIGNATURE_BYTES;
  }
  return { signatures, messageBytes: payload.slice(offset) };
}

/** 解码完整交易载荷（未签名或已签名均可）。 */
export function decodeTransactionPayload(payload: string): SolanaDecodedTransaction {
  const bytes = fromBase64(payload, 'payload');
  if (bytes.length === 0) {
    throw new SolanaCodecError('invalid_payload', '载荷为空');
  }
  const { signatures, messageBytes } = splitSignatures(bytes);
  const message = decodeMessage(messageBytes);
  if (signatures.length !== message.header.numRequiredSignatures) {
    throw new SolanaCodecError(
      'invalid_header',
      `签名数量 ${signatures.length} 与 header 要求的 ${message.header.numRequiredSignatures} 不一致`,
    );
  }
  // SOL-01: every required signature slot must be populated. A nonzero
  // co-signer slot must never mask a missing fee-payer signature (slot 0).
  // This checks presence only; Ed25519 validity remains a chain-side check.
  const signed = signatures.length > 0 && signatures.every((sig) => sig.some((byte) => byte !== 0));
  return {
    version: message.version,
    signed,
    signatures: signatures.map((sig) => base58Encode(sig)),
    accountKeys: message.accountKeys,
    header: message.header,
    recentBlockhash: message.recentBlockhash,
    instructions: message.instructions,
    addressTableLookups: message.addressTableLookups,
  };
}

/** 解码 message 字节（不含签名段）。 */
export function decodeMessage(bytes: Uint8Array): {
  readonly version: SolanaTransactionVersion;
  readonly accountKeys: readonly string[];
  readonly header: SolanaMessageHeader;
  readonly recentBlockhash: string;
  readonly instructions: readonly SolanaDecodedInstruction[];
  readonly addressTableLookups: number;
} {
  let offset = 0;
  let version: SolanaTransactionVersion = 'legacy';
  const first = bytes[0];
  if (first === undefined) throw new SolanaCodecError('truncated', 'message 为空');
  if ((first & VERSION_PREFIX) !== 0) {
    const versionNumber = first & 0x7f;
    if (versionNumber !== V0) {
      throw new SolanaCodecError('unsupported_version', `不支持的 message 版本号：${versionNumber}`);
    }
    version = 'v0';
    offset = 1;
  }
  if (offset + HEADER_BYTES > bytes.length) {
    throw new SolanaCodecError('truncated', 'header 越界');
  }
  const numRequiredSignatures = bytes[offset]!;
  const numReadonlySignedAccounts = bytes[offset + 1]!;
  const numReadonlyUnsignedAccounts = bytes[offset + 2]!;
  offset += HEADER_BYTES;
  if (numReadonlySignedAccounts > numRequiredSignatures) {
    throw new SolanaCodecError('invalid_header', '只读签名账户数不能超过签名账户数');
  }

  const accountCount = decodeCompactU16(bytes, offset);
  offset = accountCount.next;
  if (accountCount.value === 0 || accountCount.value > MAX_ACCOUNTS) {
    throw new SolanaCodecError('too_many_accounts', `账户数非法：${accountCount.value}`);
  }
  const accountKeys: string[] = [];
  for (let index = 0; index < accountCount.value; index += 1) {
    if (offset + PUBKEY_BYTES > bytes.length) {
      throw new SolanaCodecError('truncated', 'account keys 越界');
    }
    accountKeys.push(base58Encode(bytes.slice(offset, offset + PUBKEY_BYTES)));
    offset += PUBKEY_BYTES;
  }

  if (offset + PUBKEY_BYTES > bytes.length) {
    throw new SolanaCodecError('truncated', 'recent blockhash 越界');
  }
  const recentBlockhash = base58Encode(bytes.slice(offset, offset + PUBKEY_BYTES));
  offset += PUBKEY_BYTES;

  const instructionCount = decodeCompactU16(bytes, offset);
  offset = instructionCount.next;
  // 先**结构解析**（跳过指令、收集下标），暂不做下标越界校验：
  // v0 的 account index 可以引用 address table lookup 载入的账户，而 lookup 段在
  // 指令段之后。必须先读到 lookup 计数，才能判断"下标越界"是错误还是 ALT 语义。
  const rawInstructions: Array<{
    programIdIndex: number;
    accountIndices: number[];
    data: string;
  }> = [];
  for (let index = 0; index < instructionCount.value; index += 1) {
    if (offset >= bytes.length) {
      throw new SolanaCodecError('truncated', 'instruction 越界');
    }
    const programIdIndex = bytes[offset]!;
    offset += 1;
    const accountIndexCount = decodeCompactU16(bytes, offset);
    offset = accountIndexCount.next;
    const accountIndices: number[] = [];
    for (let accountIndex = 0; accountIndex < accountIndexCount.value; accountIndex += 1) {
      if (offset >= bytes.length) {
        throw new SolanaCodecError('truncated', 'instruction account index 越界');
      }
      accountIndices.push(bytes[offset]!);
      offset += 1;
    }
    const dataLength = decodeCompactU16(bytes, offset);
    offset = dataLength.next;
    if (offset + dataLength.value > bytes.length) {
      throw new SolanaCodecError('truncated', 'instruction data 越界');
    }
    const data = toBase64(bytes.slice(offset, offset + dataLength.value));
    offset += dataLength.value;
    rawInstructions.push({ programIdIndex, accountIndices, data });
  }

  let addressTableLookups = 0;
  if (version === 'v0') {
    const lookups = decodeCompactU16(bytes, offset);
    offset = lookups.next;
    addressTableLookups = lookups.value;
    if (addressTableLookups > 0) {
      // 解析 ALT 需要额外账户表数据（链访问），本卡不做，显式拒绝而不是假装成功。
      throw new SolanaCodecError(
        'address_table_lookup_unsupported',
        '带 address table lookup 的 v0 交易需要链上账户表解析，M3-A02 不支持',
      );
    }
  }
  if (offset !== bytes.length) {
    throw new SolanaCodecError('invalid_payload', `message 尾部有 ${bytes.length - offset} 个多余字节`);
  }

  // 到这里已知没有任何 ALT：所有下标都必须落在静态账户表内。
  const instructions: SolanaDecodedInstruction[] = rawInstructions.map((raw) => {
    if (raw.programIdIndex >= accountKeys.length) {
      throw new SolanaCodecError(
        'account_index_out_of_range',
        `programIdIndex 越界：${raw.programIdIndex}`,
      );
    }
    for (const accountIndex of raw.accountIndices) {
      if (accountIndex >= accountKeys.length) {
        throw new SolanaCodecError(
          'account_index_out_of_range',
          `instruction account index 越界：${accountIndex}`,
        );
      }
    }
    return {
      programIdIndex: raw.programIdIndex,
      programId: accountKeys[raw.programIdIndex]!,
      accountIndices: raw.accountIndices,
      data: raw.data,
    };
  });

  return {
    version,
    accountKeys,
    header: { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts },
    recentBlockhash,
    instructions,
    addressTableLookups,
  };
}

/** hex → 字节（EVM 风格调用方偶尔会传 hex；Solana 指令数据用 base64）。 */
export function hexToBytes(value: string, field: string): Uint8Array {
  if (!/^(?:0x)?[0-9a-fA-F]*$/u.test(value)) {
    throw new SolanaCodecError('invalid_hex_data', `不是合法 hex：${field}`, field);
  }
  const body = value.startsWith('0x') ? value.slice(2) : value;
  if (body.length % 2 !== 0) {
    throw new SolanaCodecError('invalid_hex_data', `hex 长度为奇数：${field}`, field);
  }
  const out = new Uint8Array(body.length / 2);
  for (let index = 0; index < body.length; index += 2) {
    out[index / 2] = Number.parseInt(body.slice(index, index + 2), 16);
  }
  return out;
}
