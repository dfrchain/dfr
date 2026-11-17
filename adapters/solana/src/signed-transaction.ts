/**
 * Solana 已签名交易的解析与绑定校验（DFR-M3-C01）。
 *
 * 权威来源：m1-api-contract 第 3 节（txHash 由载荷重算）、EVM 版
 * `adapters/evm/src/signed-transaction.ts`（同构，但只做 Solana 能证明的部分）。
 *
 * 与 EVM 的关键差异：Solana **没有账户 nonce**。绑定校验因此比对：
 *   1. 载荷已签名（签名非全零）；
 *   2. fee payer == 记录里的 from；
 *   3. 重算的交易哈希 == 记录的 expectedHash；
 *   4. 记录的 unsigned 载荷（真值）**去掉签名段后的 message** 与签名载荷的 message 逐字节一致。
 *
 * 第 4 条替代了 EVM 的"逐字段比对 nonce/to/value/data"：Solana 的 message 是自描述的，
 * 逐字节相等比逐字段重建更强（连账户顺序、指令数据都覆盖）。
 *
 * 不验证签名本身（那需要 ed25519 + 完整账户解析）；这不是本层的职责，也**不**谎称已做。
 * 真正的最终权威是链：广播后由 `simulateTransaction`/确认路径判断。
 */
import { fromBase64, splitSignatures, decodeTransactionPayload } from './transaction-codec.js';
import type { SolanaDecodedTransaction } from './transaction-codec.js';

export type SolanaBindingErrorReason =
  | 'not_signed'
  | 'invalid_payload'
  | 'sender_mismatch'
  | 'expected_hash_mismatch'
  | 'unsigned_payload_mismatch'
  | 'invalid_expectation';

export class SolanaBindingError extends Error {
  override readonly name = 'SolanaBindingError';
  readonly reason: SolanaBindingErrorReason;

  constructor(reason: SolanaBindingErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface SolanaSignedBindingInput {
  /** 记录里的发送方（fee payer）。 */
  readonly from: string;
  /** 记录里的未签名载荷（真值）。 */
  readonly unsignedPayload: string;
  /** 记录里的 expectedHash（由载荷重算）。 */
  readonly expectedHash: string;
}

export interface SolanaSignedBindingResult {
  /** 由签名载荷重算的交易哈希（第 0 个签名，base58）。 */
  readonly txHash: string;
  readonly decoded: SolanaDecodedTransaction;
}

/** 返回去掉签名段后的 message 字节（base64 输入）。 */
function messageBytesOf(payloadBase64: string): Uint8Array {
  const bytes = fromBase64(payloadBase64, 'payload');
  const { messageBytes } = splitSignatures(bytes);
  return messageBytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * 解析并绑定一笔外部签名的 Solana 交易。
 *
 * 所有失败都抛 `SolanaBindingError`（由 Adapter 归一化为 422 `DFR_TRANSACTION_REJECTED`）。
 */
export function bindSignedTransaction(
  signedPayload: string,
  input: SolanaSignedBindingInput,
): SolanaSignedBindingResult {
  let decoded: SolanaDecodedTransaction;
  try {
    decoded = decodeTransactionPayload(signedPayload);
  } catch (error) {
    throw new SolanaBindingError('invalid_payload', error instanceof Error ? error.message : '载荷解析失败');
  }
  if (!decoded.signed) {
    throw new SolanaBindingError('not_signed', '载荷没有有效签名（签名为全零）');
  }

  const feePayer = decoded.accountKeys[0];
  if (feePayer === undefined || feePayer !== input.from) {
    throw new SolanaBindingError('sender_mismatch', '签名载荷的 fee payer 与记录不一致');
  }

  const txHash = decoded.signatures[0];
  if (txHash === undefined) {
    throw new SolanaBindingError('invalid_payload', '签名载荷没有签名段');
  }
  if (txHash !== input.expectedHash) {
    throw new SolanaBindingError('expected_hash_mismatch', '重算的交易哈希与记录不一致');
  }

  // message 逐字节相等：记录的 unsigned 载荷与签名载荷必须是**同一笔交易**。
  let expectedMessage: Uint8Array;
  try {
    expectedMessage = messageBytesOf(input.unsignedPayload);
  } catch (error) {
    throw new SolanaBindingError(
      'invalid_expectation',
      error instanceof Error ? error.message : '记录的未签名载荷无法解析',
    );
  }
  const actualMessage = messageBytesOf(signedPayload);
  if (!bytesEqual(expectedMessage, actualMessage)) {
    throw new SolanaBindingError('unsigned_payload_mismatch', '签名载荷与记录的未签名载荷不是同一笔交易');
  }

  return { txHash, decoded };
}
