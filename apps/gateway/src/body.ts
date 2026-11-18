/**
 * Bounded JSON request-body parsing (DFR-M1-B06, gateway-spec chapter 3 step 7, "contract validation").
 *
 * Three constraints that cannot be skipped:
 * 1. **Limit both the declared and the actual size**: `content-length` may be missing or lie,
 *    so the streamed accumulation must count by itself; checking only the header is no check at all;
 * 2. **Reject non-objects**: `null` / arrays / scalars are not legal request bodies; the handler must not
 *    wait until `body.chain` throws a TypeError that becomes a 500;
 * 3. **Errors carry no raw text**: fragments of invalid JSON may contain sensitive content, so only the field name and a stable error code are reported
 *    (error-spec chapter 6).
 */
import type { IncomingMessage } from 'node:http';
import { createDfrError } from '@dfr/errors';
import type { RequestId } from '@dfr/types';

export interface ReadJsonBodyOptions {
  /** Size cap (bytes). Passed in by the caller per configuration; this module reads no environment variables. */
  readonly maxBytes: number;
  readonly requestId: RequestId;
}

/** Read and parse a bounded JSON object; any failure throws a DFR error, mapped to a status code centrally by the Gateway. */
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
      message: 'request body must not be empty: a JSON object is required',
      details: { fields: ['body'] },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Do not put raw text into error details: invalid fragments may contain credentials or private keys.
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
      message: 'request body is not valid JSON',
      details: { fields: ['body'] },
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw createDfrError('DFR_VALIDATION_FAILED', {
      requestId,
      message: 'request body must be a JSON object',
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
      // Stop reading as soon as the cap is exceeded, to avoid buffering more attack traffic.
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
    message: `request body exceeds the ${maxBytes} byte limit`,
    details: { maxBytes },
  });
}
