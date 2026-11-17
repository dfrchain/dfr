/**
 * EVM 签名载荷解析与绑定（DFR-M1-C01）。
 *
 * 权威来源：ADR-016 §7、docs/architecture/m1-api-contract.md 第 3 节。
 *
 * 广播前必须从 `signedPayload` **重新推导**而不是相信调用方声明：
 *   - chainId / nonce / to / value / data / 费用字段 / accessList：RLP 逐字段还原；
 *   - txHash：`keccak256(signedPayload)`；
 *   - from：对签名做 secp256k1 公钥恢复（`recoverTransactionAddress`）。
 * 调用方提供的 `expectedHash` **只作比较**，不是真相来源（m1-api-contract §3）。
 *
 * 设计约束（与 transaction-codec.ts 一致）：
 *   1. 只使用 Viem 纯工具（`recoverTransactionAddress`）。不出现 client / transport /
 *      account / wallet，既不持有私钥也不持有端点。
 *   2. 不使用 `parseTransaction`：它把 nonce / chainId 降级为 JS `number`，
 *      与本仓库"数值一律十进制字符串"的红线冲突（ADR-016 §2）。
 *   3. 失败一律 `EvmCodecError` + 稳定 `reason`；错误信息**不含签名原文或任何载荷
 *      片段**，只报字段名与原因。
 *   4. 返回值是脱敏投影：不含 signedPayload / signature / r / s / v，
 *      键名也不含 "payload" 或 "signed"，避免调用方顺手把签名原文写进日志或数据库。
 *
 * 边界：本模块是纯函数（签名恢复不需要网络）。不选 Provider、不广播、不写库、不决定状态。
 */

import { recoverTransactionAddress } from 'viem';
import type { AccountRef, ChainId, DecimalUint } from '@dfr/types';
import { isEvmAddress } from './address.js';
import { decodeTransactionPayload, EvmCodecError } from './transaction-codec.js';
import type {
  EvmAccessListEntry,
  EvmDecodedTransaction,
  EvmTransactionType,
} from './transaction-codec.js';

/** 签名载荷的脱敏投影。**刻意不含** signedPayload / 签名标量（r/s/v/yParity）。 */
export interface EvmSignedTransactionBinding {
  readonly type: EvmTransactionType;
  readonly chainId: DecimalUint;
  readonly from: AccountRef;
  readonly nonce: DecimalUint;
  /** null 表示合约创建（`to` 为空）。 */
  readonly to: AccountRef | null;
  readonly value: DecimalUint;
  /** 调用数据（`0x` 表示原生转账）。 */
  readonly data: string;
  readonly gas: DecimalUint;
  readonly accessList: readonly EvmAccessListEntry[];
  /** 由载荷重算的交易哈希。 */
  readonly txHash: string;
}

/** 绑定比较的真值：全部来自交易记录，不来自签名请求。 */
export interface EvmSignedBindingExpectation {
  readonly chain: ChainId;
  /** Registry 中该链的 externalChainId（十进制字符串）。 */
  readonly expectedChainId: DecimalUint;
  /** 记录里的发送方（unsigned 载荷不含 from，唯一来源是记录）。 */
  readonly from: AccountRef;
  /** 记录里保存的**未签名**载荷：字段级比较的真值。 */
  readonly unsignedPayload: string;
  /** 调用方声明的哈希；只作比较。 */
  readonly expectedHash?: string;
}

/** 逐项比较的标量字段顺序（`field` 报告第一个不一致的字段）。 */
const COMPARED_FIELDS = [
  'type',
  'chainId',
  'nonce',
  'to',
  'value',
  'gas',
  'data',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

function scalarOf(tx: EvmDecodedTransaction, field: ComparedField): string | null {
  const value = tx[field];
  return value === undefined ? null : String(value);
}

/** viem 对序列化载荷的联合类型；本模块只做字符串到该类型的收窄。 */
type SerializedTransaction = Parameters<
  typeof recoverTransactionAddress
>[0]['serializedTransaction'];

/** 解码 + 签名校验 + 发送方恢复；parse 与 bind 共用同一实现，避免两套判定漂移。 */
async function decodeSigned(
  signedPayload: string,
): Promise<{ readonly decoded: EvmDecodedTransaction; readonly from: string }> {
  // decodeTransactionPayload 已完成 hex / RLP / 字段数 / 交易类型的严格校验，
  // 并把数值还原为十进制字符串（全程不经 JS number）。
  const decoded = decodeTransactionPayload(signedPayload);

  if (!decoded.signed) {
    throw new EvmCodecError('not_signed', '载荷不含签名，不能作为广播输入');
  }
  if (decoded.chainId === null) {
    throw new EvmCodecError(
      'chain_id_unknown',
      '无法从载荷推导 chainId（pre-EIP-155 签名），拒绝广播',
      'chainId',
    );
  }

  let recovered: string;
  try {
    recovered = await recoverTransactionAddress({
      // 载荷形状已由 decodeTransactionPayload 严格校验（前缀 + RLP 字段数）。
      serializedTransaction: signedPayload as SerializedTransaction,
    });
  } catch {
    // 不转发底层异常：它的 message 可能包含签名原文。
    throw new EvmCodecError('invalid_signature', '无法从签名恢复发送方地址', 'from');
  }

  return { decoded, from: recovered.toLowerCase() };
}

function toBinding(
  chain: ChainId,
  decoded: EvmDecodedTransaction,
  from: string,
  chainId: DecimalUint,
): EvmSignedTransactionBinding {
  return {
    type: decoded.type,
    chainId,
    from: { chain, address: from },
    nonce: decoded.nonce,
    to: decoded.to === null ? null : { chain, address: decoded.to },
    value: decoded.value,
    data: decoded.data,
    gas: decoded.gas,
    accessList: decoded.accessList,
    txHash: decoded.hash,
  };
}

/**
 * 解析已签名载荷，重新推导全部广播前必须核对的事实。
 *
 * 未签名、chainId 不可推导（pre-EIP-155）、签名无法恢复一律 fail-closed。
 */
export async function parseSignedTransaction(
  chain: ChainId,
  signedPayload: string,
): Promise<EvmSignedTransactionBinding> {
  const { decoded, from } = await decodeSigned(signedPayload);
  return toBinding(chain, decoded, from, decoded.chainId as DecimalUint);
}

/**
 * 校验签名载荷与保存的未签名交易逐项一致，并返回脱敏投影。
 *
 * 比较真值是**记录里的 unsigned payload**，不是调用方在请求里声明的字段：
 * 客户端"换参数但复用同一 transactionId"不能通过（m1-api-contract §3）。
 */
export async function bindSignedTransaction(
  signedPayload: string,
  expectation: EvmSignedBindingExpectation,
): Promise<EvmSignedTransactionBinding> {
  // 记录里的发送方来自我们自己的库；不合法说明记录被污染，按期望值非法 fail-closed。
  // 这里刻意不抛 DFR_* 错误：本模块是纯函数，错误构造点归属 Adapter 层（ADR-009）。
  if (!isEvmAddress(expectation.from.address)) {
    throw new EvmCodecError(
      'invalid_expectation',
      '记录中的发送方不是合法的 EVM 地址',
      'from',
    );
  }
  if (expectation.from.chain !== expectation.chain) {
    throw new EvmCodecError(
      'invalid_expectation',
      '记录中的发送方 chain 与请求 chain 不一致',
      'from',
    );
  }

  const { decoded, from } = await decodeSigned(signedPayload);
  const chainId = decoded.chainId as DecimalUint;

  if (chainId !== expectation.expectedChainId) {
    throw new EvmCodecError(
      'chain_id_mismatch',
      '签名载荷的 chainId 与目标链不一致',
      'chainId',
    );
  }
  if (from !== expectation.from.address.toLowerCase()) {
    throw new EvmCodecError(
      'sender_mismatch',
      '签名载荷恢复出的发送方与交易记录不一致',
      'from',
    );
  }

  const unsigned = decodeTransactionPayload(expectation.unsignedPayload);
  if (unsigned.signed) {
    throw new EvmCodecError(
      'invalid_expectation',
      '记录里的 unsigned payload 实际已带签名，拒绝作为比较真值',
      'unsignedPayload',
    );
  }

  for (const field of COMPARED_FIELDS) {
    if (scalarOf(unsigned, field) !== scalarOf(decoded, field)) {
      throw new EvmCodecError(
        'unsigned_payload_mismatch',
        '签名载荷与保存的未签名交易不一致',
        field,
      );
    }
  }
  if (JSON.stringify(unsigned.accessList) !== JSON.stringify(decoded.accessList)) {
    throw new EvmCodecError(
      'unsigned_payload_mismatch',
      '签名载荷与保存的未签名交易的 accessList 不一致',
      'accessList',
    );
  }

  if (
    expectation.expectedHash !== undefined &&
    expectation.expectedHash.toLowerCase() !== decoded.hash.toLowerCase()
  ) {
    throw new EvmCodecError(
      'expected_hash_mismatch',
      '调用方声明的 expectedHash 与由载荷重算的交易哈希不一致',
      'expectedHash',
    );
  }

  return toBinding(expectation.chain, decoded, from, chainId);
}
