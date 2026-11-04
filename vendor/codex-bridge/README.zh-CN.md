# Codex Session Bridge

[English](README.md) · [API 接入文档](docs/API.zh-CN.md) · [架构](docs/ARCHITECTURE.zh-CN.md) · [OpenAPI](openapi.json)

面向外部应用的本机 HTTP API 和 TypeScript／JavaScript SDK，用于查询、搜索和操作**已经存在的 Codex 会话**。

服务通过 Unix 控制 socket 连接一个运行中的 Codex App Server，提供会话发现、历史读取、消息发送、实时事件，以及审批和提问的回复接口。它不启动另一个 Codex 实例，也不直接编辑会话文件。

**状态：**`0.1.0` 首版实现，尚未发布到 npm。独立开源项目，并非 OpenAI 官方 SDK。

## 能力范围

| 类别     | 已包含                                                       |
| -------- | ------------------------------------------------------------ |
| 发现     | 历史会话列表、已加载线程 ID、详情、游标分页                  |
| 搜索     | 跨会话索引搜索、分页会话内的消息命中位置                     |
| 历史     | 轮次分页、消息与工具调用条目分页                             |
| 通信     | 用户消息发送、运行中追加输入、上下文注入、中断               |
| 生命周期 | 显式创建、订阅、恢复、取消订阅、分叉、重命名、归档与取消归档 |
| 交互     | 查询待处理请求，显式回复审批、提问和工具结果                 |
| 事件     | SSE、文本增量、轮次与条目事件、有限缓存回放、连接中断通知    |
| 集成     | Bearer Token、明确的 CORS 来源、类型化 SDK、OpenAPI 3.1      |

API 路径中的 `sessionId` 指 Codex 的 **thread ID（线程 ID）**。Codex 另有 agent 树共享的 session ID，不能用它替代子线程 ID。

## 快速开始

需要 Node.js 22+、npm，以及已运行并开放控制 socket 的 Codex App Server。本机只读联调已在 macOS、Codex CLI／App Server `0.166.0` 上通过；源码对照版本为 `f2b94ef8b5`（2026-11-04）。旧版本或其他后端可能缺少部分接口。

```sh
git clone https://github.com/gxcsoccer/Codex-MultiAgentV2.git
cd Codex-MultiAgentV2
npm ci
npm run build
npm start
```

HTTP 服务监听 `127.0.0.1:3210`。Token 自动生成在 `~/.codex-session-bridge/token`，权限为 `0600`，启动日志不会打印其内容。

指定另一个已经运行的实例：

```sh
npm start -- --socket /absolute/path/to/app-server-control.sock --port 3211
```

默认 socket 为 `${CODEX_HOME:-~/.codex}/app-server-control/app-server-control.sock`。桌面应用或独立 CLI 可能使用其他实例；这个 API 只能看到所连接后端中的会话。发现 socket 并不代表已经连接到你希望控制的桌面窗口。

```sh
export CODEX_BRIDGE_TOKEN="$(cat "$HOME/.codex-session-bridge/token")"
curl -H "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  'http://127.0.0.1:3210/v1/sessions?limit=20'

curl -H "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  'http://127.0.0.1:3210/v1/sessions/search?q=mailbox&limit=10'
```

通过 `GET /v1/sessions/loaded` 获取已加载线程 ID；通过 `GET /v1/sessions/{sessionId}` 查看选定会话的详情；通过 `/items` 和 `/turns` 分页读取消息与轮次。

## 发送消息

```sh
curl -X POST \
  -H "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: deskmind-event-0001' \
  'http://127.0.0.1:3210/v1/sessions/REPLACE_WITH_THREAD_UUID/messages' \
  -d '{"source":"DeskMind","text":"CI 报告已生成，请检查。","mode":"start"}'
```

返回 `status: "accepted"` 与 `turnId` 表示请求被接收，**不代表任务已经完成**。需要继续观察 `turn.completed`，检查其中的状态、错误和输出。

这类输入属于普通**用户消息**，正文带 `[External app: DeskMind]` 前缀。`source` 是调用方自报的来源标签，不是经过认证的应用身份。本服务没有暴露原生 MultiAgentV2 `send_message`／`followup_task`，也不支持直接向 V2 子 agent 提交用户输入。

## SDK

正式发布前，可从本地源码或打包文件安装：

```sh
npm run build
npm pack
# 在调用方项目中：
npm install /absolute/path/to/codex-session-bridge-0.1.0.tgz
```

```ts
import { CodexBridgeClient } from 'codex-session-bridge';

const client = new CodexBridgeClient({ token: process.env.CODEX_BRIDGE_TOKEN! });
const { data } = await client.loadedSessions();
const threadId = data[0]; // 实际应用应先查看详情，再选择目标会话。
if (!threadId) throw new Error('没有已加载会话');
console.log(await client.detail(threadId));

await client.attach(threadId); // 显式订阅，边界见下文。
let submittedTurnId: string | undefined;
for await (const event of client.events({ sessionId: threadId })) {
  if (event.type === 'ready') {
    const receipt = await client.sendMessage(
      threadId,
      { source: 'DeskMind', text: '请总结目前的发现。' },
      { idempotencyKey: crypto.randomUUID() },
    );
    submittedTurnId = receipt.turnId;
  }
  if (event.type === 'response.delta') process.stdout.write(String(event.data.delta));
  if (event.type === 'turn.completed' && event.turnId === submittedTurnId) break;
}
```

退出事件迭代会取消 HTTP 事件流，不会中断 Codex 任务。要向指定运行轮次追加要求，请使用 `mode: 'steer'` 并传入 `expectedTurnId`。

## 运行边界

- **一个服务连接一个后端。** 这不是跨设备或机器全局的会话目录；多个 Codex 实例需要分别连接，可使用不同 HTTP 端口。
- **发送时不隐式恢复。** 未加载会话返回 `409 session_not_loaded`。`/resume` 显式恢复；`/attach` 先确认会话已加载，再通过上游 `thread/resume` 订阅。如果这两步之间发生卸载，上游仍可能恢复它。Codex 暂无原子的“只订阅”接口。
- **发送语义跟随上游。** `mode: start` 调用 `turn/start`，上游可能将其作为运行中追加输入。需要精确指定当前轮次时，使用 `steer + expectedTurnId`；失败时不会自动改为启动新一轮。
- **幂等有范围。** 相同消息键在同一个服务进程内保留结果或错误 24 小时，包括投递结果不明的失败。最多 10,000 条，不提前淘汰；进程重启后不保留。其他写操作没有幂等保护，不应盲目重试结果不明的写请求。
- **事件有范围。** 先显式订阅现有会话，才能接收其事件。缓存只覆盖本连接已经收到的通知，无法补齐断线期间的数据。游标过期或来自其他进程会返回 `409`；重连会提示数据缺口，并要求显式重新订阅。
- **交互需要明确回复。** 审批和提问不会自动通过；五分钟无人回复后返回错误。回复接口的回执表示已转发，不代表执行已获后端确认。
- **本机可信应用。** Token 允许访问所连接后端的已暴露会话能力，应只交给可信 App。浏览器来源默认禁止，可用 `--allow-origin http://localhost:3000` 显式放行。首版不提供公网或多租户部署。

## 开发与验证

```sh
npm test                 # 编译并运行单元、HTTP、WebSocket 和 SDK 测试
npm run test:coverage
npm run check            # 格式检查、严格 TypeScript 检查、测试
npm run schema           # 从实际路由定义生成 OpenAPI
npm run smoke:readonly   # 可选：真实 Codex 只读联调，不发消息、不恢复会话
```

常规测试使用模拟 Codex 后端，不调用模型。另有真实收发脚本，需要显式指定一个空闲根 thread：发送测试消息，验证流式回复、历史、搜索和幂等，完成后取消本连接订阅。

```sh
npm run smoke:live -- --session YOUR_IDLE_THREAD_UUID --report /private/path/report.json
```

此命令会调用已配置的模型，在选定会话中保留一轮测试对话，不会在 CI 中自动执行。2026-11-04 已在本机现有会话上通过真实收发，耗时约 5.7 秒。

完整隔离验收会自行创建测试会话和临时工作目录，拒绝对其他会话执行写操作，结束后归档并卸载测试会话：

```sh
npm run smoke:isolated -- --run --report .local/verification/full-suite.json
```

此命令会调用真实模型，验证提问/审批与生命周期；审批允许分支**仅允许精确匹配的固定标记打印命令**在测试目录执行，不修改 Codex 全局配置。2026-11-04，**22 个 API 操作的 25 项真实后端检查全部通过**，包括 steer、中断、上下文记忆、审批允许/拒绝、fork、归档/取消归档和恢复。桌面视觉展示不属于本次 API 验收。另见[验收矩阵](docs/VERIFICATION.zh-CN.md)、[兼容性证据](docs/ARCHITECTURE.zh-CN.md#兼容性证据)、[贡献指南](CONTRIBUTING.zh-CN.md)、[安全说明](SECURITY.md)、[变更记录](CHANGELOG.md)。采用 MIT 许可证。
