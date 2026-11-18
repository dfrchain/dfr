# @dfr/errors

Unified error construction, metadata, HTTP RFC 9457 mapping, requestId, and redaction.

- All outward-facing exceptions are normalized through `createDfrError()` or `toDfrError()`.
- Error codes come from `@dfr/types`; HTTP/retry semantics come from `src/metadata.ts`.
- Upper layers must not reclassify an already classified error.
- `details` must pass depth/key-name/text redaction; errors must not contain endpoint credentials, API keys, private keys, or payloads.

Verify with: `pnpm vitest run packages/errors/test/errors.test.ts`.
