# AgentHub

跨 coding harness 的统一通信基础库。提供 TypeScript 库、本地 HTTP/SSE 服务、fetch SDK、JSON CLI 和 MCP 入口，连接已经运行的 Codex、Claude Code 会话。

[English](README.md) · [接口](docs/API.zh-CN.md) · [设计](docs/DESIGN.zh-CN.md) · [验证](docs/VERIFICATION.zh-CN.md) · [豆包接入](docs/DOUBAO.zh-CN.md) · [待办清单](docs/ROADMAP.zh-CN.md)

下一步设计：[Agent 自动接入与最小感知协作](docs/AGENT_CONNECTOR.zh-CN.md)（正式套件尚未实现；[原生身份](docs/SESSION_IDENTITY_EXPERIMENT.zh-CN.md)、[双向收发](docs/CONNECTOR_ROUNDTRIP_EXPERIMENT.zh-CN.md)及[安装/生命周期](docs/CONNECTOR_LIFECYCLE_EXPERIMENT.zh-CN.md)已有隔离原型证据）。

## 当前实现

| 能力             | Codex                              | Claude Code                                            |
| ---------------- | ---------------------------------- | ------------------------------------------------------ |
| 发现与搜索       | 原生持久会话列表和搜索             | `claude agents --json` 运行中会话；名称/目录搜索       |
| 历史             | 原生条目分页                       | 本地日志分页与搜索，包含忙碌时的 peer 附件             |
| 外部消息         | `turn/start.toolOutput`            | 原生 inbox；2.1.317 / 2.1.318 实验性适配，需要显式开启 |
| 关联回复         | 会话所有者注册 `agenthub_reply`    | 原生 `SendMessage` 返回 Hub socket                     |
| 审批交互         | 库/HTTP 显式回答                   | 当前适配器不支持                                       |
| 任意会话实时订阅 | 不支持；依赖连接已有的原生监听关系 | 不支持；仅自身消息回调                                 |

统一接口明确区分 `tool_output` 和 `peer_message`，不会静默转换成用户输入。读取和发送均不自动启动、恢复、中断或重启会话，也不修改 Claude 的接收策略和权限。

原 Codex Session Bridge 的源码、22 个接口、SDK、OpenAPI、中英文文档及测试完整保留在 `vendor/codex-bridge`。原生生命周期和用户输入接口由独立的 `codex-session-bridge` 命令及 `@gxcsoccer/agenthub/codex-bridge` 导出保留。[来源及许可证](NOTICE)。

## 安装发布包

通过 npm 安装 CLI，需要 Node.js 22.13 或更新版本：

```sh
npm install -g @gxcsoccer/agenthub
agenthub --help
```

0.4.0 新增所有者断开与恢复、消息列表与清空，以及面向嵌入方的 Codex 和 Claude 选项。升级前请停止 Hub 并备份状态目录，连接器进程需与 Hub 同步升级。连接器状态升至版本 4，回滚需要该备份；从 0.1.0 升级仍需遵循[迁移说明](CHANGELOG.md#upgrade-notes--升级说明)。

## 启动

需要 Node.js 22.13+，以及已运行的 Codex App Server 和/或 Claude Code。真实验证平台为 macOS；Windows 客户端、ACP 及实验性单向 pipe 的范围见[扩展说明](docs/EXTENSIONS.zh-CN.md)。

```sh
npm ci
npm run build
npm link
agenthub serve --config examples/local.json
```

示例配置显式开启 Claude 原生发送。不传配置时，Claude 默认只提供发现/历史，发送关闭。Codex 按需连接已有 control socket。服务绑定 `127.0.0.1:3211`，私有令牌保存在 `~/.agenthub/token`，终端仅显示路径。

```sh
agenthub doctor
agenthub instances
agenthub sessions --harness claude
agenthub sessions --harness codex --search AgentHub
agenthub send --message-file /absolute/path/message.json
agenthub status --message-id MESSAGE_UUID --wait-ms 30000
```

消息文件格式如下，实际使用前替换目标 ID，并为新消息生成 UUID：

```json
{
  "messageId": "95054348-8959-413e-89a3-3b98eab598d5",
  "to": { "harness": "claude", "instance": "local", "sessionId": "TARGET_SESSION_UUID" },
  "origin": { "name": "my-app" },
  "delivery": "peer_message",
  "text": "请检查接口方案，并返回关联回复。"
}
```

相同消息 ID 和相同载荷复用一次提交；不同载荷会冲突。`transport_written` 和 `accepted` 不表示模型已读。`replied` 才表示收到了关联回复；不确定投递保留为 `unknown`，不自动重发。

## 只读接入诊断

```sh
agenthub doctor
agenthub doctor --harness codex --session-id SESSION_ID
agenthub doctor --harness claude --instance local --timeout-ms 10000
```

`doctor` 复用现有服务与令牌，只调用 GET。默认检查认证及实例发现；指定会话时检查发送能力和回复前置条件，区分缺少工具、需要 attach、未开启 Claude 发送、版本不匹配及 inbox 不可用。输出 JSON，退出码为 `0` 通过、`2` 提醒、`1` 错误。每个 HTTP 请求默认超时 10 秒；最多检查 32 个实例，并发 4，每个只读取一页 10 条样本，不是全量会话清单。

它不发送探测消息、不建立回调、不检查磁盘写入，也不能证明模型已收到消息或当前 Claude 接收策略。报告省略会话名称、工作目录、正文及原始后端错误。SDK 可使用 `client.doctor({ scope: { harness: 'codex', instance: 'local' }, sessionId })`；SDK 请求超时沿用客户端配置（默认 70 秒）。

## 基础库与回复路由

```ts
import { AgentHub, CodexAdapter, ClaudeAdapter } from '@gxcsoccer/agenthub';

const hub = new AgentHub([
  new CodexAdapter({ instance: 'local' }),
  new ClaudeAdapter({ instance: 'local', nativeMessaging: true }),
]);
try {
  console.log(await hub.listSessions({ harness: 'claude', instance: 'local' }));
} finally {
  await hub.close();
}
```

其他应用使用 `@gxcsoccer/agenthub/client` 中的 `AgentHubClient` 访问本地服务；该导出仅依赖 fetch。CLI/MCP 共用守护进程中的回执和回调监听。

消息可指定 `replyTo`，将第一条关联回复转发到指定会话。转发有独立消息 ID，保留 `inReplyTo`，增加跳数，以 `messageKind: "result"` 投递，不再提供回复模板或回复路由；结果回执保留投递证据，不等待 replied。0.2.0 包含此行为。原回执包含 `forwardedMessageId` 和可能的 `forwardError`。

Codex 回复需要所有者在创建会话时注册导出的 `codexReplyTool`。`getSession()` 返回 `replyReadiness`：`ready`、`needs_attach`、`missing_tool`、`unknown` 或 `unavailable`。工具注册根据本地会话元数据核验；日志尚未持久化或无法读取时保持 unknown。发送和重连不自动建立监听。断连或 Hub 重启后，所有者可显式执行下面的 attach：仅接受已加载、工具已核验的根会话，不传配置覆盖；调用方明确接受 loaded 检查与上游 thread/resume 之间发生卸载可能恢复会话的竞态。不能动态为任意已有会话安装工具。

```sh
agenthub attach-reply --harness codex --session-id SESSION_ID --accept-resume-race
```

守护进程默认将回执、载荷哈希、回复路由和回调关联持久化到令牌文件旁的 `state.sqlite`。用 `--state-file FILE` / `AGENTHUB_STATE_FILE` 修改位置，`--ephemeral` 关闭持久化。基础库可使用 `await openLocalHub(config, { stateFile: absolutePath })`，或将 `await openReceiptStore(absolutePath)` 传给 `new AgentHub(adapters, { store })` 后等待 `hub.ready()`；直接构造且不传 store 仍为内存模式。状态包含明文消息和回复，目录要求 0700，数据库和锁文件为 0600。

## 豆包与 MCP

```sh
env -u AGENTHUB_TOKEN agenthub mcp --origin-name 'Doubao Work' \
  --url http://127.0.0.1:3214 --token-file /ABS/PRIVATE/caller.token
```

MCP 使用官方 SDK，提供会话发现、详情、历史、消息提交和状态查询、全文检索共七个工具。面向 agent 的工具不开放审批、恢复或中断操作。[配置模板](examples/mcp.json)。

0.3.0 的[豆包接入](docs/DOUBAO.zh-CN.md)提供目标选择、私有配置生成、Hub 生命周期和可选 CLI 插件。`agenthub setup` 支持通过显式 CDP 端口自动登记豆包 2.35.15 连接器。真实豆包 STDIO 对话已显示 Claude/Codex 回复；自动创建/移除另通过 5 项检查。豆包原生身份与主动唤醒仍未实现。

## 验证与边界

```sh
npm run check
npm run smoke:isolated -- --run --default-inbox --matrix
npm run smoke:recovery -- --run
```

真实 smoke 只操作新建且在 allowlist 中的会话，验证 Codex → Claude → Codex 及原生历史身份。测试后停止 Claude、归档并卸载 Codex；私有报告位于忽略的 `.local/verification/`。[完整范围](docs/VERIFICATION.zh-CN.md)。

- 持久回执保留 24 小时、最多 10,000 条；提交中断后重启转为 `unknown`，不自动重发。Claude 迟到回复可回到原回调地址；Codex 需要显式重新 attach。不保证 exactly-once。
- 事件最多保留 2,000 条 / 4 MiB；重启或游标过期会明确报错。
- Claude 只校验当前安装的 CLI 版本，无法认证每个已运行进程的版本。协议可能随版本变化。
- 本地回调以同一 OS 用户为信任边界；来源字段不是经过认证的远程 agent 身份。
- Claude 历史读取上限为日志 64 MiB、单条 2 MiB；不提供全量归档会话索引或任意会话实时订阅。

MIT，保留原 Codex Bridge 署名。

[新增权限、持久事件、全文检索、ACP 与 Windows 范围](docs/EXTENSIONS.zh-CN.md)。

Claude/Codex 原生登记、共享协作操作、Codex MCP connect 及显式启用的 Claude CLI connect 已纳入 0.2.0；安装步骤和边界见[连接器接入](docs/CONNECTOR_SETUP.zh-CN.md)。Claude CLI 激活经原生消息和现有 Bash 权限完成，可能启动模型轮次；原生 MCP 外部 reload 仍未实现。
