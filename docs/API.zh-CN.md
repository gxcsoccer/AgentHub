# 接口

统一接口需要 `Authorization: Bearer <token>`，服务只绑定本地回环地址。浏览器 Origin 默认拒绝，可通过 `createHubServer` 显式放行。完整契约为 [openapi.json](../openapi.json)，也可访问 `/openapi.json`。

| 方法 | 路径                           | 用途                                |
| ---- | ------------------------------ | ----------------------------------- |
| GET  | `/v1/instances`                | 实例及当前事件游标                  |
| POST | `/v1/session/attach-reply`     | 所有者显式建立 Codex 回复监听       |
| GET  | `/v1/sessions`                 | 会话发现与搜索                      |
| GET  | `/v1/session`                  | 会话详情和能力                      |
| GET  | `/v1/history`                  | 保留原生身份的历史分页              |
| POST | `/v1/messages`                 | 显式指定身份语义的外部消息          |
| GET  | `/v1/messages/{messageId}`     | 回执；`waitMs` 最大 60,000          |
| GET  | `/v1/events`                   | SSE；支持 `after` / `Last-Event-ID` |
| GET  | `/v1/interactions`             | 待显式回答的 Codex 请求             |
| POST | `/v1/interactions/{requestId}` | `{ "result": <原生响应> }`          |

会话查询使用 `harness`、`instance`（默认 local），详情/历史再加 `sessionId`。分页支持 `limit`（1–100）、`cursor`、`search`。Claude 的会话搜索仅搜索元数据，历史搜索查日志正文。Codex 统一历史搜索暂不支持，完整原生 `searchOccurrences` 保留在独立 Bridge 接口，不能混同这些搜索范围。

核心地址是不透明的三元组；适配器分别验证原生 UUID。游标必须绑定原实例、会话和查询。

消息必填 `messageId`（UUID）、`to`、`origin.name`、`delivery`、`text`。可选 `origin.session`、`correlationId`、`inReplyTo`、`replyTo`、`expiresAt`（默认一小时）、`hopCount`（0–8）。来源是归因信息，不是远程身份认证。未知字段不传给后端。可选回复路由只转发首个关联回复，转发拥有独立回执。

HTTP 202 只表示返回了回执，必须检查其状态：

| 状态              | 证据                                |
| ----------------- | ----------------------------------- |
| pending           | 已保留提交记录                      |
| transport_written | socket 写入完成，未确认原生接收     |
| accepted          | 后端接受操作                        |
| held              | 接收策略暂存                        |
| received          | 原生回执确认向会话释放/交付         |
| replied           | Hub 收到关联回复                    |
| rejected          | 原生拒收、过期或丢弃，细节在 native |
| failed            | 确定失败                            |
| unknown           | 投递结果不确定，不应盲目重发        |

同 UUID、相同规范化载荷复用同一次尝试，包括失败；不同载荷返回 409。配置 store（守护进程默认开启）后，保留期内跨重启仍有效。提交中断后的记录转为带 `process_restarted` 的 `unknown`，不自动重发。回复与固定转发 ID 在转发前提交；已保存转发意图但尚未保留子消息的，可以在启动后执行一次；已保留的子消息不会重放。模型回复不代表业务完成。

`POST /v1/session/attach-reply` 接受 `{ "address": { "harness": "codex", "instance": "local", "sessionId": "..." }, "acceptResumeRace": true }`，SDK 对应 `attachReplyRoute(address, { acceptResumeRace: true })`。会话详情包含 `replyReadiness` 的 `state/tool/listener/reason`。未加载、子会话或无法核验工具时拒绝 attach。该操作在 loaded 检查后显式调用无配置覆盖的 `thread/resume`，期间若发生卸载可能恢复会话；上游没有 subscribe-only API。此所有者操作不在 agent-facing MCP 中。就绪不保证模型一定调用回复工具。

同一状态文件只允许一个守护进程；第二个返回 `store_in_use`，不支持的 schema 和损坏状态拒绝恢复。写盘失败使 Hub 返回 503，并尝试报告 `storage.error`，不会触发重发。Claude 启动时恢复未过期的关联并复用原回调地址；遇到仍活跃或被替换的端点拒绝接管。Codex 恢复关联 ID，但新连接仍需所有者显式 attach。事件随 SQLite 持久化，待审批请求仍只在进程内保存。

SSE 的 `message.status` 包含回执快照，`adapter.event` 包含当前连接观察到的原生事件；`ready` 给出游标，`gap` 表示消费者过慢。存储事件字段是 `id/type/timestamp/sessionId/turnId/data`，其中 sessionId 是复合地址编码，不是原生 UUID。回放有界，游标过期明确报错。订阅 SSE 不会隐式恢复后端会话，也不是任意会话的完整审计日志。

审批必须由所有者按上游 schema 显式回答，不从 peer 内容推断批准。MCP 不暴露审批接口。不支持的能力返回 501/422。

独立的 [Codex Bridge API](../vendor/codex-bridge/docs/API.zh-CN.md) 保留原有 22 个操作，其 UUID 路由和用户输入语义仅适用于该接口。

## 客户端诊断

`HarnessHubClient.doctor({ scope?, sessionId? })` 组合现有 GET 接口，没有新增 HTTP 路由或 MCP 工具。`sessionId` 必须配合 `{ harness, instance }`。报告包含 `schemaVersion:1`、`checkedAt`、`readOnly:true`、`deliveryTested:false`、总体 `status` 和逐项 `checks`。每项有 `id/status/code/message` 及可选 `scope/details`；状态为 `ok/warning/error`，整体取最严重项。默认只发现，指定目标才检查发送与回复前置条件。

诊断最多并发 4 个实例，最多检查前 32 个；每个实例只读取 limit=10 的第一页并显式报告 hasMore。一个实例失败不会跳过其他实例。报告不包含名称、cwd、正文、token 或原始后端错误。CLI doctor 每请求默认 10 秒；通用 fetch 客户端新增可选 `timeoutMs`（整数 1..120000，默认仍为 70000），不自动重试；该超时用于 JSON 请求，SSE 仍使用调用方提供的 signal。CLI 退出码 0/2/1 对应 ok/warning/error；令牌文件缺失或参数错误走原有 stderr 错误路径，不创建令牌或启动服务。

新增调用方权限、持久事件语义、全文检索和显式托管接口见[扩展说明](EXTENSIONS.zh-CN.md)。
