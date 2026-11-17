# @dfr/transaction（M1 计划模块）

本目录在 M1-A 才建立 workspace 包。它将拥有状态机、Store 端口、幂等协调、nonce 协调与确认跟踪。

它只依赖 `@dfr/types` 与 `@dfr/errors`，不依赖 Gateway、具体 Adapter、Provider Manager 或数据库驱动。
具体任务从 `DFR-M1-A04` 开始，未经任务领取不要提前创建脚手架。
