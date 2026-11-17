/**
 * 最小 base58 编解码（Bitcoin/Solana 字母表），零依赖（ADR-028）。
 *
 * 用 BigInt 累加/取余：实现直接、边界清晰；地址/签名/区块哈希都很短，性能无关紧要。
 * 编解码成对存在是 M3-A02 的要求：编解码往返是 codec 的主要验证手段。
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX: ReadonlyMap<string, number> = new Map(
  ALPHABET.split('').map((char, index) => [char, index]),
);
const BASE = 58n;

/** base58 解码为字节；非法字符返回 null（不抛错，由调用方决定错误语义）。 */
export function base58Decode(value: string): Uint8Array | null {
  if (value === '') return null;
  let num = 0n;
  for (const char of value) {
    const digit = INDEX.get(char);
    if (digit === undefined) return null;
    num = num * BASE + BigInt(digit);
  }
  // 去掉 BigInt 前导零字节，再按原串前导 '1' 逐个补回。
  const body: number[] = [];
  while (num > 0n) {
    body.push(Number(num & 0xffn));
    num >>= 8n;
  }
  body.reverse();
  let leadingZeros = 0;
  for (const char of value) {
    if (char !== '1') break;
    leadingZeros += 1;
  }
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...body]);
}

export function isBase58(value: string): boolean {
  return value !== '' && [...value].every((char) => INDEX.has(char));
}

/** base58 编码；空字节数组返回空串。 */
export function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % BASE)]! + out;
    num /= BASE;
  }
  // 每个前导零字节编码为 '1'（与解码端的补零逻辑互逆）。
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros += 1;
  }
  return '1'.repeat(leadingZeros) + out;
}
