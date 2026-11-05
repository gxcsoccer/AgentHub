# 豆包工作接入

优先使用 **本地 stdio MCP**：生成配置后，支持该入口的宿主可直接调用本机 Hub，向授权的 Claude/Codex 会话发送请求并查询回复，无需安装 AgentHub 插件。当前开发分支提供配置生成器和七个 MCP 工具；`plugins/doubao` 的本地 CLI + Skill 是可选封装。**豆包客户端的配置加载和实际工具调用仍待宿主验收**，不能将通用 MCP 测试视为豆包已接入。

本版没有把豆包伪装成原生 harness session。其他 Agent 主动唤醒豆包、任意已有豆包会话的发现/历史、Agent OpenAPI 与 MCP Events adapter 尚未实现。CLI/HTTP 测试通过不等于豆包已加载插件。

## 准备配置

需要 Node.js 22.13+、本开发分支源码，以及已运行的测试用 Claude/Codex。先在仓库执行 `npm ci && npm run build`；此流程直接使用编译后的本地 CLI，不依赖尚未发布的 npm 版本。macOS 是 Claude/Codex 真实验收平台；Linux 的豆包入口仍待验证，Windows 继续 pending。生成器只创建独立配置。

1. 用现有只读发现能力选择明确的测试会话，创建 `targets.json`：

```json
[
  { "harness": "claude", "instance": "local", "sessionId": "REPLACE_WITH_TEST_UUID" },
  { "harness": "codex", "instance": "local", "sessionId": "REPLACE_WITH_TEST_UUID" }
]
```

只保留实际需要的目标；不能用 `*`、工作会话名称猜测或外来 harness。生成器只接受本机 `local` 实例和原生 UUID。

2. 生成专用目录（父目录必须已经存在）：

```sh
mkdir -p "$HOME/.agenthub"
node scripts/setup-doubao.mjs --targets /ABS/targets.json
```

默认新建 `$HOME/.agenthub/doubao`，目录 `0700`、文件 `0600`。已有目录会报错，不覆盖凭据。内容包括 owner/caller 两套随机 token、只对目标授予 `read/send` 的 `access.json`、`hub.json`、两端连接器 profile、独立登记凭据和 **`mcp.json`**。输出包含 `mcpConfigPath` 与 `startArgv`，不包含 token。

`--directory /ABS/NEW_DIRECTORY` 和 `--port 3214` 可用于隔离测试。生成的 MCP 与连接器配置自动使用对应目录和端口；`--cli /ABS/dist/src/cli.js` 可指定另一份编译后的 CLI。MCP 启动使用 Node 与 CLI 的绝对路径，带空格的目录作为独立参数传递。生成器不合并现有 access 文件，不启用通配授权。停止 Hub 后，由所有者手工修改授权，再重启使其生效；这不是权限热更新。

3. 审阅后运行独立 Hub（默认端口 3214）：

```sh
env -u AGENTHUB_TOKEN node dist/src/cli.js serve --port 3214 \
  --config "$HOME/.agenthub/doubao/hub.json" \
  --token-file "$HOME/.agenthub/doubao/owner.token" \
  --access-file "$HOME/.agenthub/doubao/access.json" \
  --connector-file "$HOME/.agenthub/doubao/connectors.json" \
  --state-file "$HOME/.agenthub/doubao/state.sqlite"
```

端口占用时停止并核查，不自动终止已有服务。MCP 与可选插件只使用 `caller.token`。生成的 MCP 命令通过 `/usr/bin/env -u AGENTHUB_TOKEN` 清除继承的 owner token，再指定 caller 文件；配置里不嵌入密钥。

4. 所有者按需连接明确目标以准备回复工具：

```sh
env -u AGENTHUB_TOKEN node dist/src/cli.js connect --harness codex --session-id CODEX_TEST_UUID \
  --connector-profile "$HOME/.agenthub/doubao/codex-client.json" \
  --url http://127.0.0.1:3214 --token-file "$HOME/.agenthub/doubao/owner.token"
```

Codex 使用独立 MCP 名 `agenthub_doubao`，reload 作用于整个实例；配置冲突时拒绝覆盖。Claude 原生回调可直接返回回复；需要统一 CLI 工具时，所有者可用同样命令指定 `--harness claude`、`claude-client.json` 和 `--wait-ms 60000`。Claude CLI 激活可能启动模型轮次，遵守现有 Bash 权限。以上都是所有者操作，插件不替用户执行 connect 或审批。详见[连接器说明](CONNECTOR_SETUP.zh-CN.md)。

5. 在宿主的本地 stdio MCP 配置入口添加生成的 `mcp.json` 中的 `agenthub` 条目，保留其他服务器配置。若界面分别要求 command/args，逐项使用生成值；不要把参数拼成 shell 命令。当前尚未确认豆包工作 2.35.15 的此入口，不能承诺导入成功。通用格式见[模板](../examples/mcp.json)。

加载后应能列出七个工具：`list_instances`、`list_sessions`、`get_session`、`get_history`、`search_history`、`send_message`、`get_message_status`。先发现授权目标，再发送 `messageKind: request`，用返回的 UUID 查询结果。工具说明包含回复与有限轮询指引，无需另装 Skill。没有答案时报告请求 ID，后续由用户主动查询。

停用时移除宿主中的这一个 MCP 条目，并停止此配置启动的 Hub；不删除其他 MCP 服务或默认 Hub 的状态。撤销 token 后需要重启对应 Hub。保留私有状态文件供查询已有回执。

## 可选：CLI 插件打包与加载

```sh
npm run package:doubao
```

生成 `.local/doubao/agenthub-plugin-0.1.0.zip`，已存在则拒绝覆盖。需要系统 `zip` 命令。ZIP 根目录直接包含 `plugin.json`、`com.doubao/cli.json` 和一份 Skill；仅打包固定白名单，不包含私人配置、token、原生历史或验收报告。插件版本 0.1.0，包内安装命令固定使用 `@gxcsoccer/agenthub@0.2.0`，需该版本实际发布后才能使用此安装命令。此发布依赖不影响上面的源码 MCP 路径；非默认目录/端口需同步调整插件配置与 Skill。

本地检查不代表平台上传校验通过，也不验证 Skill 名称在全平台唯一。豆包工作中的独立插件加载入口仍待用户确认；尚未自动导入、发布商店或修改实际工作会话。官方 `dbx 0.0.41` 已只读检查，本机未登录；它的应用插件调试流程也不能直接代替本 CLI 插件宿主验收。

## 消息与凭据语义

- MCP 来源名为 `Doubao Work`，CLI 插件为 `Doubao Work via AgentHub`；两者均为外部调用方；不填 `origin.session`、`replyTo`，不声称知道豆包原生会话 ID。
- `messageKind: request` 明确请求一条回复。Claude 使用 `peer_message`，Codex 使用 `tool_output`；不会转换成 `user_input`。
- 回复保存在同一请求回执中，当前任务主动调用 `get_message_status`（CLI 为 `status`）取回。没有后台推送或自动唤醒承诺。
- `accepted`、`received`、`held`、`transport_written` 都不是业务答案；只有 `replied` 和真实 `reply.text` 表示取得回复。`unknown` 不自动重发。
- 相同逻辑请求保留 JSON 和 UUID。丢失 HTTP 回执后先查原 ID；不更换 ID 隐式重试。
- 专用 token 隔离的是调用方和授权目标，**不是每个豆包对话**；共用此 token 的任务具有相同的调用方权限。没有原生身份前，不把模型自报的 conversation ID 当作权限证据。

## 验证

```sh
npm run build
node --test --test-timeout=15000 test/doubao-plugin.test.mjs
node scripts/smoke-connector-codex.mjs --run --doubao-mcp
# 可选 CLI 插件路径
node scripts/smoke-connector-codex.mjs --run --doubao-cli
```

自动测试覆盖私有配置、独立凭据、目录与端口校验、不覆盖旧目录、拒绝无效/通配目标、插件 ZIP 白名单，以及实际 CLI / stdio MCP → HTTP → 测试后端的请求/回复、幂等和越权拒绝。生成的 MCP 配置在故意继承 owner token 的情况下也只能访问授权目标。

显式 `--run --doubao-mcp` 或 `--run --doubao-cli` 沿用已有隔离脚本：仅创建自己的独立 App Server、Claude PTY 和临时目录，完成核心连接器检查后，再用独立受限 caller 执行所选工作流，覆盖真实 Claude/Codex 回复及重复请求。MCP 模式使用生成的启动参数，并验证 MCP 进程重连后查询回执、去重与目标越权拒绝。测试会产生模型用量，结束时归档/停止自有会话并清理凭据。报告分别位于忽略的 `.local/verification/doubao-mcp-backends-live.json` 与 `doubao-cli-backends-live.json`。**这个脚本不启动豆包，也不验证豆包的工具选择、加载或权限 UI。** 实际执行结果见[验证记录](VERIFICATION.zh-CN.md)。

## 下一阶段：主动唤醒豆包

[官方 CLI 连接器](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/cli-connector) 明确在 PC 本地执行。[MCP 文档](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-server-development) 的发布规范要求远程 HTTPS MCP；用户此前的本地 stdio 成功经验属于另一个实际加载入口，需要单独复现。

[MCP Events](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-events) 可以触发用户已确认的保存任务，要求远程 Streamable HTTP、持久订阅、签名公网 HTTPS 回调、回调验证与权限校验。其 2xx 只表示事件接收。后续需要显式授权的本地 Hub 出站中继和独立回执设计，不能假设云端能访问本机 socket；用户提供的资料指出 MCP Apps 不能访问办公网。

[Agent OpenAPI](https://open.doubao.com/document/doubao-developer-guide/openapi-call-flow) 需要开发者应用、权限和 user_access_token；应用创建的会话不等同于任意已有豆包会话。以上两条是后续范围，尚未实现。
