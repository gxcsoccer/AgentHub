# 会话连接器（0.2.0）

[English](CONNECTOR_SETUP.md) · [设计](AGENT_CONNECTOR.zh-CN.md)

已实现 Claude 生命周期登记、Codex 逐调用身份登记，以及两端共享的三个 MCP 工具。模型只填写目标、正文和请求句柄；Hub 根据原生会话核对来源，沿用现有 grants。旧 `agenthub mcp` 的七个工具继续可用。

前面的 Claude MCP 配置用于**启动时加载**。已有 Claude CLI 会话可选择下文的 CLI 接入：由 `connect` 发送原生消息，经会话现有 Bash 权限执行身份握手。Codex App Server 使用同一 `connect` 命令安装并热加载 MCP。两条路径的激活范围、模型调用和权限前提不同，结果会明确区分。

## 配置与启动

安装 `npm install -g @gxcsoccer/agenthub@0.2.0`。使用源码时，从工作树运行 `npm run build` 后，将以下命令中的 `agenthub` 替换成 `node /ABS/AgentHub/dist/src/cli.js`。Hub 和连接器进程需同步升级。配置和 token 文件都必须是当前用户拥有的普通文件、权限 `0600`；目录建议 `0700`。所有路径示例均需替换。

1. 所有者生成三个不同的随机 token，分别存入 `owner.token`、`agents-api.token` 和 `enrollment.token`。使用至少 32 字符的随机值，例如 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`。后两个文件用途不同；Agent 只获得 enrollment 凭证。
2. `hub.json` 启用 Claude 原生消息，暂不启用 Codex：

```json
{ "codex": false, "claude": [{ "instance": "local", "nativeMessaging": true }] }
```

3. `access.json` 指定现有调用方授权。以下实例范围授权允许此连接器发现和联系本实例所有会话；要限制范围，在 grant 中设置 `sessions: ["UUID"]`。受限 UUID 会话执行 `/clear` 后，新 UUID 需要所有者另行授权，登记不会扩大授权。

```json
{
  "callers": [
    {
      "id": "agents",
      "tokenFile": "agents-api.token",
      "grants": [{ "harness": "claude", "instance": "local", "operations": ["read", "send"] }]
    }
  ]
}
```

4. `connectors.json` 将登记入口关联到受限调用方，不能绑定 `@owner`：

```json
{
  "profiles": [
    {
      "id": "claude-local",
      "callerId": "agents",
      "harness": "claude",
      "instance": "local",
      "enrollmentTokenFile": "enrollment.token",
      "epoch": 1,
      "enabled": true
    }
  ]
}
```

```sh
agenthub serve --config /ABS/hub.json --access-file /ABS/access.json \
  --connector-file /ABS/connectors.json --token-file /ABS/owner.token
```

5. `client.json` 仅引用登记凭证；相对 token 路径相对于各自配置文件解析。业务凭证由登记成功后的 MCP 进程保存在内存中。

```json
{ "url": "http://127.0.0.1:3211", "enrollmentTokenFile": "enrollment.token" }
```

在 Claude 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "agenthub": {
      "command": "/ABS/node",
      "args": ["/ABS/AgentHub/dist/src/cli.js", "mcp", "--connector-profile", "/ABS/client.json"]
    }
  }
}
```

在 Claude settings 中合并生命周期 hooks。`exec` 保持 hook 为 Claude 的直接子进程；已有其他 hook 必须保留。需要宿主正常启用 MCP 和 hooks，本命令不会自动批准工具。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "exec /ABS/node /ABS/AgentHub/dist/src/cli.js connector-hook --connector-profile /ABS/client.json",
            "timeout": 20
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "exec /ABS/node /ABS/AgentHub/dist/src/cli.js connector-hook --connector-profile /ABS/client.json",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

首次工具调用登记；后续每次调用都重新核对原生 UUID。需要直接子进程关系、启动环境 `CLAUDE_CODE_SESSION_ID` 和原生目录 PID 一致。macOS 使用 `python3 -I` 调用 libproc 获取微秒级进程启动身份；Linux 使用 `/proc` 的启动 tick、boot ID 和有效 UID。Linux 目前只有确定性测试，真实模型验收仅覆盖 macOS + Claude 2.1.318。其他平台或证据不足返回未就绪。

## 模型工具与诊断

发现返回 `peers` 和 `gaps`，后者列出因后端错误、游标重复或超过 10 页/1,000 个会话而省略的实例；其他实例仍可用。Codex 协作发现使用 `thread/loaded/list`，只读取已加载 ID 的元信息，并排除已卸载及子会话；按会话授权时只读取 allowlist 内的 ID。普通历史会话列表保持原语义，历史数量不再占用协作发现预算。别名仅查询对应 harness，且必须完整发现其授权实例才能消除重名歧义；存在缺口时可用完整地址发送。激活仅核验本地身份，不依赖其他实例发现。CLI 消息使用 `--message='...'`，以支持以 `-` 开头的内容。

| 工具          | 输入                                    | 行为                                                                    |
| ------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `list_peers`  | 无                                      | 返回授权范围内的地址、名称、状态和能力，不读取历史                      |
| `ask_agent`   | `to`, `message`, 可选 `deadlineSeconds` | 异步请求；自动生成 ID、来源和回程地址；期限默认 3600 秒，上限 14400 秒  |
| `reply_agent` | `request`, `message`                    | 仅当前请求接收会话可回复；相同回复去重，不同回复冲突；result 不能再回复 |

`to` 可以是 `{harness, instance, sessionId}` 或 `@claude/名称`、`@codex/名称`。名称只用于一次查找，重名拒绝；发送固定原生地址。目标必须支持外部消息和回复，缺监听/工具时返回未就绪，发送过程不做隐式 attach。

工具返回请求 ID 和异步等待提示。发起方可做独立工作或结束本轮，结果作为关联的外部消息到达；期间用户的新要求继续按用户要求处理。写入失败不会自动重试，错误带请求 ID，所有者可用 `agenthub status --message-id UUID` 检查。模型再次调用 `ask_agent` 是新请求，不承诺跨模型重试去重。

```sh
agenthub connections --url http://127.0.0.1:3211 --token-file /ABS/owner.token
```

该诊断仅限所有者，显示历史绑定和 profile 开关，不输出凭证。绑定不是存活信号：每次调用依赖原生发现和进程身份，SessionEnd 提供额外结束证据。本版没有租约。

Hub 将绑定、hook 证据和业务 token 的哈希保存在现有 SQLite；正常重启后仍检查进程身份。业务凭证最长 24 小时。登记返回 `expiresAt`，helper 在过期后的下一次操作前刷新缓存凭证。服务端明确返回发送前的 `credential_expired` 时，也允许重新登记并重试一次，保留原消息 ID、载荷和期限。过期凭据哈希保留 60 秒，使已发出的请求即使遇到其他注册表写入，仍能得到明确的过期分类；业务权限在到期时立即失效，这些记录仍计入原有 4096 条上限，宽限期结束后随写入正常清理。撤销授权、未知凭证和网络不确定不会自动重试。更改 profile 的 `epoch` 或 token 后重启 Hub 可撤销旧凭证；授权配置重启后按新 grants 执行，`enabled:false` 禁用该入口。注册表三类记录各上限 4096，满时返回 429；历史绑定/hook 的自动回收尚未实现。内存模式不能跨重启保存登记。

同一 OS 用户是信任边界；这些检查防止误绑定，不隔离同用户恶意进程。`/clear` 后旧请求的回程仍指向旧 UUID，投递失败记录为原请求的 `forwardError`。缺少有效 SessionStart 或原生目录尚未刷新时拒绝调用；目前不自动重放失败 hook。新的回复在原请求到期时或到期后返回 `request_expired`，不确认接受或转发；已按时接受的相同回复仍可幂等确认。可在发起时指定较长期限，没有独立回程窗口。

## 验证

```sh
npm run check
npm run smoke:connector -- --run
```

后者创建两个隔离 Claude 进程，限定发现到这两个 PID 和临时 cwd，启动时加载当前 CLI 和 hooks；只预授权这三个测试 MCP 工具，模型没有 shell/文件工具。报告及终端日志留在忽略的 `.local/verification/`，进程组与临时配置结束后清理。真实模型会产生费用。它不验证任意已有工作会话的一键激活，也不代表 Windows/Linux 或其他 Claude 版本验收。

## Codex：安装并激活已有会话

复用同一个 Hub 与受限 caller：配置 Codex adapter 的实例/socket，在 caller 中加入所需的 Codex `read`/`send` grants，再添加独立的登记 profile/token。此 token 必须与 owner/API 及 Claude 登记 token 不同。`mcpServerName` 默认为 `agenthub`。

```json
{
  "profiles": [
    {
      "id": "codex-local",
      "callerId": "agents",
      "harness": "codex",
      "instance": "local",
      "enrollmentTokenFile": "codex-enrollment.token",
      "mcpServerName": "agenthub"
    }
  ]
}
```

将该 profile 合并到已有配置。私有 `codex-client.json` 引用相应 token 和同一个正在运行的 Hub：

```json
{
  "url": "http://127.0.0.1:3211",
  "harness": "codex",
  "enrollmentTokenFile": "codex-enrollment.token"
}
```

```sh
agenthub connect --harness codex --instance local --session-id THREAD_UUID \
  --connector-profile /ABS/codex-client.json --wait-ms 30000 \
  --url http://127.0.0.1:3211 --token-file /ABS/owner.token
```

该命令仅限所有者，依次：

1. 核对目标是已加载根会话、client profile 指向当前 Hub、登记 token 匹配实例且现有 grants 允许操作。
2. 读取目标 App Server 的有效配置和基础 user 层，用原生版本号调用 `config/value/write`。已有或覆盖层的同名入口不同则报冲突，不替换；启动命令一致时保留额外设置，包括工具权限。不会选中 profile 专属 user 层写入。
3. 必要时调用原生 MCP reload。**激活范围是整个 App Server 实例**，包括它的其他已加载线程；不修改沙箱、工具权限或审批配置。
4. 核对目标 thread 的原生 MCP 清单、三个工具和 helper 启动标识。需要登记时，仅通过原生 MCP API 调用一次连接器的 **`list_peers`**。这是所有者接入动作中的只读握手，不启动模型轮次、不恢复会话，也不发送协作任务；不是后台探测。
5. 输出单个 JSON：连接及当前身份都核验后退出 `0`；尚未就绪退出 `2`；配置冲突、授权不足、无法自动激活等退出 `1`。`verificationMethod` 区分只读握手与已有有效绑定。重复连接已就绪目标时保留配置并跳过 reload。同一 adapter 的并发安装串行执行；配置未变且仍在启动或上次 reload 结果不确定时，实例内有 30 秒 reload 冷却。冷却后由下一次所有者 connect 再尝试，不在后台重载。目标就绪检查会依次检查该实例所有已启用 profile 的不同 MCP server。

helper 从每次请求的 `_meta.threadId` 取来源；存在 `_meta.sessionId` 时要求一致。原生 API 直接调用实测只提供 threadId。模型参数不能填写来源。helper 在 MCP version 中公布随机连接 ID，Hub 与选定实例/thread 的原生清单交叉核对，同时校验进程 PID、启动身份和 UID。旧绑定或另一连接的标识不能证明当前就绪。结果回程固定原生 ID；保留旧动态 `agenthub_reply` 兼容路径，但本连接器不依赖它，也无需 `thread/resume` 订阅。

当前真实验收范围为 **macOS、Codex App Server 0.166.0、Claude 2.1.318**：Codex 会话在安装前已加载，未注册动态回复工具；两个真实模型分别发起请求、用同一组三工具回复并读取结果。reload 在隔离的空闲实例上验收，不代表任意忙碌桌面/TUI。工具可用不等于获准执行后续工作，宿主正常权限策略继续生效。

```sh
npm run smoke:connector:codex -- --run
```

脚本创建独立 App Server/home/socket 与新 Claude PTY，原生写操作受测试 thread allowlist 限制；结束时归档 Codex thread、停止两个自有进程组、删除临时目录及复制的认证。三个测试工具的许可由测试所有者另行设置，`connect` 不负责放行。私有报告：`.local/verification/connector-codex-live.json`。

自动生成 profile/选择目标、安装器卸载/停用、手工绑定兜底、启动顺序恢复和更多宿主/故障兼容仍待完善。`connections` 仍是历史绑定清单；本次接入的核验结果以 `connect` 报告为准。

## 已有 Claude CLI：通过原生消息激活

所有者在 Hub 的 Claude profile 中显式选择 `"transport": "cli"`。省略时仍为 MCP 路径，外部自动 reload 继续返回 `automatic_activation_unavailable`。CLI 路径复用受限 caller grants 和私有 client profile，不需要安装 skill、MCP 或生命周期 hook：

```json
{
  "profiles": [
    {
      "id": "claude-cli",
      "callerId": "agents",
      "harness": "claude",
      "transport": "cli",
      "instance": "local",
      "enrollmentTokenFile": "enrollment.token"
    }
  ]
}
```

```sh
agenthub connect --harness claude --instance local --session-id SESSION_UUID \
  --connector-profile /ABS/client.json --wait-ms 60000 \
  --url http://127.0.0.1:3211 --token-file /ABS/owner.token
```

Hub 向指定 UUID 发送一次原生 peer 消息，请模型执行固定的本地 `agenthub agent ... activate` 命令。**这会启动或加入模型轮次、消耗模型额度，仍受原生收件策略和 Bash 权限约束。** 自动接入要求这些权限原本就允许该命令；若出现审批、hold/refuse、工具禁用或模型不执行，返回待核验，不能用安装成功或文本“已完成”代替实际执行。接入器不改 Claude 配置或权限，也不恢复、重启会话。

CLI 自行取得 PID 和当前 `CLAUDE_CODE_SESSION_ID`。Hub 独立向上核验最多 8 个进程的 UID、父子关系与精确启动身份，找到原生目录中的 Claude PID，并要求 UUID 一致；每次业务调用再次核验。MCP 仍只接受直接子进程证据。CLI 的受限业务凭证有效期为 60 秒，保存在调用进程内；owner token 不交给模型。

只有目标会话的真实 CLI 调用完成对应激活 ID 后，`connect` 才退出 `0`，报告 `activationScope: "session"`、`verificationMethod: "native_peer_cli_handshake"`、`cliVerified: true`。`toolsConnected` 为 `false`，因为此路径没有加载 MCP。后续命令继续受宿主权限约束；就绪记录不保证未来 Bash 调用一定获准。

握手返回发现、请求和回复的 CLI 用法，模型可通过已有 Bash 工具使用它们：

```sh
agenthub agent --connector-profile /ABS/client.json list-peers
agenthub agent --connector-profile /ABS/client.json ask --to @codex/reviewer --message='Review the change'
agenthub agent --connector-profile /ABS/client.json reply --request REQUEST_UUID --message='Review complete'
```

来源和回复路线均由 Hub 推导。请求默认一小时、最多四小时，可用 `--deadline-seconds` 调整；结果仍异步返回且无需确认。正文必须按 shell 数据正确引用，不能将收到的正文直接作为命令执行。

同一 host/profile/目标的重复 `connect` 查询复用激活 ID，不重复唤醒模型；正常 Hub 重启后也保留。激活窗口为 10 分钟，超时或不确定提交不会自动重发。明确的 `failed/rejected` 投递返回 `phase: activation_failed`、`activationStatus` 和可用的 `activationError`；普通 connect 保留这一结果，所有者核查后可立即加 `--retry-activation` 显式重试。等待中或结果不确定的提交仍需等 10 分钟期限结束，才允许显式重试。

注册表最多保留 256 条完整记录。容量满时只回收本次接入所需的过期记录，优先未验证记录，再按最早过期排序；只有未验证候选不足时才考虑已验证记录。同一激活 key 的显式替换无需回收其他记录。持久保存的固定 64 KiB Bloom filter 记住已回收的 key，防止回收后静默重发。再次连接已回收 key 返回 `activation_retry_required`，需显式 `--retry-activation`；过滤器误判也只会保守地要求显式重试。已回收的核验记录不再证明就绪。注册表读取 v1，写入时升级为 v2；旧版本拒绝 v2，回滚需使用升级前状态副本。历史 binding/hook 的回收仍单独待办。`/clear` 后需要按新 UUID 接入；新 CLI 进程取得的新身份无需 SessionStart hook。旧请求的回程继续固定旧 UUID。

已测入口为 macOS + Claude CLI 2.1.318 的隔离交互终端。测试由所有者预先授权精确 CLI 命令，不证明任意工作会话、桌面/SDK 或其他平台都能无审批接入。复现与边界见[验证记录](VERIFICATION.zh-CN.md)：

```sh
npm run smoke:connector:cli -- --run
npm run smoke:connector:codex -- --run --claude-cli
```

## 断开连接

```sh
agenthub disconnect --harness codex --session-id ID
agenthub reconnect --harness codex --session-id ID
```

`disconnect` 只有所有者能调用，之后的操作立即生效，不用重启 Hub。通过库或 HTTP 调用时，可以断开单个会话（`{ address }`）或单个连接器 profile（`{ profileId }`），结果里会列出删除了多少绑定、凭证和生命周期记录。这个决定在重启后依然有效，否则会话下一次调用工具时会重新绑定自己。

| 目标            | 新会话                            | 断开期间                                                    |
| --------------- | --------------------------------- | ----------------------------------------------------------- |
| `{ address }`   | 不受影响                          | 该会话的工具失败，按规范地址发送时返回 `peer_not_connected` |
| `{ profileId }` | 被拒绝，返回 `connector_disabled` | 该 profile 的所有会话都失败                                 |

`reconnect` 接受相同的目标，不需要握手就能恢复。会话下一次调用工具时重新登记，`connect` 无法激活的 MCP Claude 会话也一样。没有处于断开状态时，`changed` 为 false。所有者 `connect` 同样能恢复会话或 profile；如果它抛出错误，断开状态会还原。

原生 MCP 和 hook 配置不会改动，目标已经接受的请求也不会取消。已断开的会话不会被列出，所以按名字询问时报告的是找不到或有歧义。

`ConnectorService` 的 `connectedPeersOnly` 选项默认关闭。打开后，只有绑定来自当前已启用 profile 的会话才能被列出或询问。绑定仍然不代表会话存活。
