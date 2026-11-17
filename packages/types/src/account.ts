/**
 * 账户模型（见 docs/architecture/domain-model.md 第 4.2 节）。
 *
 * Alpha 阶段 AccountRef 仅表示地址引用，不涉及账户抽象、Session Key、智能账户。
 * 本模型中不存在也不允许出现私钥、助记词或任何签名凭证字段。
 */
import type { ChainId, DecimalUint } from './primitives.js';

/**
 * 账户引用。
 *
 * 审计修正 A-08：删除了 `network` 字段。网络由 `chain` 唯一决定
 * （`ethereum-sepolia` 必然是 testnet），同时携带两者会让调用方传入矛盾组合，
 * 而旧规范没有定义冲突时的裁决规则。
 */
export interface AccountRef {
  chain: ChainId;
  /** 链原生编码地址；合法性由 Adapter 校验，Core 不做格式假设。 */
  address: string;
  /** 仅部分链使用（如 Cosmos memo/tag）。 */
  memo?: string;
}

export type AccountKind = 'externally-owned' | 'contract' | 'program' | 'unknown';

export interface Account {
  ref: AccountRef;
  kind: AccountKind;
  /** EVM nonce。 */
  nonce?: DecimalUint;
  /** Solana 无 nonce，使用账户数据长度等作为存在性参考。 */
  dataLength?: DecimalUint;
  /** 账户是否已存在（用于识别未初始化账户）。 */
  exists: boolean;
  /** 人类可读标签，仅由调用方/控制面维护，不来自链。 */
  label?: string;
}
