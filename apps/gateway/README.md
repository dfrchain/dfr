# @dfr/gateway

DFR 唯一公开 HTTP 进程。Gateway 是薄横切层，不实现链语义和交易状态机。

当前路由：healthz、chains、balance、block、transaction/receipt。M1 写路由见
`docs/architecture/m1-api-contract.md`。

固定处理顺序：requestId → auth/scope → body limit → route/rate → idempotency → validation → Core → response。

修改路由时必须同步 OpenAPI、SDK、Gateway 测试、E2E 与 requestId 封套。
不要引入 Web 框架，除非现有 node:http 管线出现无法维护的实证并经 ADR 裁决。

本地运行见 `docs/runbooks/m0-local.md`。
