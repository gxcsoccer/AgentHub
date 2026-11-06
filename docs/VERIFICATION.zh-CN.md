# 验证说明

## Claude 版本策略（未发布，2026-11-06）

在 macOS、真实 Claude Code 2.1.319 和默认策略下，`npm run smoke:connector -- --run` 通过全部 10 项，`npm run smoke:isolated -- --run` 结果为通过。这覆盖了 2.1.319 的原生投递、回复和 `/clear`，因此把它加入已实测版本。

`2.2.x` 和之后的 `2.1.x` 会被放行，但没有运行过。后续版本是否保持这套私有协议，要实际运行后才知道。

## 0.4.3 发布检查（2026-11-06）

PR #15 已合并。包和 OpenAPI 版本设为 0.4.3 后，`npm run check` 通过 **280 项测试**（核心 211、保留 Bridge 41、脚本 28），覆盖率为**行 96.97%、分支 88.47%、函数 94.83%**。`npm run test:package` 通过。

将 Claude Code 固定为 2.1.318 时，`npm run smoke:connector -- --run` 通过全部 10 项。同样的运行在 2.1.319 上失败，该版本当天在本机自动升级：`ask_agent` 返回 `Peer name is missing or ambiguous`。2.1.319 不在已验证版本列表中，所以该会话默认不提供 `peer_message`。启动绑定的检查已通过。2.1.319 尚未验证。

未在真实 Claude 会话中检查 Hub 停止时的启动界面。

## 0.4.2 发布检查（2026-11-06）

PR #13 已合并。包和 OpenAPI 版本设为 0.4.2 后，`npm run check` 通过 **279 项测试**（核心 210、保留 Bridge 41、脚本 28），覆盖率为**行 97.01%、分支 88.75%、函数 94.82%**。`npm run test:package` 通过。

在 `f5f9aac` 上，`npm run smoke:connector -- --run` 在 macOS 和 Claude Code 2.1.318 上通过全部 10 项。两个真实交互会话在调用工具前完成绑定；`/clear` 后，会话同样在调用工具前绑定到新 UUID。本次运行使用 `--strict-mcp-config`。

Hub 晚于会话启动、原生目录迟到这两种情况只有假 fetch 覆盖。会话 resume、不带 `--strict-mcp-config` 加载 MCP、helper 的 24 小时凭证过期后再 `/clear` 都没有测试。最后一种情况下，按代码新 UUID 要到下一次工具调用才绑定。

## 0.4.1 发布检查（2026-11-06）

PR #11 已合并。包和 OpenAPI 版本设为 0.4.1 后，`npm run check` 通过 **276 项测试**（核心 207、保留 Bridge 41、脚本 28），覆盖率为**行 96.56%、分支 88.50%、函数 94.74%**。`npm run test:package` 通过。

在 `c9b1292` 上用隔离 home 和真实 Codex 0.166.0 TUI 运行，数据目录启动器以 `exec` 启动 Node。`connect` 达到 `ready`，配置里只有启动器、没有 App 路径，`list_peers` 完成且身份校验通过。把 App 目录改名并只重写启动器后，配置逐字节不变，`connect` 仍为 `ready` 且 `changed: false`，新线程的 helper 运行在新路径上。

该次运行的 args 非空，所以 `144f598` 的缺省 args 修复只有假 RPC 和真实 CLI 配置的覆盖。实例忙碌或 Hub 下线时的启动器行为没有测试。

## 0.4.0 发布检查（2026-11-06）

PR #9 已合并。包和 OpenAPI 版本设为 0.4.0 后，`npm run check` 通过 **274 项测试**（核心 205、保留 Bridge 41、脚本 28），覆盖率为**行 96.88%、分支 88.53%、函数 94.72%**。`npm run test:package` 通过全新安装、五个导出、两个二进制、HTTP/SQLite 和已安装的 setup CLI。

真实运行使用隔离 home、Codex 0.166.0 TUI 和 Claude 2.1.318。最后一次代码改动 `60e0ff3` 通过了：会话和 profile 的断开与恢复、会话断开期间新会话登记、单独一轮的回复兜底、合并轮次的 `noReply` 且未泄漏用户工作，以及 Hub 被 SIGKILL 后的结果转发（2/2，Claude 到 Claude）。`4700953` 通过了 11.8 秒中断下的回复重试（模型只调用一次）和 `gap: true`。普通 TUI 中有一次真实的 `reply_agent` 调用成功。

尚未验证：`reply_call_failed`、`turn/completed` 能否到达这条连接（由轮询兜底）、Codex 作为发起方时跨 Hub 重启的转发，以及回复兜底轮次中的 `fileChange`、`webSearch`、`plan`。25 秒重试窗口是估计值。普通 TUI 处理任务并不稳定，详见[路线图](ROADMAP.zh-CN.md)。早期的拒绝实验受到含 `Use no tools` 的测试提示词污染。未接触任何工作会话。

## 0.3.0 发布检查（2026-11-05）

PR #3 已合并。包版本与 OpenAPI 更新为 0.3.0 后，`npm run check` 通过 **250 项测试**（核心 181、保留 Bridge 41、脚本 28）；覆盖率为**行 96.66% / 分支 88.11% / 函数 94.52%**。CLI、MCP 和连接器版本信息统一读取包清单。本版新增统一 setup 与实验性豆包宿主登记，相较 0.2.0，核心 SQLite schema 不变。

`npm run test:package` 通过临时安装、5 个公开导出、两个 CLI、HTTP/SQLite 和安装后的 setup CLI 检查。真实豆包验收在恢复/报告修复前的 `9c37af1` 完成；下方 17 项宿主/后端检查和 5 项 API 生命周期检查没有因本次版本更新而重跑。本次发布验证使用本地 fixture 和隔离安装包，未联系工作会话。私有报告位于 `.local/verification/release-0.3.0-*`。

## PR #3 清理报告与目标发现（2026-11-05）

`npm run check` 通过 **250 项测试**（核心 181、保留 Bridge 41、脚本 28）；覆盖率为**行 97.08% / 分支 88.37% / 函数 94.52%**。新增 5 项进程测试，通过隔离的 Claude 可执行文件与 Codex WebSocket/Unix socket fixture 执行编译后的 `setup targets` CLI，覆盖发现、两端分页、空结果、非法响应/游标、非法 harness 和后端不可用，并核验只读调用、连接关闭及不生成配置或状态文件。既有卸载测试补充了四种豆包清理状态、原生配置单独标记待检查、重复卸载结果一致，以及已核验宿主移除后的 CLI 输出断言。

`npm run test:package` 也通过临时安装、公开导出、两个 CLI、HTTP/SQLite 和安装后的 setup CLI 检查。本轮属于本地 CLI/fixture 检查，未联系真实 harness 会话或操作豆包 UI；此前真实宿主证据仍对应 `9c37af1`。私有日志位于 `.local/verification/pr3-followups-*`。

## PR #3 恢复路径修复（2026-11-05）

`npm run check` 通过 **245 项测试**（核心 176、保留 Bridge 41、脚本 28）；覆盖率为**行 96.30% / 分支 87.58% / 函数 94.12%**。新增 10 项回归测试修复前全部失败，修复后全部通过。覆盖创建文件前的 UUID 校验；其他服务返回 401/HTML/非 Hub JSON 时正常清理；端口无响应时明确报告归属未知并保留凭据；未尝试创建时离线清理；创建被拒、响应丢失、条目被手工删除或宿主升级后的准确名称确认 `host-forget`。

宿主异常使用 fake API，端口用例使用本地 HTTP 服务，恢复命令通过独立进程执行编译后的 CLI。本轮未重跑下方真实豆包/模型验收；该证据来自此前 PR head `9c37af1`。修复过程未联系工作会话。更新后的 CLI 也通过安装包验证。私有日志保留在 `.local/verification/pr3-fix-*`。

## 豆包宿主与统一 setup（2026-11-05，开发分支）

`npm run check` 通过 **235 项测试**（核心 166、保留 Bridge 41、脚本 28）；覆盖率为**行 96.56% / 分支 87.34% / 函数 94.08%**。安装包验证也执行了安装后的 setup CLI。新增进程测试覆盖生成的 MCP 启动器、停用/重启、自有进程 SIGKILL 恢复、拒绝控制旧路径启动的守护进程、私有文件校验以及保留用户修改。宿主 API 测试覆盖唯一登记、创建响应丢失后的找回去重、不确定结果保留和移除后置条件。

macOS **豆包工作 2.35.15** 的真实宿主验收通过 **17 项检查**：15 项隔离后端/MCP 检查，加上豆包发送的两条固定请求及在测试对话中实际显示的 Claude/Codex 匹配回复。宿主也显示了重复请求结果；后端去重另有存储断言。加载入口为 **插件 · 技能 · 伙伴 → 添加 → 新建自定义连接器 → STDIO**。临时连接器已通过界面删除；自有 Claude/Codex 进程、测试 thread 和临时凭据已清理。原生版本为 Claude **2.1.318**、Codex **0.166.0**。私有证据：`.local/verification/doubao-host-live.json` 及忽略的界面截图。

生产 `setup host-*` CLI 另通过 **5 项真实 API 检查**：创建并准确读回启动器；重复安装复用 ID；停用/启用读回；移除后保留全部原有本地连接器 ID；卸载生成配置。私有报告：`.local/verification/doubao-host-api-live.json`。该实验参考了 [dbtrace 早期连接器研究](https://github.com/gxcsoccer/dbtrace/blob/main/docs/research/doubao/mcp-connector.md)。当前版本的列表请求需要桌面设备上下文，移除实际使用 **`connector/disconnect`**；旧通用 delete 路由曾返回成功却未移除此条目，因此实现不使用它。实现不导出或保存 Cookie、鉴权查询参数。

两类验收范围独立：API 生命周期验证不代表模型工具调用，登记结果仍返回 `hostLoadingVerified: false`。忙碌期间用户插话、实际宿主断线恢复、主动唤醒、豆包原生对话身份和其他平台仍未验证或未实现。生成文件卸载不包含原生 Claude/Codex MCP 配置的自动清理。此前 CLI 单独通过 13 项、直接 MCP 单独通过 15 项，均不能独自作为宿主验收。复现见[接入说明](DOUBAO.zh-CN.md)。

## 0.2.0 发布验证（2026-11-05）

此前核验的 0.2.0 原始 tarball 已发布到 npm，注册表 integrity 一致，重新安装后 CLI 帮助验证通过。[GitHub Release](https://github.com/gxcsoccer/AgentHub/releases/tag/v0.2.0) 已公开。当前开发分支的 setup/豆包改动不属于 0.2.0。

`npm run check` 通过 215 项测试（统一层 151、保留的 Codex Bridge 41、验收脚本安全测试 23）；行/分支/函数覆盖率为 96.99% / 88.83% / 94.93%。安装包验证涵盖 5 个导出、两个 CLI、版本信息、HTTP、SQLite 和空事件游标恢复。0.2.0 的 Codex MCP / Claude CLI 隔离真实验收通过 8 项检查，包括双向请求/回复/结果、已加载会话发现和清理。原生范围仍为 macOS Codex 0.166.0 / Claude 2.1.318，未使用工作会话。私有报告位于忽略的 `.local/verification/release-0.2.0-*`。

## 2026-11-05：Claude CLI 激活与混合接入（0.2.0）

`npm run check` 通过 **130 项主项目 + 41 项 Bridge + 21 项测试进程安全检查，共 192 项**；主项目行/分支/函数覆盖率 **96.95% / 88.10% / 94.99%**。`npm run test:package` 通过临时打包安装、导出、CLI、HTTP 和 SQLite 检查。新增合同测试覆盖进程祖先/启动身份、UUID 切换、凭证分层与撤权、激活关联、文本回复不能确认激活、过期/显式重试、发现失败不能提交就绪、受限 CLI 入口与来源防伪。

`smoke:connector:cli -- --run` 在 macOS + Claude Code 2.1.318 上通过 **10 项真实检查**。脚本新建三个独立 PTY：两个在已启动并完成普通轮次之后通过生产所有者 CLI 激活；第三个禁用 Bash，原生收件并回复后依然保持未核验，重复 connect 没有重发。正向用例覆盖两个 Claude 主动发起、request/reply/result、Hub 正常重启保留激活与绑定、用户独立轮次之后收到关联结果、clear 后重新 connect 的新 UUID、旧在途回复不迁移，以及 result 无业务回复。

`smoke:connector:codex -- --run --claude-cli` 另通过 **7 项真实检查**，使用 Codex App Server 0.166.0 与 Claude 2.1.318：已有 Codex 根会话 MCP 安装与只读身份握手、已有 Claude CLI 会话原生激活、真实 MCP metadata、重复接入保留权限、两个跨 harness 方向的实际请求/回复/结果，以及结果终止。Codex 激活本身没有模型轮次；Claude 激活使用模型。全程没有 thread/resume 或原生动态回复工具。

两个成功 CLI 目标的精确命令许可由测试所有者在启动时设置；运行中 connect 未安装 skill/MCP/hook，未改宿主权限。来源由生产 Hub 独立核验进程链与原生目录，而不是采信 CLI 自报的祖先。初步独立探针通过 3 项检查，包含无 skills 目录时的触发与 clear 后新环境 ID；它不计入上述生产验收数。

失败记录也保留：初始探针的含环境变量命令被原有 Bash 权限拒绝；生产首轮将安全路径全部加引号，其命令同样被测试许可规则拒绝，connect 未返回成功。生成器现在仅在 shell 需要时引用参数；新建隔离会话重测通过，未扩大权限来放行。证据只证明这些具体命令和规则，不证明其他 Bash 权限组合。

私有 0600 报告：`.local/verification/connector-claude-cli-live.json`、`connector-codex-claude-cli-live.json`；失败证据为 `claude-cli-activation-spike.json`、`connector-claude-cli-quoted-command-live.json`，旁边保留终端日志。三 Claude 测试进程和混合测试的 Claude/App Server 均已退出；测试 Codex thread 已归档，临时目录与复制认证已删除。没有操作工作会话，私有证据不得发布。

边界：这是显式启用 `transport: cli` 后，在原有权限允许时的模型驱动激活，不是 Claude 外部 MCP reload，也不保证任意会话无需审批。用户插话仍为先结束独立轮次、再到结果；正常重启不替代强杀恢复。真实 busy 激活、完整并发/期限矩阵、队列入站后 clear、Linux/Windows/桌面/SDK 仍待扩展。连接器注册表更新为版本 3（兼容读取 1/2），新增激活元数据版本 1；核心消息存储仍为 schema 3。激活注册表上限 256，自动回收待补。操作见[接入说明](CONNECTOR_SETUP.zh-CN.md)。

## 2026-11-05：Codex 连接器与统一 connect（阶段 3 部分，0.2.0）

`npm run check` 通过 124 项主项目测试、41 项 Bridge 测试和 21 项测试进程安全检查，共 **186 项**；主项目行/分支/函数覆盖率为 **96.80% / 88.17% / 94.80%**。新增覆盖逐调用身份与连接启动标识核验、共享 MCP 进程的并发身份隔离、配置版本冲突、重复接入、只读握手和历史绑定不能冒充当前就绪。`npm run test:package` 通过临时打包安装、公开导出、CLI、HTTP 及 SQLite 恢复检查。

`npm run smoke:connector:codex -- --run` 在 macOS、Codex App Server 0.166.0、Claude Code 2.1.318 上通过 **6 项真实检查**：

1. 对安装 MCP 前已创建的空闲 Codex 根会话执行生产 `agenthub connect`，完成配置写入、reload、只读登记和就绪返回；此时未启动任何模型轮次。
2. 后续真实 Codex MCP 调用核验宿主 metadata 与连接启动标识，发现结果正确显示本会话的连接器回复状态。
3. 再次 connect 不重复 reload，保留现有工具权限。
4. Claude 发起请求，Codex 通过 `reply_agent` 回复，Claude 实际读取关联 result。
5. Codex 发起请求，Claude 回复，Codex 实际读取关联 result。
6. result 没有业务回复；全部过程未注册原生动态回复工具，也未调用 `thread/resume`。

首个所有者只读握手由原生 `mcpServer/tool/call` 注入 `threadId`；模型调用还带 `sessionId`，存在时必须一致。两条路径都校验当前实例的 MCP 启动标识。发现列表只对刚核验的来源报告连接器就绪，其他已配置 Codex peer 在 `ask_agent` 时核验，避免沿用旧动态工具状态误报缺失。

脚本只操作独立 App Server/home/socket 和新建 Claude PTY，Claude 启动时已加载连接器。测试所有者单独授权三个测试工具；安装器保留已有权限。测试结束已归档 Codex 会话、停止两个进程组、删除临时状态及复制的认证目录。私有报告为忽略目录中的 `.local/verification/connector-codex-live.json`；不得公开发布。

该证据覆盖空闲根会话及上述版本；不代表 Codex 忙碌时 reload、CLI/TUI/桌面入口、其他平台或任意 Claude 已有会话自动激活。reload 的范围是整个 App Server 实例。连接器配置和 caller grants 仍须所有者预先准备，自动配置生成、卸载和完整就绪诊断待补。接入方式见[配置说明](CONNECTOR_SETUP.zh-CN.md)。

## 2026-11-05：Claude 连接器核心（阶段 2，0.2.0）

`npm run check` 通过 119 项主项目测试、41 项 Bridge 测试和 21 项测试进程安全检查，共 **181 项**。主项目行/分支/函数覆盖率为 **96.96% / 88.84% / 94.55%**；新增覆盖进程身份、credential 分层、SQLite 重开、原生目录变化、分页上限、注册容量、名称歧义、撤权、跨会话回复、CLI 配置和官方 MCP 客户端闭环。

`npm run test:package` 也已通过：临时目录打包并安装 tarball，检查连接器公开导出、两个 CLI、HTTP 和 SQLite 恢复；包内没有私有报告或测试文件。

`npm run smoke:connector -- --run` 在 macOS + Claude 2.1.318 通过 **9 项真实检查**：两个原生 Claude MCP 进程自动登记；实际 ask/reply/result 闭环；Hub 正常重启后复用持久绑定和进程凭证；第二个 Claude 主动发起；等待期间用户完成独立轮次后收到关联答案；`/clear` 的真实 SessionStart 刷新；旧在途答案不跟随到新 UUID；新 UUID 重新完成闭环；result 不生成业务回复。

模型只获准三个 MCP 测试工具，无 shell/文件工具。测试启动时加载生产 CLI 和 hooks，Hub 只发现测试创建的两个 PID/cwd。最终报告确认两个进程组已退出、临时配置和状态目录已删除。报告为忽略目录中的私有 `connector-claude-live.json`，终端日志同目录；不得将私有报告发布。第一轮因 macOS `/tmp` 与 `/private/tmp` 的测试路径比较失败，修正脚本后重测；失败记录为 `connector-claude-live-path-failure.json`。

此项不是任意已有会话的外部自动激活验收。用户插话用例先完成用户轮次再投递结果，不证明全部忙碌时序；本轮使用正常 Hub 重启，不代表连接器强杀恢复。Linux 仅有进程读取 fixture 测试；其他宿主/平台、入队后 clear、真实 PID 复用、完整并发/期限矩阵仍待验收。[配置和明确边界](CONNECTOR_SETUP.zh-CN.md)。

## 2026-11-05：连接器阶段 1（0.2.0）

阶段 1 验收时，`feat/agent-connector` 分支实现 `messageKind`、两端结果渲染、回复入口/核心保护和 schema 3 兼容。当时自动身份登记、简化协作工具及 `connect` 尚未实现；后续进展见上方阶段 2。本节对应新实现，不替代下方历史验收范围。

- `npm run check`：103 项主项目测试、41 项保留 Bridge 测试、21 项测试进程安全检查通过，共 165 项；主项目行/分支/函数覆盖率为 96.48% / 87.85% / 93.98%。包含旧载荷幂等、HTTP/MCP 传递、强制回复拒绝、持久化及恢复保护。
- macOS、Claude 2.1.318、Codex 0.166.0，使用独立 App Server 和新建 allowlist 会话。修改后的 `smoke:isolated` 通过 7 项检查，Codex/Claude 均输出包含新结果 ID 和正文的模型观察标记，结果回执没有业务回复。
- `smoke:recovery` 通过 7 项检查，覆盖忙碌时显式重新 attach、Hub SIGKILL 后迟到回复与一次转发、持久 SSE 游标以及再次重启。结果由真实 Codex 输出确认读取，回执保留 accepted，无再次业务回复。
- 首轮恢复测试在结果验收前失败：旧脚本预期持久游标在重启后失效，与已有 schema 2 的持久事件语义冲突。修正为重放到 ready 且无 gap 后，独立新会话复测通过；失败记录保留，不能计为通过。

私有 0600 报告：`.local/verification/connector-isolated.json`、`connector-recovery.json`；失败记录为 `connector-recovery-stale-assertion.json`。测试进程均退出，测试 thread 全部归档/卸载，临时 App Server 与复制的测试认证目录均移除，未写入工作会话。这不覆盖连接器自动登记、Claude 自动激活或两个 Claude 自主协作。

schema 3 会升级旧存储，旧版程序拒绝读取；回退需使用升级前副本。验证只使用临时数据库，没有升级用户运行中的 Hub 状态。

[English](VERIFICATION.md)

## 自动化检查

```sh
npm ci
npm run check
```

连接器实施前的基线在 Linux/macOS 包含 97 项 AgentHub、原 Codex Session Bridge 的 41 项及 21 项真实验收脚本防护测试，共 159 项；当前本地结果见上方各阶段记录。检查同时执行格式、严格 TypeScript 和覆盖率门槛。原 Bridge 从自己的目录运行测试，保留其原始路径与契约。

新增测试覆盖：并发幂等、容量/过期、载荷冲突、不确定投递、提前/迟到回复、有限回复转发、关闭竞态、Codex 工具输出与显式审批、Claude 本地 socket 协议和反向回调、策略控制帧、损坏/过期回调、历史大小和游标变化、认证/Origin、非法 HTTP 请求、原有 JSON CLI 命令、真实 stdio 子进程中的七个 MCP 工具、SSE 慢消费者/CRLF/多行数据以及 OpenAPI 一致性。

Node 25.9.0 的 V8 统计显示，新代码编译产物 `dist/src/**/*.js` 的行覆盖率为 96.40%、分支 87.17%、函数 93.92%，不含原 Bridge 和真实 smoke 脚本。`npm run test:coverage` 强制总体门槛 90%/80%/85%，已纳入 check 和 CI。覆盖率不能证明穷尽行为或真实兼容。本轮测试发现并修复了非法 URL 返回 500、SSE 结束后继续写入、CRLF/数据块解析错误、构造失败遗留监听器和非 Error 异常处理问题。

新增测试覆盖 SQLite 事务回滚、保留期、损坏/schema/路径拒绝、写盘失败、单实例锁、HTTP/CLI 显式 attach 和保守的工具就绪判断。独立测试子进程在原消息提交、回复转发提交时被实际 SIGKILL，验证锁释放、不重发不确定消息、固定 ID 保留，以及模拟 Claude 迟到回复重新绑定原 socket 后只转发一次。

适配器单元测试使用假对端或 RPC，不代表真实模型已收到消息。完整检查已在本机 Node 22.23.2 和 25.9.0 上通过。CI 配置覆盖 Linux/macOS、Node 22/24/26，不使用真实凭证或执行模型测试；首个远端 CI 已通过 Linux／macOS Node 22／24 完整检查、Windows Node 22／24 的 11 项可移植测试及 Linux 合成负载检查；已发布提交 3b8a216 的七个发布 jobs 已全部通过：https://github.com/gxcsoccer/AgentHub/actions/runs/41842156518；发布后矩阵新增 Linux/macOS Node 26；本地空 npm 缓存安装也已通过。

## 真实跨 harness 验证

2026-11-04，在 macOS、Node 25.9.0、Codex CLI/App Server 0.166.0、Claude Code 2.1.318 上完成以下验收：

| 验收           | Claude 寻址                                                               | 结果                                      |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------------- |
| 私有 inbox     | 显式绑定新建测试会话和私有 socket                                         | 通过                                      |
| 默认 inbox     | 生产代码通过 `claude agents --json` 发现，使用 `/tmp/cc-socks/<pid>.sock` | 通过                                      |
| 入口与异常矩阵 | 默认发现/inbox，HTTP SDK、JSON CLI、MCP stdio 和 SSE                      | 14 项检查通过，含运行后的只读归档历史审查 |

最初两次使用本项目实际适配器和 Hub，验证以下闭环：

1. 在临时工作目录中新建 allowlist 中的 Codex thread 和独立 Claude 进程。
2. 向 Codex 发送工具输出；Codex 调用会话所有者注册的测试委派工具。
3. 经原生 inbox 将消息发送给 Claude。
4. Claude 用原生 `SendMessage` 回复 Hub 回调 socket。
5. Hub 将关联回复作为工具输出转发给 Codex；Codex 通过 `agenthub_reply` 确认。
6. 检查消息 ID、内容与历史身份：Codex 没有用户输入注入，Claude 保存 peer 来源。
7. 停止本次 Claude 进程，归档并确认卸载本次 Codex thread，删除临时工作目录。

最初每次四项功能检查均通过。扩展矩阵进一步验证：

- JSON CLI 经 HTTP 提交，SDK 驱动跨 harness 委派，独立 stdio 进程逐个调用该历史验收当时的六个 MCP 工具，SSE 返回关联回复。
- Claude hold 后释放、refuse、相同载荷重试和不同载荷冲突、忙碌排队、状态等待超时与迟到回复。专用 gate 工具确保目标确实处于忙碌状态。
- Codex 忙碌时加入同一 turn、去重、显式回答 gate，以及没有回复工具的会话接收消息后仍不虚报关联回复。
- 传输断连时报告缺口、保留回执、重新读取历史，不自动重发或 attach。
- 故障代理将消息转交真实 Claude inbox 后故意不关闭传输：提交方报告 unknown，原生历史证明消息已投递一次，同 ID 重试不重发。
- Claude 目标退出后拒绝新输入，不自动恢复；两个测试 Codex thread 的原生历史身份与工具范围检查。

清理结果为 `allOwnedUnloaded: true`、`onlyOwnedSessionsMutated: true`，矩阵会有意停止自己的 Claude 目标。没有向已有工作会话发消息、恢复、中断、回答审批或修改配置。Claude 原生 peer 身份对应 Hub 进程；上游作者保存在 envelope 中，不是另一个经过认证的原生 peer。

**恢复能力补充：**早期矩阵因 turn/start 不恢复监听关系，在 Codex 重连后等待关联回复超时；失败证据仍保留在 `.local/verification/entrypoints-matrix-reply-recovery-failed.json`。现在已提供所有者显式 attach，未实现静默恢复。

新增真实恢复验收的 **6 项功能检查与清理全部通过**，报告为 `.local/verification/recovery.json`：

1. 只读就绪检查，拒绝未加载或无法核验工具的目标，无隐式 resume。
2. Codex 在测试 gate 中忙碌时断连，显式重新 attach 后原轮次继续并返回关联回复。
3. 让真实 Claude 在回复前等待，SIGKILL Hub 子进程，以同一个 SQLite 文件重启、显式重新 attach Codex，再释放 Claude；原生 SendMessage 回到原 socket，回复只转发一次并收到 Codex 确认。
4. 再次重启，完成回执和转发 ID 仍在；同载荷去重，不同载荷冲突。
5. 三次显式 attach 保持模型、目录、审批策略/reviewer、read-only 沙箱和关闭执行网络不变。
6. 原生历史身份及提交次数准确：Claude 一条 peer 消息，Codex 三条工具输出（包含控制器初始化）；没有 shell、文件、网页操作或用户输入注入。

本次使用新建 Claude 进程的显式私有 inbox 和三个 allowlist 中的 Codex thread。测试进程全部退出，Codex 测试会话全部归档/卸载，写操作只作用于这些会话。不证明 Hub 停机期间回调可重放、机器断电恢复、任意会话动态装工具或监听自动恢复；该历史验收当时使用进程内 SSE；新增 schema 2 已单独覆盖持久游标。

恢复改动完成后再次运行原有真实矩阵，14 项运行内检查全部通过，报告为 `.local/verification/entrypoints-matrix-after-recovery.json`，归档/卸载和测试进程清理成功。此前 14 项报告额外包含一次运行后的只读审查，两者分开记录。

两份前置失败报告保留：`recovery-first.json` 发现刚创建但从未运行的 Codex 会话可能尚未持久化工具元数据，此时正确返回 unknown；`recovery-second.json` 的六项功能检查通过，但清理时重复归档了已归档会话。最终脚本先初始化自己的隔离已有会话，并记录已完成的清理动作。

手动复现需要已运行的 Codex App Server 和已登录的 CLI：

```sh
# 不带 --run 不执行真实动作。
npm run smoke:isolated
npm run smoke:isolated -- --run --report .local/verification/cross-harness.json
npm run smoke:isolated -- --run --default-inbox --report .local/verification/cross-harness-default.json
npm run smoke:isolated -- --run --default-inbox --matrix --report .local/verification/entrypoints-matrix.json
npm run smoke:recovery -- --run --report .local/verification/recovery.json
```

脚本会消耗模型额度。历史测试使用 untrusted 审批；当前隔离脚本使用 on-request 审批（新建 Codex 配置已拒绝 untrusted）、read-only 沙箱、关闭执行网络和限定测试工具；Claude 开放 `SendMessage`，仅在矩阵/恢复测试中额外开放本地 gate MCP 工具，不提供 shell 或文件工具。控制器只改变新建测试 Claude 进程的接收策略。原生日志仍保存在各自历史中。报告含私有会话与环境信息，权限为 0600，仅存于忽略的 `.local/verification/`，不可公开发布。

## 只读 doctor 验收

新增 8 项自动测试覆盖诊断的 GET-only 行为、缺少/未 attach 的回复工具、Claude opt-in/版本/inbox 区别、认证失败、超时不重试、非法响应、局部故障、32 实例/4 并发上限、内容省略和 CLI 退出码。

本机真实只读检查完成三项：默认实例诊断、一个已加载 Codex 根会话、一个运行中 Claude 会话。Codex 目标如实返回缺少回复工具的 warning；Claude 报告声明的能力及 `processVersionVerified:false`。报告为 `.local/verification/doctor-readonly.json`。原生 RPC 被限制为 thread/list、thread/loaded/list、thread/read；所有 HTTP 请求均为 GET，未发送、attach、建立回调或改变已有会话。此测试不代替上文的真实收发验收。

```sh
npm run smoke:doctor -- --run
```

## 验证边界

- 矩阵覆盖上述具体场景，不代表所有组合、长时间负载、全部审批子类型或所有 harness/provider 版本。主要 CLI 命令和 MCP 工具逐个执行，分支覆盖仍非 100%。
- 未验证豆包运行时，Windows 原生模型收发尚未实测、任意已有会话动态注册工具，也不等价于 Codex 原生 agent mailbox。
- MCP 已通过真实 stdio、HTTP 连接到实际 harness，但仍不证明豆包接受某个插件配置。
- 原 Bridge 历史上的 22 操作真实验收见 `vendor/codex-bridge/docs/VERIFICATION.zh-CN.md`；不代表本次重新实测了这 22 项，也不代表已将它们全部统一为新 API。
- 安装的 CLI 版本不能证明每个已运行 Claude 进程的版本。原生协议适配仍为需要显式开启的指定版本实现。

## 安装包

`npm pack` 会先编译。包的白名单包含编译后的库/CLI、原 Bridge、许可证、schema、文档和示例，不包含真实报告、调研缓存或测试会话。发布前应在空临时项目中安装 tarball，验证五个导出入口和两个 CLI 的 help，再执行完整检查。检查和 smoke 命令不会发布包。

## 扩大验收（2026-11-04）

smoke:claude-initiated -- --run 通过五项检查：真实 Claude 模型主动调用 MCP，分别向两个逻辑 Codex 实例发消息并查询关联回复；两个连接共用一个 App Server，不等同两个独立后端。验证历史／全文检索不串线，错误实例地址被权限拦截。两个新建 Codex 会话均已归档，Claude 子进程退出。私有报告：.local/verification/claude-initiated.json。

新增自动测试覆盖调用方发现／历史／回执／SSE／审批隔离、私有凭证文件、事件 schema 迁移与原子回滚、全文扫描，以及官方 ACP SDK 与真实 fixture 子进程互通。fixture 不是 coding 模型；Windows pipe 测试也不等于原生 Claude 模型收件。详见[扩展边界](EXTENSIONS.zh-CN.md)。

120 秒合成负载通过：3,352 次 HTTP 提交、442 次重复提交核验、23 次 SQLite／服务重开；原生提交次数与唯一请求一致，事件游标跨重启保留。GC 后堆增长约 3.7 MiB、RSS 增长约 69.4 MiB，活动资源始终为 4。这是有界负载验收，不代表长期生产稳定性。更长运行和远端 CI 完成后单独记录。

十分钟合成负载通过：16,432 次唯一提交、2,168 次重复核验、114 次服务／SQLite 重开；原生提交次数没有增加，文件描述符始终为 21，GC 后堆增长约 4.04 MiB，RSS 增长约 89.69 MiB，均在脚本阈值内。私有报告 .local/verification/soak.json。不是十分钟真实模型负载，也不证明更长时间运行无泄漏。

## 发布后验收（2026-11-04）

复现与隔离方式见[真实后端验收](ACCEPTANCE.zh-CN.md)。该阶段 Node 26.12.1 本地检查通过 95 项 AgentHub 与 41 项原 Bridge 测试，共 136 项；覆盖率为行 96.41%、分支 87.46%、函数 93.96%。tarball 安装验证了五个导出入口、两个 CLI、HTTP、SQLite 和空事件游标恢复。真实模型测试仍需显式执行，不进入无凭证 CI。

| 验收                 | 实际后端版本                                                                  | 结果                                                           |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 当前版本 ACP         | Claude ACP 0.100.0 + Claude 2.1.318；Codex ACP 2.5.0 + Codex 0.166.0          | 7 项通过，包含实际回复、去重、历史隔离、连续对话及后代进程退出 |
| 相邻版本 ACP         | 同样的 ACP adapter；Claude 2.1.317、Codex 0.165.0                             | 同样 7 项通过                                                  |
| 独立 App Server      | Codex 0.166.0 和 0.165.0，各自独立进程／home／socket；Claude 2.1.318 主动调用 | 7 项通过，含原生存储隔离、两次实际 MCP 往返和单后端退出隔离    |
| 相邻版本原生消息矩阵 | Codex 0.165.0 / Claude 2.1.317                                                | 14 项通过，测试会话归档／卸载                                  |
| 当前版本原生消息矩阵 | Codex 0.166.0 / Claude 2.1.318                                                | 收紧排队消息测试指令后 14 项通过，测试会话归档／卸载           |

私有报告位于 `.local/verification/`：`acp-live-final.json`、`acp-live-previous.json`、`independent-backends.json`、`compat-codex-0165-claude-2317.json`、`compat-codex-0166-claude-2318-gate.json`。ACP 使用新建托管会话，不恢复工作会话。矩阵只覆盖列出的两组组合，不代表所有版本交叉组合或 provider；独立后端位于同一台机器，不代表远端多机验收。本次未扩展 Windows 和豆包。

当前版本矩阵首次在 Codex 忙碌场景失败：原生历史证明第二条消息在同一轮出现一次，但模型只回复第一条便结束，没有为第二条给出关联回复。失败保留在 `compat-codex-0166-claude-2318.json`。测试指令现明确要求先处理所有已送达消息再结束；gate 提醒不包含消息 ID 或正文，不能代替原生投递。这是测试指令调整，不是传输保证，也没有自动重发原消息。后端接受和历史落盘仍不证明模型已处理或一定回复。

另保留 `acp-live-first.json`、`independent-backends-first.json`：新启动 Codex 的配置文件拒绝 `approval_policy="untrusted"`。当前脚本使用 on-request 审批，继续限制只读执行。原先创建失败即关闭后端的行为已在 PR review 中修正，见下文。

30 分钟合成负载通过：macOS arm64 / Node v26.12.1，49,856 次唯一 HTTP 提交、6,579 次重复核验、347 次服务／SQLite 重开。原生调用数与唯一请求数一致，持久事件游标在重开后保留。相对首次采样，GC 后堆变化 4.01 MiB、RSS 变化 48.55 MiB；采样文件描述符 21–21，活动资源 4–4，全部在脚本阈值内。私有报告：`.local/verification/soak-1800.json`。这是合成适配器结果，不是模型吞吐量或生产可靠性保证。

代码提交 304ec1a 的九个 [CI 任务](https://github.com/gxcsoccer/AgentHub/actions/runs/41847300219) 全部通过，覆盖 Linux/macOS Node 22／24／26、Windows Node 22／24 可移植子集及合成负载。已下载并核验上传的合成报告：Linux x64 / Node 24.22.2，30 秒、816 次唯一提交、五次重开。独立的手动负载工作流合并到默认分支后才能触发；未将本次未合并 PR 描述成已完成该手动触发验收。

## PR review 修复（2026-11-05）

回归测试在修复前复现了两类缺陷：ACP 创建失败会关闭正在等待审批的另一会话；启动包装器的等号／多值参数可绕过测试限制。修复后测试通过。创建结果不确定时只阻止后续创建，已有会话可以继续审批、回复及后续 prompt，无须重启后端；明确的参数拒绝允许再次创建。

Node 26.12.1 上 `npm run check` 通过 97 项 AgentHub、41 项原 Bridge、七项启动／清理测试，共 145 项。源码覆盖率为行 96.43%、分支 87.40%、函数 93.98%。`npm run test:package` 再次验证五个导出入口、两个 CLI、HTTP、SQLite 和空事件游标恢复。

受影响的真实 ACP 验收使用 Claude 2.1.318 / Codex 0.166.0 和相同固定版 ACP adapter，七项通过；独立后端使用 Codex 0.166.0 / 0.165.0、Claude 2.1.318，七项通过。两组均确认测试进程退出。私有报告为 `.local/verification/` 下的 `review-acp-live.json`、`review-independent-backends.json`。独立后端凭证 home 已移到模型工作目录之外，故障隔离断言等待 RPC 实际断开。本次修复未重跑未改动的 30 分钟负载和相邻版本原生矩阵。

## Review 后续修复：清理与恢复（2026-11-05）

本地检查通过 97 项 AgentHub、41 项原 Bridge、18 项脚本防护测试，共 156 项；源码覆盖率为行 96.43%、分支 87.27%、函数 93.98%。最后调整 UTF-8 输出捕获和失败命令诊断输出保留后，脚本测试再次通过。新增用例覆盖直接启动时变量真正不存在、主命令先于抗 TERM 后代退出、控制器 IPC 丢失、监督进程意外丢失后不向旧组发信号、受限输出捕获／失败／超时，以及后代发现、关闭或退出检查失败后的凭证删除。首次控制器断开测试等待 `close` 事件超时，实际进程和管道已退出；现直接检查这两个真实后置条件。失败记录保留在私有 `review-followup-check-first.log`。

真实 ACP 使用 Claude 2.1.318 / Codex 0.166.0，七项通过，确认后代退出并报告 `credentialsRemoved: true`。独立原生后端使用 Claude 2.1.318、Codex 0.166.0 / 0.165.0 和新监督进程，七项通过。私有报告为 `.local/verification/review-followup-acp-live.json`、`review-followup-independent-backends.json`。安装包再次通过五个导出入口、两个 CLI、HTTP、SQLite 和空事件游标恢复验证。原生协议和负载代码未变，本次未重跑完整版本矩阵和 30 分钟合成负载；兼容性运行器的新命令包装由确定性命令测试覆盖，没有将其描述成重新完成全部原生矩阵。

最后的诊断修复：`npm run check` 通过 159 项测试（97 项 AgentHub、41 项 Bridge、21 项脚本测试）。新增三项隔离进程用例，验证二次清理失败时仍保留原始命令／启动异常和 stderr，且单独清理失败仍会报错。保留三秒宽限期，因为主命令退出不能证明后代完成清理。本次仅修改错误报告，未重跑真实模型验收和长时间负载。

## 连接器 PR 评审修复（2026-11-05）

回归测试覆盖九条意见：无关的大目录/离线实例返回发现缺口，不再阻断 Claude 别名或激活；同 harness 发现不完整时仍拒绝无法消除歧义的别名；新的迟到回复在确认接受前拒绝；以 `-` 开头的 CLI 消息可完成 ask/reply；failed/rejected 激活可见且可显式重试，unknown 保留原意图；过期激活记录回收后仍保持有界防重发；凭据刷新保留消息 ID/期限且不重试不确定投递；Codex 检查多个 profile；重复/并发 connect 避免连续 reload；一次 CLI 登记加完整地址 ask 使用三次原生查询，保留发送前的新核验。旧激活记录从 v1 升级 v2，并验证防重发过滤器饱和时仍保守地要求显式重试。

`npm run check` 通过 208 项（AgentHub 144、保留的 bridge 41、runner 安全测试 23）。源码覆盖率：行 96.97%、分支 88.75%、函数 94.83%。打包安装验证通过五个导出、两个 CLI、HTTP、SQLite 和事件游标恢复。大目录、凭据过期、容量、多 profile 与 reload 冷却使用确定性 fixture，未测量它们的原生规模/耗时影响。

macOS 真实隔离验收通过 Claude CLI 的 10 项（Claude 2.1.318），包括 Bash 不可用、重启、等待期间用户插话和 clear 隔离；Claude CLI / Codex MCP 双向验收通过 7 项（Codex 0.166.0）。均确认自有进程退出、测试 thread 归档和临时目录/认证清理。私有报告：`.local/verification/pr2-fix-connector-claude-cli-live.json` 与 `pr2-fix-connector-codex-claude-cli-live.json`。

首次跨 harness 尝试在模型调用工具前停止：早期 Codex `thread/read` 返回空的 interrupted turn，且没有完成时间。原 runner 将任何非 inProgress 快照视为终态。现在先等待匹配的原生 `turn/completed` 通知，再读取 completed 历史；通知可先于启动响应，真实中断/超时仍报错且不重发。新增两个 runner 测试覆盖该竞态及监听清理。首次失败和自有资源清理证据保留于私有 `pr2-fix-first-connector-codex-claude-cli-live.json`；新的隔离运行通过全部 7 项。本次未重跑 Windows、相邻版本矩阵和长时合成负载。

## 连接器后续意见收尾（2026-11-05）

三条非阻塞意见均已处理。Codex 协作发现改为分页查询已加载会话，保留普通历史列表和按会话授权的读取边界。修复前只读抽样中，历史列表前 100 条有 99 条 notLoaded，已加载列表仅 1 条；这不是全部历史数量统计。测试使用 1,100 条历史会话，以及分页已加载根会话、子会话和卸载竞态，验证协作发现、别名发送均无需扫描历史。

激活回收优先未验证的过期记录，只清理本次接入所需数量；替换同一 key 不回收其他记录。测试验证正常会话保持已验证状态，防重发规则仍成立。凭据记录保留 60 秒的过期分类宽限期；HTTP 测试在请求发出后跨过到期边界，并由另一登记写入注册表，验证仅续期一次、消息 ID/期限不变且只提交一次。过期凭据始终无效，所有者撤销优先，宽限期结束后正常清理。修复前有六项回归断言失败，修复后全部通过。

`npm run check` 通过 214 项（AgentHub 150、保留的 bridge 41、runner 安全测试 23）；源码覆盖率为行 96.99%、分支 88.82%、函数 94.93%。打包安装再次通过五个导出、两个 CLI、HTTP、SQLite 和事件游标恢复。macOS Claude 2.1.318 / Codex 0.166.0 新建隔离验收通过 8 项，在 CLI/MCP 双向收发基础上新增原生已加载会话发现检查。自有进程退出、测试 thread 归档、临时目录和复制认证清理均已确认。私有报告：`.local/verification/pr2-closeout-connector-codex-claude-cli-live.json`。大目录与容量边界属于确定性 fixture 覆盖；本次未重复独立的 Claude-only 10 项验收、相邻版本矩阵、Windows 真实接入或长时负载。
