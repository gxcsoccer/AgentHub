# 豆包工作接入

通过 **本地 stdio MCP**，豆包可以向授权的 Claude/Codex 会话发起请求并取回回复，无需安装 AgentHub 插件。macOS 上的豆包工作 **2.35.15** 已在独立测试对话中加载七个工具，并显示两个 harness 的真实回复。验证记录区分宿主观察与后端自动测试。

**0.3.0** 的 npm 包新增统一 `agenthub setup` 命令。豆包原生对话身份、任意已有会话发现/历史、主动唤醒仍属后续范围。

## 安装与选择目标

需要 Node.js 22.13+，安装发布包后执行：

```sh
npm install -g @gxcsoccer/agenthub@0.3.0
agenthub setup targets --harness claude
agenthub setup targets --harness codex
```

发现操作只读：Codex 列出已加载的根会话，Claude 列出原生活跃会话；返回续页游标时使用 `--cursor`。从结果中选择明确 UUID，初始化不会自动选择或联系工作会话。

只授权一个目标：

```sh
agenthub setup init --harness claude --session-id CLAUDE_TEST_UUID
```

授权多个目标时，创建 `targets.json`：

```json
[
  { "harness": "claude", "instance": "local", "sessionId": "REPLACE_WITH_TEST_UUID" },
  { "harness": "codex", "instance": "local", "sessionId": "REPLACE_WITH_TEST_UUID" }
]
```

```sh
agenthub setup init --targets /ABS/targets.json
```

只保留实际需要授权的目标。生成器仅接受本机 Claude/Codex UUID，在创建文件前使用与清单加载相同的校验规则。新建 `$HOME/.agenthub/doubao`，权限 0700；已有目录会报错，不覆盖凭据。`--directory /ABS/NEW_DIRECTORY` 和 `--port 3214` 可自定义目录与端口；自定义父目录需已存在且为规范路径。配置/凭据权限为 0600，生成的 `agenthub-mcp` 启动器为 0700。

文件包括独立 owner/caller/enrollment token、针对明确目标的 read/send 授权、Hub 与连接器 profile、setup 清单、`mcp.json` 和启动器。输出只有路径与参数数组，不包含密钥。MCP 使用 Node/CLI 绝对路径和 caller 凭据，并清除继承的 `AGENTHUB_TOKEN`。需要保留该安装路径；变更目标或安装位置时，停用旧配置并生成新目录。生命周期命令会拒绝被手工修改的生成文件。

## 启动、连接并在豆包加载

在独立终端中用同一份已安装 CLI 启动受管理的 Hub：

```sh
agenthub setup serve --directory "$HOME/.agenthub/doubao"
```

该命令保持前台运行。端口占用会报错。初始化本身不启动服务、不发送消息。在另一个终端中为已选择的 Codex 准备回复工具：

```sh
agenthub setup connect --directory "$HOME/.agenthub/doubao" --harness codex
```

生成的 MCP 名为 `agenthub_doubao`；原生 reload 作用于整个 Codex 实例，冲突配置不会覆盖。Claude 原生回调回复不需要这一步；可选 `setup connect --harness claude` 用于启用统一 Agent CLI 工具，会在现有 Bash 权限下启动模型轮次。不指定 harness 时会连接**全部已配置目标**。激活边界见[连接器说明](CONNECTOR_SETUP.zh-CN.md)。

### 自动登记宿主（实验性）

豆包**已显式开启 CDP 调试端口**时，可直接登记生成的启动器，省去手工填表：

```sh
agenthub setup host-install --directory "$HOME/.agenthub/doubao" --doubao-cdp-port 9224
agenthub setup host-disable --directory "$HOME/.agenthub/doubao" --doubao-cdp-port 9224
agenthub setup host-enable --directory "$HOME/.agenthub/doubao" --doubao-cdp-port 9224
agenthub setup host-remove --directory "$HOME/.agenthub/doubao" --doubao-cdp-port 9224
```

这里使用桌面客户端内部连接器 API，当前仅允许已验证的 **2.35.15**，不属于公开版本化 SDK。AgentHub 复用当前 renderer 的登录态和实际桌面请求元数据，不导出或保存 Cookie、鉴权查询参数。CLI 不开启调试端口，也不重启豆包。如需开启，请自行选择时机退出后执行 `open -a DoubaoWork --args --remote-debugging-port=9224`，或使用另行安装的 [dbtrace](https://github.com/gxcsoccer/dbtrace) 启动器。

创建前持久化唯一名称，收到结果后记录 ID，并核对启动器配置；重复安装复用该条目。创建响应丢失时按唯一名称找回一致条目；结果仍不确定时拒绝再次创建，保留私有配置供核查。移除调用 `connector/disconnect`，并以完整本地列表中不存在该 ID 为准。用户编辑过的条目不会修改。超过一页（48 个本地条目）、版本未验证或桌面上下文缺失时停止操作。

`installed` 仅表示登记和连接接收已核验；实际工具与回复测试前，`hostLoadingVerified`、`deliveryTested` 仍为 false。`host-enable/disable` 修改宿主条目，`setup enable/disable` 控制 Hub，两者独立且显式。

登记在尝试创建之前失败时，`host-remove` 会直接清理 pending 记录，无需连接豆包；也可直接执行 `setup uninstall`。已经尝试创建后，被拒绝或丢失的响应不能证明条目是否存在；条目被手工删除、豆包升级也可能让 API 清理失败。此时可使用离线恢复命令，名称必须与报错、`setup doctor` 的 `hostRegistration` 或私有 `setup.json` 中的记录完全一致：

```sh
agenthub setup host-forget --directory "$HOME/.agenthub/doubao" --confirm-host-name agenthub-EXACT_UUID
agenthub setup uninstall --directory "$HOME/.agenthub/doubao"
```

`host-forget` 不需要 CDP 连接。它将状态记为 `forgotten`，保留名称/ID，返回 `remoteCleanupVerified: false`；应按记录在豆包中检查并手工删除条目。确认后允许本地卸载，该配置也会停止提供自动宿主操作。此命令本身不停止 Hub 或撤销凭据，需继续执行 `setup uninstall`。

### 手工入口

macOS 豆包工作 2.35.15 的界面入口：

1. 打开 **插件 · 技能 · 伙伴**（`⇧⌘S`）→ **添加** → **新建自定义连接器**。
2. 选择 **STDIO**，连接器命名 `agenthub`；命令填入 init 返回的绝对 **`launcherPath`**，例如 `/Users/you/.agenthub/doubao/agenthub-mcp`。
3. 参数与环境变量留空，保存。该自定义连接器仅在此电脑生效。

需要 command/args 配置的宿主也可使用兼容的 `mcp.json`；保持参数边界与其他服务器配置。本路径无需可选的 CLI 插件。

加载后的七个工具是 `list_instances`、`list_sessions`、`get_session`、`get_history`、`search_history`、`send_message`、`get_message_status`。先发现授权目标，再发送 `messageKind: request`，然后查询同一 UUID。工具说明包含有限轮询指引；尚未完成时报告请求 ID，供用户稍后查询。

```sh
agenthub setup doctor --directory "$HOME/.agenthub/doubao"
```

Doctor 只读：后端错误退出 1；其余情况退出 2，因为宿主加载和真实模型回复仍需独立测试。`hostLoadingVerified: false` 表示本次诊断没有建立宿主加载证据，不代表宿主一定未连接。诊断不会发送探测消息。

## 停用与移除

```sh
agenthub setup disable --directory "$HOME/.agenthub/doubao"
agenthub setup enable --directory "$HOME/.agenthub/doubao"
# enable 后需再次运行 setup serve；enable 本身不启动服务。
agenthub setup uninstall --directory "$HOME/.agenthub/doubao"
```

停用会持久化禁用标志，等待本配置的受管理 Hub 退出，并拒绝新的启动器连接；harness 已经接受的在途工作不会被中断。启用只允许后续显式启动。SQLite 进程锁防止双实例，并在进程崩溃后释放；命令不会按猜测的 PID 杀进程。通过旧版 `serve` 路径独立启动的 Hub，需要先另行停止。

配置端口上的其他服务返回 401/403/404/405、HTML 或非 Hub JSON 时，清理可继续，服务保持运行。超时、连接重置或服务端故障会返回 `setup_hub_unknown` 并保留凭据；检查或停止该服务后重试。能响应且接受本配置凭据的 Hub 仍须先停止。

卸载只删除未被修改的生成文件，保留私有回执状态、生命周期元数据和其他文件。**宿主条目需另行清理**：API 登记的豆包条目先执行 `setup host-remove`；无法核验远端清理时，使用上述显式 `host-forget` 恢复流程。从未尝试创建的记录可直接卸载。手工添加的条目在豆包界面删除；如果 `connect` 安装了原生 MCP，也应删除对应条目。中断后的卸载可重试，删除前会校验所有剩余文件。已卸载配置不能重新启用。

卸载结果分别报告豆包登记与原生连接器配置：

| `cleanup.doubao.status` | 含义                                         | `hostCleanupRequired` |
| ----------------------- | -------------------------------------------- | --------------------- |
| `removed`               | 已核验记录中的条目被移除                     | `false`               |
| `not_created`           | 记录中的登记从未尝试创建                     | `false`               |
| `forgotten`             | 已显式放弃管理，按保留的名称/ID 在豆包中检查 | `true`                |
| `untracked`             | 没有 API 登记记录，检查是否曾手工添加        | `true`                |

`hostCleanupRequired` 仅指该豆包条目。`cleanup.nativeConnectors` 单独返回 `status: unchecked`、`checkRequired: true` 和配置过的 harness 列表，因为生成文件之外的原生安装未被跟踪。应检查这些 harness，只删除确实存在且引用本配置的原生条目。命令不修改原生配置，也不声称它们不存在；重复卸载保留相同的清理报告。

## 可选 CLI 插件

```sh
npm run package:doubao
```

系统 `zip` 生成 `.local/doubao/agenthub-plugin-0.1.0.zip`，已有文件则拒绝覆盖。仅包含 `plugin.json`、`com.doubao/cli.json` 和 Skill，不含凭据或报告。插件版本 0.1.0 固定使用已发布的 `@gxcsoccer/agenthub@0.2.0`。非默认目录/端口需调整插件与 Skill。该 CLI 插件尚未在豆包宿主加载或发布商店；真实宿主验收使用自定义 STDIO 连接器。

## 消息边界

- 调用方标识为 `Doubao Work`（可选插件为 `Doubao Work via AgentHub`），不声明原生 `origin.session` 或自动 `replyTo` 路由。
- 请求使用 Claude `peer_message` 或 Codex `tool_output`，保留外部来源。只有 `replied` 和真实 `reply.text` 才是答案，传输接收不是业务完成。
- 当前豆包任务主动查询结果；尚无后台回调或主动唤醒。
- 保留原始 JSON 与 UUID。丢失响应后先查询原 ID，不静默换 ID 或重发投递情况未知的请求。
- token 隔离调用方及授权目标，**不隔离各个豆包对话**；共享 token 的任务具有相同调用方权限。

## 验证与复现

```sh
npm run check
npm run test:package
node scripts/smoke-connector-codex.mjs --run --doubao-mcp
# 可选 CLI 工作流
node scripts/smoke-connector-codex.mjs --run --doubao-cli
# 需要独立操作豆包界面，最多等待 15 分钟
node scripts/smoke-connector-codex.mjs --run --doubao-host
# 真实宿主 API 生命周期，不发起模型消息、不重启应用
node scripts/smoke-doubao-host-api.mjs --run --cdp-port 9224
```

真实测试只创建自有 App Server、Claude PTY 和临时目录，会产生模型用量，并清理自有会话和凭据。MCP 模式覆盖真实回复、重复请求和 MCP 重连后的回执查询。这些模式本身不操作豆包。

Host 模式先完成后端检查，然后写入忽略的 `.local/verification/doubao-host-pending.json`，包含临时 `hostLauncherPath`、两个固定请求和 `observedFile`。在独立豆包测试对话中添加临时 STDIO 连接器，让豆包发送原样请求并取回回复。只有**亲眼确认界面显示两条回复后**，才将 `{ "host": "Doubao Work", "hostVersion": "…", "repliesVisible": true, "messageIds": ["…", "…"], "evidence": "私有截图路径" }` 写入 `observedFile`。脚本会独立比对持久回执与固定请求，匹配后才记录宿主检查。测试后需删除临时豆包连接器，脚本不替操作者删除；超时按失败处理。

生产 CLI 另通过 5 项宿主 API 检查：创建/读回、重复登记复用、启停读回，以及移除后保留全部原有本地连接器；报告为 `doubao-host-api-live.json`。本次 17 项检查包括 15 项后端检查和两条豆包可见回复。忙碌期间用户插话、真实宿主断线恢复、原生身份与其他宿主平台尚未验证。详见[验证记录](VERIFICATION.zh-CN.md)；报告和截图保持私有，不随项目发布。

## 后续：主动唤醒

[官方 CLI 连接器](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/cli-connector) 在本机运行。[发布 MCP 配置](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-server-development) 描述远程 HTTPS 路径；已验证的自定义 STDIO 是独立本地入口。

[MCP Events](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-events) 需要保存任务、远程 Streamable HTTP、持久订阅和签名公网 HTTPS 回调。[Agent OpenAPI](https://open.doubao.com/document/doubao-developer-guide/openapi-call-flow) 需要开发者应用、权限和用户 token。后续中继需要明确授权及独立完成回执；两者都不代表能访问任意已有豆包对话。这些 adapter 尚未实现。
