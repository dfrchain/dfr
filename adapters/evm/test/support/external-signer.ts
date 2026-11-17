/**
 * 外部签名测试辅助（DFR-M1-E03 前置）。
 *
 * 为什么放在 adapter 的 test/ 下：`viem` 只能存在于 `adapters/evm`（ADR-016 §2，
 * 由 tests/contract/module-boundaries.test.ts 的 "只有 adapters/evm 可以依赖 viem" 守卫）。
 * E2E 需要"调用方自己的签名器"来构造真实签名，但不能为此把 viem 加进 `tests` 包。
 * 因此把签名辅助留在 viem 已声明的包内，由 E2E 相对路径引用。
 *
 * 该文件只被测试引用，不进入生产导出面（`src/index.ts` 不导出它）。
 */
import { keccak256, toBytes } from 'viem';
import { privateKeyToAddress, signTransaction } from 'viem/accounts';
import { decodeTransactionPayload } from '../../src/transaction-codec.js';

/** 运行时从标签派生测试私钥：仓库内不出现私钥字面量。 */
export function deriveTestPrivateKey(label: string): `0x${string}` {
  return keccak256(toBytes(label));
}

export function addressOf(privateKey: `0x${string}`): string {
  return privateKeyToAddress(privateKey);
}

/** `keccak256(已签名载荷)` = 真实端点返回的交易哈希。 */
export function transactionHashOf(signedPayload: string): string {
  return keccak256(signedPayload as `0x${string}`);
}

export interface ExternalSignature {
  readonly signedPayload: `0x${string}`;
  readonly expectedHash: string;
}

/**
 * 模拟"调用方自己的签名器"：把 build 产出的未签名 EIP-1559 载荷解回字段，
 * 用给定私钥重新签名。
 *
 * `overrides` 用于构造**绑定不一致**的负对照：签名本身合法，但字段与 DFR 记录不符，
 * 必须被 Adapter 的 `bindSignedTransaction` 拒绝且不发出广播。
 */
export async function signUnsignedPayload(input: {
  readonly unsignedPayload: string;
  readonly privateKey: `0x${string}`;
  readonly chainId: number;
  readonly overrides?: { readonly nonce?: bigint; readonly to?: string; readonly value?: bigint };
}): Promise<ExternalSignature> {
  const decoded = decodeTransactionPayload(input.unsignedPayload);
  if (decoded.signed) {
    throw new Error('signUnsignedPayload: 期望未签名载荷，但输入已带签名');
  }
  if (decoded.to === null) {
    throw new Error('signUnsignedPayload: 测试不支持合约创建（to 为空）');
  }
  const nonce = input.overrides?.nonce ?? BigInt(decoded.nonce);
  // viem 当前签名入参的 nonce 类型是 number；测试用的 nonce 远小于 2^53，
  // 但仍显式校验，避免把"静默丢精度"带进测试辅助。
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('signUnsignedPayload: nonce 超出安全整数范围');
  }
  const signedPayload = await signTransaction({
    privateKey: input.privateKey,
    transaction: {
      chainId: input.chainId,
      nonce: Number(nonce),
      to: (input.overrides?.to ?? decoded.to) as `0x${string}`,
      value: input.overrides?.value ?? BigInt(decoded.value),
      data: decoded.data as `0x${string}`,
      gas: BigInt(decoded.gas),
      maxFeePerGas: BigInt(decoded.maxFeePerGas ?? '0'),
      maxPriorityFeePerGas: BigInt(decoded.maxPriorityFeePerGas ?? '0'),
      type: 'eip1559',
    },
  });
  return { signedPayload, expectedHash: keccak256(signedPayload as `0x${string}`) };
}
