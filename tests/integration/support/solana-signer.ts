/**
 * D02 测试专用：用本地 Solana keypair 对未签名交易签名（**仅测试**）。
 *
 * 为什么在测试里：DFR 的服务端**从不**接触私钥（ADR-007/009）。真实写链的签名必须由
 * 外部钱包完成；D02 为了端到端验收，用一个**本地测试账户**扮演"外部签名者"。
 *
 * 实现：Node 内置 `crypto` 的 ed25519（无新增依赖）。Solana 的 keypair 文件是 64 字节
 * `[32 字节 seed || 32 字节 pubkey]`；用 seed 构造 PKCS8 私钥即可签 message 字节。
 *
 * 只读取 env 指定的路径，绝不打印私钥或 seed。
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';

/** Solana ed25519 PKCS8 的固定前缀（从 raw 32 字节 seed 构造私钥）。 */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface LocalSolanaKeypair {
  /** base58 公钥（用于断言 / fee payer）。 */
  readonly publicKeyBytes: Uint8Array;
  /** 对 message 字节签名，返回 64 字节签名。 */
  sign(message: Uint8Array): Uint8Array;
}

/** 从 `solana-keygen` 生成的 JSON 文件读取 keypair。路径来自 env，不回显到日志。 */
export function loadSolanaKeypair(path: string): LocalSolanaKeypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error('Solana keypair 文件必须是 64 字节数组');
  }
  const seed = Buffer.from(raw.slice(0, 32));
  const pub = Buffer.from(raw.slice(32));
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const derivedPub = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (!derivedPub.equals(pub)) {
    throw new Error('keypair 的 seed 与 pubkey 不匹配（文件损坏？）');
  }
  return {
    publicKeyBytes: Uint8Array.from(pub),
    sign: (message) => Uint8Array.from(edSign(null, Buffer.from(message), privateKey)),
  };
}
