# API 参考

[English](API.md) · [中文说明](../README.zh-CN.md) · [OpenAPI 3.1](../openapi.json)

默认地址：`http://127.0.0.1:3210`。所有资源（包括 `/openapi.json`）都需要 `Authorization: Bearer <token>`。请求体使用 `application/json`，未知字段会被拒绝。接口版本放在 `/v1`；1.0 之前的次版本仍可能调整契约。

URL 中的 `sessionId` 是 **Codex thread UUID**。会话、历史和搜索结果保留上游字段，SDK 不会将所有 Codex 消息与工具类型重新归一化。

## 发现与历史

| HTTP | 路径                                       | 返回值 / 参数                                                                          |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET  | `/v1/capabilities`                         | Bridge 版本、连接状态、操作列表、事件游标和幂等范围                                    |
| GET  | `/v1/sessions`                             | `{data: Thread[], nextCursor, backwardsCursor?}`                                       |
| GET  | `/v1/sessions/loaded`                      | `{data: string[], nextCursor}`，仅当前后端已加载的 thread ID                           |
| GET  | `/v1/sessions/search?q=report`             | `{data: [{thread, snippet}], nextCursor, backwardsCursor?}`                            |
| GET  | `/v1/sessions/{sessionId}`                 | `{thread}` 元数据，不恢复会话                                                          |
| GET  | `/v1/sessions/{sessionId}/turns`           | `{data: Turn[], nextCursor, backwardsCursor?}`                                         |
| GET  | `/v1/sessions/{sessionId}/items`           | `{data: [{turnId, item, startedAtMs?, completedAtMs?}], nextCursor, backwardsCursor?}` |
| GET  | `/v1/sessions/{sessionId}/search?q=report` | `{data: Occurrence[], nextCursor}`                                                     |

分页接口都支持不透明的 `cursor` 和 1–100 的 `limit`。省略参数时采用后端默认值；`nextCursor: null` 表示结束。游标应与原接口、查询和过滤条件一起保存，不要自行解析。接口返回 `backwardsCursor` 时，可用于反转 `sortDirection` 后的分页。

会话列表支持 `cwd`、`searchTerm`、`archived`、`currentAccountOnly`、`sortKey`（`created_at`、`updated_at`、`recency_at`）、`sortDirection`（`asc`、`desc`）。跨会话搜索支持相同参数，但不接受 `cwd`、`searchTerm`，改用必填的 `q`。布尔查询参数只能写 `true` / `false`。跨会话搜索依赖 Codex 索引，最新写入可能尚未入索引，也需要后端版本支持搜索接口。

轮次分页支持 `sortDirection`、`itemsView`（`notLoaded`、`summary`、`full`）；消息分页支持 `sortDirection`、`turnId`。首版只接受不透明的消息游标，不接受上游对象形式的 item anchor。会话内搜索对可见用户/助手文本做不区分大小写的字面子串匹配，`snippetMatchRange` 是 **UTF-16 code unit 偏移**，`turnCursor` 可用于定位对应轮次。它不是针对全部工具载荷或文件的搜索。

`capabilities.operations` 表示 Bridge 实现的路由，不保证任意 Codex 版本都支持对应方法。上游不支持时返回 `501 codex_error`。

Codex 的普通列表会排除预览为空的 thread。新建会话或刚 fork、只有继承历史的会话，可能可以按 ID 读取，却没有出现在 `/sessions` 中，取消归档后也一样。完成其首轮显式用户输入后，再检查普通列表可见性。这是上游过滤行为，不代表取消归档失败或索引延迟；归档列表仍可能包含这些会话。

## 通信

`POST /v1/sessions/{sessionId}/messages` 必须提供 `Idempotency-Key` 请求头，长度 1–128。

```json
{
  "source": "DeskMind",
  "text": "构建已完成，请检查结果。",
  "mode": "start"
}
```

`source` 必填，长度 1–64，仅允许 ASCII 字母、数字、`.`、`_`、`-`。普通用户输入会带上 `[External app: DeskMind]\n...` 前缀；这个字段是调用方声明的标签，不是经过认证的应用身份。`text` 不可为空，最多 100,000 字符；JSON 请求体最多 1 MiB。

```json
{
  "status": "accepted",
  "sessionId": "00000000-0000-0000-0000-000000000001",
  "turnId": "turn-from-codex",
  "messageId": "caller-idempotency-key",
  "source": "DeskMind",
  "mode": "start"
}
```

HTTP `202` 表示 Codex 接受了输入，不代表任务成功。默认 `mode: start` 调用 `turn/start`，上游在已有活动轮次时也可能将其作为 steer 处理。需要严格指定活动轮次时，传 `mode: steer` 和 `expectedTurnId`；轮次过期会失败，不会退化成启动新任务。start 模式不允许带 `expectedTurnId`。

目标必须在所连接后端内已加载，消息接口不会恢复会话。子 agent 的直接输入会被拒绝，应向根 thread 发送。没有实现原生 MultiAgentV2 mailbox 投递。

同一个 key 和载荷在本进程中共享一次提交，在处理结束后的 24 小时内返回同一回执或错误；换目标/载荷复用 key 返回 `409 idempotency_conflict`。最多保留 10,000 条，满额返回 `429`。重启后回执丢失。写请求超时或断线时，`details.deliveryUnknown: true` 表示结果不确定，应先查历史，不要直接换 key 重发。

| HTTP | 路径                                 | 请求体 / 效果                                                                   |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------- |
| POST | `/v1/sessions/{sessionId}/context`   | `{source,text}`；以用户角色注入 `[External context: source]` 上下文，不启动轮次 |
| POST | `/v1/sessions/{sessionId}/interrupt` | `{turnId}`；请求中断指定轮次，返回 `202`                                        |

上下文是否显示在界面上，取决于对应客户端对注入项的渲染；它不是 agent 邮件，也不会唤醒空闲 agent。只有消息提交具备 Bridge 幂等保证。

中断针对活动轮次。`turn/start` 接受回执可能早于后端注册活动任务，立即中断可能收到 `409` 和 `no active turn to interrupt`；轮次已经结束时也可能返回同样错误。应结合轮次事件和状态判断，不能把“接受输入”当作“已经可以中断”。Bridge 不会改为无目标的启动取消，也不会换一个轮次自动重试。

## 生命周期

| HTTP  | 路径                                 | 请求体 / 效果                               |
| ----- | ------------------------------------ | ------------------------------------------- |
| POST  | `/v1/sessions`                       | 可选 `{cwd,model}`，创建 thread，返回 `201` |
| POST  | `/v1/sessions/{sessionId}/attach`    | 检查已加载状态，再通过 `thread/resume` 订阅 |
| POST  | `/v1/sessions/{sessionId}/resume`    | 显式恢复或连接 thread                       |
| POST  | `/v1/sessions/{sessionId}/detach`    | 取消此 Bridge 连接的订阅                    |
| POST  | `/v1/sessions/{sessionId}/fork`      | 可选 `{lastTurnId}`，分叉历史，返回 `201`   |
| PATCH | `/v1/sessions/{sessionId}`           | `{name}`，非空且最多 200 字符               |
| POST  | `/v1/sessions/{sessionId}/archive`   | 归档，Codex 可能卸载会话                    |
| POST  | `/v1/sessions/{sessionId}/unarchive` | 恢复会话列表可见性                          |

上游没有单纯订阅的方法。attach 的加载检查与 resume 不是原子操作，中间如果会话被卸载，仍可能触发恢复。新 WebSocket 连接不会继承旧订阅。创建或恢复使用 Codex 现有配置；API 不接受绕过审批、覆盖沙箱配置或任意 JSON-RPC 方法。

## 事件与恢复

`GET /v1/events?sessionId=<uuid>&after=<cursor>` 返回 SSE，两个参数都可省略。也可以用 `Last-Event-ID` 请求头代替 `after`，查询参数优先。Bearer 鉴权需要 `fetch` 或本 SDK，浏览器原生 `EventSource` 构造器不能直接设置该请求头。

观察现有会话前需显式 attach。**先打开 SSE 并等到 ready，再发消息**，或者使用先前保存的游标。查询历史、打开 SSE 都不会自动 attach。

```text
event: ready
data: {"cursor":"process-epoch:0","connected":true}

id: process-epoch:1
event: response.delta
data: {"id":"process-epoch:1","type":"response.delta","sessionId":"thread-uuid","turnId":"turn-id","timestamp":"2026-11-04T00:00:00.000Z","data":{"threadId":"thread-uuid","turnId":"turn-id","delta":"你好"}}

```

命名事件包括：`turn.started`、`turn.completed`、`response.delta`、`session.status`、`item.started`、`item.completed`、`request.pending`、`request.responded`、`request.expired`、`bridge.connected`、`bridge.disconnected`。其他通知保留为 `codex.<将原方法的斜杠换成点>`，`data` 是上游参数。轮次结束也可能意味着失败或中断，要检查 `data.turn.status` 和 `data.turn.error`。

最多缓存 2,000 条 / 4 MiB 事件，按当前进程接收顺序回放，不是持久事件日志。过滤会话后仍会收到 `sessionId: null` 的全局事件。每 15 秒心跳，慢客户端会被断开，最多 64 条流。过期游标或其他进程的游标返回 `409`。关闭事件流不会中断轮次。

收到 `bridge.disconnected` 后应认为存在事件缺口。重连后重新读取详情/历史、显式 attach，再打开事件流。缓存回放无法补回后端断线期间的事件。写请求、审批和订阅均不会自动重放。

## 审批与提问

`GET /v1/requests?sessionId=<uuid>` 返回本连接收到且尚未解决的请求：

```json
{
  "data": [
    {
      "id": "bridge-request-uuid",
      "method": "item/commandExecution/requestApproval",
      "sessionId": "thread-uuid",
      "params": { "threadId": "thread-uuid", "command": "npm test" }
    }
  ]
}
```

通过 `POST /v1/requests/{requestId}/response` 回复，`result` / `error` 必须且只能提供一个。result 格式由上游具体方法决定，应保留原始字段，并显式收集用户选择。

```json
{ "result": { "decision": "decline" } }
```

```json
{ "error": { "code": -32000, "message": "应用无法处理此请求" } }
```

HTTP `202 {status: "submitted", requestId}` 仅表示已转发。请求五分钟后以错误过期，被其他客户端处理后移除，断线后失效；重复回复返回 `404`，最多保留 128 条。Bridge 不会自行批准命令或代答问题。

## 错误

```json
{
  "error": {
    "code": "session_not_loaded",
    "message": "Session is not loaded in this Codex instance; resume it explicitly"
  }
}
```

| 状态码    | 常见含义                                                    |
| --------- | ----------------------------------------------------------- |
| 400       | 非法参数、JSON/游标错误，或上游参数校验失败                 |
| 401 / 403 | 缺少有效 token / 浏览器来源未允许                           |
| 404       | 路由不存在，或请求已不再等待回复                            |
| 409       | 目标未加载/不支持输入、幂等冲突、过期游标或上游前置条件失败 |
| 413 / 415 | 请求体过大 / Content-Type 错误                              |
| 429       | RPC、回执或事件流达到容量限制                               |
| 501       | 上游不支持对应方法                                          |
| 502       | 其他上游拒绝                                                |
| 503 / 504 | 后端不可用/断线，或请求超时                                 |

SDK 抛出 `BridgeApiError`，包含 `status`、`code`、可选 `details`，不会自动重试。上游较宽泛的 `-32600` 会映射到 `409`，应同时阅读错误消息。
