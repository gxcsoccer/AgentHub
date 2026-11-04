# 权限、持久事件、检索与托管接入

[English](EXTENSIONS.md)

## 按调用方授权

owner token 保留完整权限。通过 `serve --access-file /private/access.json` 配置独立调用方；配置和 token 文件必须是用户私有普通文件（POSIX 0600），相对 token 路径按配置文件目录解析。token 唯一、至少 32 个非空白字符，不写入回执。

```json
{
  "callers": [
    {
      "id": "reviewer",
      "tokenFile": "reviewer.token",
      "grants": [
        {
          "harness": "codex",
          "instance": "local",
          "sessions": ["allowed-native-session-id"],
          "operations": ["read", "send"]
        }
      ]
    }
  ]
}
```

省略 sessions 表示整个实例，空列表不授权会话。操作分为 read、send、attach、approve、manage、prompt。创建需要整个实例的 manage，用户输入需要 prompt。发送权限不包含审批或恢复权限。有限会话授权的发现只读取名单内会话。

HTTP 根据 token 确定调用方，不能通过请求体冒充。回执、幂等 ID 归创建者所有，owner 可查看全部。受限 SSE 只返回该调用方、当前授权目标的回执事件；原生适配器事件仅 owner 可见。replyTo 在提交和重启后的转发中都检查两端发送权限。修改策略后重启生效；撤权不自动取消已经提交给后端的工作。共享不透明事件游标会体现日志进度，不包含其他调用方正文。相同 OS 用户的恶意进程不在隔离范围内。

基础库通过 `new AgentHub(adapters, { callers })` 注入策略，通过 `createHubServer({ hub, token, callers })` 单独注入凭证。进程内方法默认 owner，不能用于隔离同进程的不可信代码。给每个 MCP 进程配置独立受限 token。

## 持久事件

SQLite schema 2 会事务迁移 schema 1。回执变化与对应 message.status 事件原子提交，重启保留事件 epoch 和 sequence。日志仍限制 2,000 条／4 MiB；过旧或其他存储的游标明确报错。消费者自己保存游标并重连，没有消费组或 exactly-once 承诺。ephemeral 模式仍为进程内事件。待审批请求不持久化，断线期间未观察到的原生事件不能补造。写盘失败会拒绝继续，也可能无法保存 storage.error 事件。

## 统一全文检索

`GET /v1/search`、`client.search(address, { search, cursor?, limit? })`、CLI search 和 MCP search_history 使用同一接口，按单个授权会话，对标准化历史正文进行大小写不敏感的字面子串匹配。会话名称、cwd 等元数据查询仍用 list_sessions。

每次最多扫描十页原生历史；空结果仍可能带 nextCursor，必须继续到 null 才到末尾。游标绑定调用方、地址和查询，结果保留原生 item。不建立共享私有历史索引，不支持排序相关性、正则或跨历史变化的快照。所有后端读取前先检查 read 权限。

## ACP v1 托管会话

使用官方 `@agentclientprotocol/sdk` 2.4.0 的稳定 v1。配置可执行文件后，仅在显式 createSession 时启动进程，不经 shell；不会 attach、load 或并发 resume 已有工作会话。HTTP 调用方不能替换可执行文件。

```json
{
  "codex": false,
  "claude": false,
  "acp": [{ "instance": "managed", "command": "/absolute/path/to/acp-agent", "args": [] }]
}
```

SDK 提供 createSession、prompt、cancel；HTTP 为 POST /v1/sessions、/v1/prompts、/v1/session/cancel；CLI 为 create、prompt --message-file、cancel。prompt 必须显式 delivery:user_input，需要独立权限，不允许自动转发。普通 send 和面向 agent 的 MCP 不会将 peer 内容升级为用户输入。

流式文本在 end_turn 时形成关联回复，其他结束原因保留在 native 中。不自动认证、重启或恢复进程。prompt 断线／超时标记不确定；prompt 超时会关闭本库拥有的整个 agent 进程，也会影响该进程其他托管会话。默认 prompt 超时 60 秒；若配置更长时间，需要相应调整 HTTP 超时，遇到请求超时后按原 ID 查回执。

审批沿用 interaction 接口，显式选择后端给出的 optionId 或取消；超时、取消和关闭都取消待审批请求。客户端不提供文件系统和终端执行能力，但 ACP 本身不是执行沙箱，后端自身执行权限仍由所有者配置。托管历史每会话最多 200 条／1 MiB 文本、最多 100 个会话，仅保存在当前进程，不是原生历史恢复。

`session/new` 失败不会关闭共享后端，也不会中断已有 prompt 和审批。明确的无效请求、方法不存在、参数错误或需要认证的拒绝允许后续再次创建。超时、内部错误或无效结果可能掩盖已创建的原生会话，因此阻止后续创建，返回 `acp_creation_blocked`，会话 metadata 标记 `sessionCreationBlocked: true`。连接仍在时，已知会话继续可用。处理完这些会话后，daemon／HTTP 用户须显式重启 Hub daemon 才能继续创建；基础库用户须关闭并用新 adapter 重建 Hub。当前没有原地 reset／替换接口，也不会自动重启或重放。持有实例级 `manage` 的调用方可通过慢请求或失败请求触发该阻断，影响该实例所有调用方的新建操作，已知会话仍可用。仅向可信运维调用方授予 `manage`；需要独立可用性时使用独立实例。[真实后端验收](ACCEPTANCE.zh-CN.md) 将实际 Claude／Codex ACP 模型回复与协议测试进程的结果分开记录。

官方来源：[初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[prompt](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)。

## Windows 范围

支持 HTTP 客户端、MCP 客户端入口和 ACP 托管进程。Windows 守护进程须显式 `--ephemeral`，并通过私有 AGENTHUB_TOKEN 提供凭证；POSIX 私有 SQLite 和凭证文件加载器会拒绝 Windows。未提供 Windows Codex UDS 接入。

实验性 ClaudePipeAdapter（配置项 claudeWindows）接收所有者提供的 sessionId、pipe、token，必须 experimental:true。先写 auth 帧，再写 prompting 身份的 peer 帧；不读取其他进程凭证，不猜地址，不启动会话。写入成功不能证明认证或收件成功，回执只到 transport_written。Windows 原生回调回复和历史不支持；会话详情不返回 token，配置必须按秘密保护。

Windows CI 使用真实 Windows 命名管道和 ACP fixture 子进程，但不等于 Windows Claude 模型真实收发验收。私有消息帧兼容性仍需隔离 Windows 模型验收后才能解除实验标记。认证首帧依据 [Claude 官方跨会话文档](https://code.claude.com/docs/en/cross-session-messaging)。
