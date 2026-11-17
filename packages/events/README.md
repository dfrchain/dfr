# @dfr/events（M2 计划模块）

M1 的提交后通知由 Transaction Engine 内部接口承载；M2 再评估是否提取本包并对外提供 SSE；
M6 才承诺跨重启重放。

本模块不得提前引入 Kafka/NATS，也不得声称进程内 cursor 可跨重启。事件类型权威来源是 `@dfr/types`。
