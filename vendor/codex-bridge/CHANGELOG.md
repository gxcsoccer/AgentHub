# Changelog / 变更日志

## 0.1.0 — Unreleased / 未发布

- Local REST API and fetch SDK for an existing Codex App Server.
- Session listing/detail/search, history pagination, attributed messages, steering, context, interruption, lifecycle, SSE and explicit interaction responses.
- Private bearer token, explicit CORS, bounded buffers, process-local idempotency, honest reconnect/gap semantics.
- Generated OpenAPI 3.1, English/Chinese documentation, MIT license and CI configuration.
- Unit, transport, HTTP, SDK, contract and simulated full-stack tests; optional real read-only smoke probe.
- Opt-in real-session message smoke probe; live submission, streaming completion, idempotency, history and search verified on 2026-11-04.
- Isolated real-model acceptance: all 22 API operations covered by 25 checks, with thread ownership guards and cleanup; documented empty-preview listing and startup-interruption boundaries.

- 面向已有 Codex App Server 的本地 REST API 与 fetch SDK。
- 会话列表/详情/搜索、历史分页、带来源消息、steer、上下文、中断、生命周期、SSE 与显式交互回复。
- 私有 Bearer token、显式 CORS、有界缓冲、进程内幂等、明确的重连和事件缺口语义。
- 生成式 OpenAPI 3.1、中英文文档、MIT 许可证与 CI 配置。
- 单元、传输、HTTP、SDK、契约与模拟全链路测试，可选真实只读冒烟。
- 手动启用的真实会话收发冒烟；2026-11-04 已验证真实提交、流式完成、幂等、历史与搜索。
- 隔离的真实模型验收：25 项检查覆盖全部 22 个 API 操作，带测试会话归属限制和清理；记录空预览列表过滤与启动中断边界。

Native MultiAgentV2 mailbox delivery, durable receipts and multi-backend routing are not included. / 不包含原生 MultiAgentV2 mailbox 投递、持久回执或多后端路由。
