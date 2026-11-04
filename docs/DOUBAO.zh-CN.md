# 豆包接入

本版已实现本地 JSON CLI 和 MCP stdio 入口。豆包 OpenAPI Adapter 与 MCP Events 服务尚未实现，也没有自动修改豆包配置。

## 首次本地验证

1. 编译项目，使用 `examples/local.json` 启动 Hub 守护进程。
2. 修改 `examples/mcp.json` 的绝对路径，在独立豆包测试环境中配置本地 stdio MCP。该模板不应作为官方远程 MCP 插件包直接发布。
3. 在测试对话中调用 `list_sessions` 查找 Claude，再用 `get_session` 确认测试目标支持 `peer_message`。只选择专用测试会话。
4. 用新 UUID 调用 `send_message`，发送固定测试内容；用同一 UUID 调用 `get_message_status` 等待回复，确认结果回到同一豆包对话。
5. `held/rejected/unknown` 必须如实报告，不改变接收策略、不恢复会话、不换新 ID 静默重试。

官方 MCP 客户端测试证明本地入口可用，但不能代替上述豆包运行时验收。当前尚未完成豆包实测。

用户提供的资料记录了本地 stdio MCP 此前可运行；[官方 MCP 文档](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-server-development) 目前规定远程 HTTPS MCP。两者范围不同。[CLI 连接器](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/cli-connector) 官方明确在 PC 本地执行，可以调用本项目 CLI。项目尚未声明已发布 npm 包或通过商店校验的插件包。

## 后续适配方向

| 路径          | 范围                                          | 边界                                                            |
| ------------- | --------------------------------------------- | --------------------------------------------------------------- |
| Agent OpenAPI | 应用创建的会话、消息/历史、中断、单次回复 SSE | user.message 代表用户；忙碌返回 409；任意已有会话访问未确认     |
| MCP Events    | 用户确认的事件订阅，执行保存的任务            | 预览规范；远程 MCP 和签名公网 HTTPS 回调；2xx 不表示任务完成    |
| 应用 JS API   | 当前 UI/Worker 关联会话                       | sendFollowUpMessage 是用户输入；updateModelContext 不触发新轮次 |

原文：[OpenAPI 前置条件](https://open.doubao.com/document/doubao-developer-guide/openapi-call-flow)、[应用会话范围](https://open.doubao.com/document/uAjLw4CM/ukTMukTMukTM/doubao/agent-v1/session/list)、[事件语义](https://open.doubao.com/document/uAjLw4CM/ukTMukTMukTM/doubao/agent-v1/session-event/event-overview)、[MCP Events](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-events)、[对话 JS API](https://open.doubao.com/document/plugin-docs-center/build/interface-development/conversation-js-api)。

OpenAPI 需要应用、权限及 user_access_token，必须明确声明用户输入身份。未来 Events Adapter 可以发出“有新消息”事件，由已授权任务调用读取工具取得正文，再发关联回复。订阅/任务地址不能直接当作任意已有会话的 attach。

资料还记录 MCP Apps 无法访问办公网。云端事件服务不能假设可直接访问本机 Codex/Claude socket；未来中继需要本地 Hub 显式连接并限制消息访问范围。
