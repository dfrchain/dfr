/**
 * 有界 JSON 请求体解析（DFR-M1-B06，gateway-spec 第 3 章第 7 步"契约校验"）。
 *
 * 三条不能省的约束：
 * 1. **声明与实际两个方向都要设限**：`content-length` 可以缺失或撒谎，
 *    因此流式累积时必须自己计数；只在 header 上检查等于没有检查；
 * 2. **拒绝非对象**：`null` / 数组 / 标量都不是合法的请求体，不能等到 handler
 *    里 `body.chain` 抛 TypeError 变成 500；
 * 3. **错误里不带原文**：非法 JSON 的片段可能含敏感内容，只报字段名与稳定错误码
 *    （error-spec 第 6 章）。
 */
import type { IncomingMessage } from 'node:http';
import { createDfrError } from '@dfr/errors';
import type { RequestId } from '@dfr/types';

export interface ReadJsonBodyOptions {
  /** 体积上限（字节）。调用方按配置传入，本模块不读环境变量。 */
  readonly maxBytes: number;
  readonly requestId: RequestId;
}

/** 读取并解析有界 JSON 对象；任何失败都抛 DFR 错误，由 Gateway 统一映射状态码。 */
export async function readJsonBody(
  req: IncomingMessage,
  options: ReadJsonBodyOptions,
): Promise<Record<string, unknown>> {
  const { maxBytes, requestId } = options;
  // An invalid configured limit must never silently disable stream accounting.
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }

  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(requestId, maxBytes);
  }

  const raw = await readBounded(req, maxBytes, requestId);
  if (raw.trim() === '') {
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
      message: '请求体不能为空：需要 JSON 对象',
      details: { fields: ['body'] },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // 不把原文放进错误详情：非法片段可能包含凭证或私钥。
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
      message: '请求体不是合法 JSON',
      details: { fields: ['body'] },
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
      message: '请求体必须是 JSON 对象',
      details: { fields: ['body'] },
    });
  }
  return parsed as Record<string, unknown>;
}

async function readBounded(
  req: IncomingMessage,
  maxBytes: number,
  requestId: RequestId,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
    total += buf.length;
    if (total > maxBytes) {
      // 超限即停止读取，避免继续缓冲攻击流量。
      req.destroy();
      throw tooLarge(requestId, maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tooLarge(requestId: RequestId, maxBytes: number): Error {
  return createDfrError('DFR_PAYLOAD_TOO_LARGE', {
    requestId,
    message: `请求体超过上限 ${maxBytes} 字节`,
    details: { maxBytes },
  });
}
