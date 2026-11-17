# @dfr/errors

统一错误构造、元数据、HTTP RFC 9457 映射、requestId 与脱敏。

- 所有对外异常通过 `createDfrError()` 或 `toDfrError()` 归一化。
- 错误码来源：`@dfr/types`；HTTP/重试语义来源：`src/metadata.ts`。
- 上层不得把已分类错误重新分类。
- `details` 必须经过深度/键名/文本脱敏；错误不得包含端点凭证、API Key、私钥或 payload。

验证：`pnpm vitest run packages/errors/test/errors.test.ts`。
