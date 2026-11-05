# 连接器安装、授权与生命周期实验

[English](CONNECTOR_LIFECYCLE_EXPERIMENT.md) · [设计提案](AGENT_CONNECTOR.zh-CN.md) · [前序收发实验](CONNECTOR_ROUNDTRIP_EXPERIMENT.zh-CN.md)

日期：2026-11-05。环境：macOS、Claude Code 2.1.318、Codex App Server 0.166.0、Node 26.12.1。

本轮继续用隔离真实会话验证安装生效、登记权限、重连、恢复和会话切换。主实验通过 **14 项检查**；另外完成一次 Codex 已运行 thread 的 MCP 热加载正向复验，以及一次带前后正向对照的 Claude 旧 ID 投递实验。生产 `src/` 未改动，结论是原型可行性，不代表接入套件已交付。

## 安装与停用

| 实验                         | 实际观察                                                                                                                                 | 对接入流程的约束                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Codex 已有 thread 加载新 MCP | 创建时无该 server；写入隔离 home 配置并调用 `config/mcpServer/reload` 后，同一 thread 的真实模型成功调用新工具，逐调用身份正确           | App Server 路径可提供显式 reload；需要检查实际工具连接和调用，不能仅凭写入配置宣告就绪 |
| Claude 运行中修改 MCP 配置   | 使用 `--strict-mcp-config --mcp-config <file>` 启动；文件中新增 server 后，模型未调用到工具，`/mcp reconnect lifecycle` 报 server 未找到 | 此配置入口按下次正常启动生效设计；本轮未验证普通项目配置或插件的动态安装               |
| Claude 停止后显式恢复        | 测试控制器退出自己的 Claude，再以同一 UUID `--resume`；新 MCP 加载且模型成功调用                                                         | 已验证正常停止后的恢复；不能用并发 resume 接管工作会话                                 |
| Claude 运行中安装 hook       | 写入自有 `.claude/settings.json`，等待文件监听，再输入测试请求；实际观察到 UserPromptSubmit                                              | hook 配置可在该路径热生效；hook 生效不等于新 MCP server 已加载                         |
| 修改配置时工具正忙           | 安装前开始的 MCP gate 工具在修改配置后继续完成                                                                                           | 本次安装没有中断正在运行的测试工具                                                     |
| 停用与卸载                   | 停用 profile 后，现有 MCP 调用立即被拒绝；恢复原 MCP/settings 配置后，无关的 `keep` 条目仍存在且被模型调用                               | 停用先由 Hub 拒绝业务操作；删除配置的宿主生效时机单独处理                              |

卸载检查验证了配置保留及无关工具的实际调用。`keep` 复用了同一个实验 helper，调用登记服务时仍得到 profile_disabled，因此不能把这项检查扩大为任意第三方 MCP 的完整功能验收。

Codex 的早期尝试中，catalog 已 connected、直接 `mcpServer/tool/call` 成功，但模型两次回答 MISSING_TOOL。独立复验才观察到模型真正调用。复验提示允许宿主工具发现，不过最终原生记录只有 MCP 调用，没有工具搜索调用；尚不能归因于某个发现机制。配置 reload 可行，不代表每次模型都会选择调用工具。官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server)描述了 reload；Claude 的 [MCP](https://code.claude.com/docs/en/mcp) 和 [settings](https://code.claude.com/docs/en/settings) 文档另列重连及配置更新机制，本轮结论限于上表实际测试的入口。

## 登记、权限与恢复

实验增加了独立的本机登记服务。它核验 helper 的 UID、实际 PPID、父进程启动时间、原生目录及测试资源白名单；SQLite 保存绑定和连接器凭证摘要。真实模型通过 MCP 发起以下操作：

| 场景                   | 观察                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 登记凭证与业务凭证分离 | 登记凭证能登记身份；用它直接调用业务入口得到 401                                                                                               |
| 会话 grants            | 允许读取的测试 Codex thread 返回成功；另一个测试 thread 被生产 `AgentHub.getSession` / AccessPolicy 拒绝，日志确认拒绝发生在该目标原生读取之前 |
| 服务进程重启           | 正常停止登记服务，再启动新 PID；原 MCP 进程保留的凭证仍可用，恢复出相同 bindingId                                                              |
| MCP 重连               | Claude `/mcp reconnect lifecycle` 创建新 MCP PID；重新登记得到相同原生 UUID 和 bindingId                                                       |
| 凭证撤销               | 所有者提高 profile epoch 并轮换登记凭证；旧连接器凭证被拒绝，下一次明确调用使用新凭证重新登记。失败操作没有被自动重试                          |
| profile 停用           | 无需重启 Claude，后续调用得到 profile_disabled                                                                                                 |
| 停止后 resume          | 原生 UUID 和绑定保持一致，连接器重新核验                                                                                                       |
| 停止后 fork            | `--fork-session --resume` 产生新 UUID 和新绑定                                                                                                 |

主实验的 14 项检查包含安装前两端会话确实已运行、配置修改期间工具连续性、恢复后加载、hook 生效，以及上表权限与生命周期行为。它验证了凭证分层、读取授权和正常重启的机制；没有验证所有业务操作的授权、强杀期间的事务恢复或在途消息重放。登记服务仍是实验实现，同一 OS 用户仍是信任边界。

## 目录检查后发生 clear

主实验最初只向旧 UUID 发消息，没有新 UUID 的正向对照，无法据此判断原生过滤。补充实验重新创建隔离 Claude，执行：

1. 向当前 UUID 发原生消息，真实模型调用 MCP，确认通道有效。
2. 保存目录中的 UUID/PID，再 `/clear`；确认 UUID 变化而 PID 保持不变。
3. 使用保存的旧 UUID，向同一 PID 的 inbox 写入带独特正文标记的消息；观察 20 秒。
4. 向新 UUID 写入另一条消息；模型成功调用 MCP，确认 clear 后通道仍有效。
5. 读取新会话完整的本次测试历史：旧正文标记不存在，也没有旧消息触发的工具调用。
6. 再把旧会话结果的句柄发给新 UUID；新会话实际调用领取入口，服务以 result_for_different_session 拒绝，未返回答案正文。

这支持已测版本在该顺序下隔离旧 ID，并验证了领取入口的身份校验。它不是所有调度时序的原子性证明；观察窗口有限，也未覆盖消息已经入队后才 clear、PID 实际复用或断电恢复。领取句柄是额外的原型防线，尚未加入 v1 必选接口；当前设计保留 UUID、bindingId、逐次核验和缺失证据时暂停回程。

## 证据与清理

私有报告均为 0600，位于忽略目录：

- `.local/verification/connector-lifecycle.json`：14 项检查、实际调用、hook、登记和清理日志。
- `.local/verification/codex-hotload-discovery.json`：同一 thread 的安装前后模型记录和 MCP 身份。
- `.local/verification/connector-native-race.json`：前后正向对照、旧消息观察、新会话历史及跨会话领取拒绝；含 2 项显式检查与竞态观察字段。
- `connector-lifecycle-first-reload-attempt.json`、`connector-lifecycle-hotload-attempt.json`：保留的前序失败尝试。后者暴露了驱动误把终端重绘的提示文本当作完成信号，之后改为等待实际 probe 事件。

本机脚本在 `.local/lifecycle-spike/`：`run.mjs`、`codex-hotload.mjs`、`race.mjs`、`probe.mjs`、`registration-server.mjs` 和 PTY helper。它们依赖本机身份实验夹具，不是已发布的通用 smoke 命令。

测试使用新临时目录、独立 Codex home/socket、自有 Claude 会话和进程组；写入目标均在测试白名单中。全部测试进程退出，Codex 测试线程归档，复制的认证目录和明文登记配置被删除。没有向工作会话发送、恢复、改名或中断操作。

首版在这些宿主上的身份、收发及基本生命周期已有实验依据。正式实现仍需把原型机制接入生产配置/存储，完成两个 Claude 模型主动协作、用户插话、并发乱序、结果回复拒绝、期限边界和强杀恢复验收。Codex CLI/桌面、共享 MCP 进程、Linux 原生身份及 Windows 均不在本轮支持结论中。后续[插件热加载实验](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.zh-CN.md)已验证交互式 Claude CLI 中动态安装 MCP 的独立路径。
