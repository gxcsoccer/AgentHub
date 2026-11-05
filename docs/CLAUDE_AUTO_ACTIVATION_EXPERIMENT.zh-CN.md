# Claude 会话外自动激活实验

[English](CLAUDE_AUTO_ACTIVATION_EXPERIMENT.md) · [接入设计](AGENT_CONNECTOR.zh-CN.md) · [插件热加载](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.zh-CN.md)

2026-11-05，macOS / Claude Code 2.1.318。目标是所有者执行一次外部 CLI，完成已有会话的安装和激活。**手动 `/reload-plugins` 不满足这个目标。** 当前没有验证出普通已有 Claude 终端会话可用的外部 MCP reload 接口；另一个 skill → CLI 候选在限定条件下成功，但尚未完成稳定性及生产接入验收。

## MCP：外部安装与原会话激活是两个步骤

新建非 strict 交互会话，真实模型先调用已有 keep MCP。随后从独立进程安装唯一命名的本地测试插件，再用 `claude mcp add --scope local` 添加另一个 server，两项配置仅作用于测试项目。

| 操作                                          | 实际观察                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| 外部安装插件后等待，再要求模型调用            | 观察窗口内没有插件 MCP 进程，25 秒内没有目标工具调用；模型报告 MISSING_TOOL |
| 外部添加普通 local MCP 后等待，再要求模型调用 | 25 秒内没有目标工具调用；模型报告 MISSING_TOOL                              |
| 再调用原有 keep MCP                           | 真实调用成功，排除整个会话或工具通道失效                                    |
| 原终端执行 `/reload-plugins`                  | 插件 MCP 启动，真实模型调用成功，原 Claude PID/UUID 不变                    |
| 卸载插件并在原终端 reload                     | 新插件工具移除                                                              |

这是有正向对照的有界观察，不是对所有未来版本、宿主和等待时长的否定证明。普通 local MCP 没有单独做退出后重启的正向对照，不能把插件成功推广给它。

本机 CLI 帮助、消息入口检查及官方文档没有提供已验证的普通会话外部 reload 路径。原生消息会跳过 slash command 执行；因此给会话发送 `/reload-plugins` 文字不等于所有者控制操作。[消息边界](https://code.claude.com/docs/en/cross-session-messaging#how-a-session-treats-an-incoming-message)

SDK 的 `Query.setMcpServers()` 面向已由 SDK 持有的会话。预先启用的插件目录监听、开发 mod 和受控 PTY 也各有宿主前提；它们不能作为对任意已有终端完成接入的证据。本轮未验证 SDK、桌面、后台 attach 或终端自动化。[SDK 参考](https://code.claude.com/docs/en/agent-sdk/typescript#mcpsetserversresult)、[mod 开发流程](https://code.claude.com/docs/en/plugins/mods/create)

## 候选：原生消息 → skill → CLI

不加载新的 MCP，利用 Claude 已有 Skill 和 Bash 工具调用一个本地 CLI。第一次组合实验中，在启动前已存在的项目 skills 目录添加 skill；模型通过正常用户请求加载它并执行 CLI，发生在任何插件 reload 之前。

随后用独立会话补测原生消息和 clear：

1. 启动仅开放实验用 Skill、Bash 和原生 SendMessage 的会话；项目 skills 目录及无副作用的 baseline skill 在启动前存在，先实际调用 baseline。
2. 会话运行中从外部添加新的测试 skill。skill 没有 `allowed-tools`，不会自行授予工具权限。唯一 CLI 命令的许可在测试会话启动时设置。
3. 控制器向这个测试会话的原生 inbox 发送普通协作请求。模型实际调用新 Skill，再执行 CLI，输出和独立日志均含预期 marker。
4. CLI 的 `CLAUDE_CODE_SESSION_ID`、skill 的 `${CLAUDE_SESSION_ID}` 与原生目录 UUID 相同；CLI 进程的祖先链包含目标 Claude PID。
5. 在测试终端执行 `/clear`，再次通过原生消息触发。新调用的两个 UUID 均更新为新会话，宿主 PID 保持不变。

这一成功运行通过 3 项检查：无需 reload 的原生触发、CLI 身份对应、clear 后身份更新。整个运行没有安装 MCP，也没有执行 `/reload-plugins` 或 `/reload-skills`。这里的 CLI 只记录隔离测试身份，**不是完整 AgentHub 登记、授权和双向协作验收**。测试进程自行记录祖先链只作为证据；生产 Hub 必须独立核验，不能信任调用者提交的 PID 或 UUID。

### 失败尝试和适用边界

- 一个初始夹具生成了错误的 JavaScript 换行：模型成功加载 skill 并尝试执行，CLI 解析失败。修正夹具后重新建会话验证，失败报告保留。
- 两次启动时仅有空 skills 目录的运行，原生消息后模型报告 MISSING_SKILL，没有 CLI 调用。一次先完成过普通对话。它们缺少同次运行的 reload 正向对照，不能据此断言文件监听完全失效。
- 最终成功运行同时增加了 baseline skill、项目 settings 文件，并明确要求尝试 Skill 调用。尚未隔离这些因素，**不能认定仅检查目录存在就足以保证成功**。
- 顶层 skills 目录在启动后才创建的独立运行，30 秒内没有 CLI 调用；随后显式 `/reload-skills`，同会话通过原生消息实际执行 CLI。后者只是正向对照，不计为自动激活成功。

官方说明既有 skills 目录支持当前会话内的文件变更；启动后才新建顶层目录需要 `/reload-skills`。skill 文件变化的监听不包含插件的 MCP/hooks 等配置。实际接入仍要检查宿主策略、Skill/Bash 可用性和命令权限。[Skills 文档](https://code.claude.com/docs/en/skills#edit-a-skill-during-a-session)

## 产品决策和下一项验收

统一 `agenthub connect` 保持“安装 + 激活 + 核验”的目标。普通 Claude MCP 路径目前仍有控制接口缺口，不能把手动操作提示当作全自动成功。

skill → CLI 是值得继续验证的替代传输，尚未选为生产默认：先隔离目录监听和工具发现的条件，再接入受限凭证、Hub 独立身份核验、真实请求/回复及撤权测试。它可能需要一次真实模型调用才能确认可用；只读诊断不能偷偷启动这一轮。安装范围与会话授权仍分开，不能为获得监听而自动扩大到用户级 scope，也不能通过 skill 自动放宽 shell 权限。

## 私有证据与清理

忽略目录中的 0600 报告：`claude-auto-activation.json`（9 项组合检查）、`claude-skill-auto.json`（3 项原生/身份检查）、`claude-skill-auto-absent-root.json`（1 项显式 reload 正向对照）。失败报告保留为 `claude-skill-auto-fixture-error.json`、`claude-skill-auto-first-turn-missing.json`、`claude-skill-auto-prewarmed-missing.json`。

脚本为 `.local/lifecycle-spike/auto-activation.mjs` 和 `skill-auto.mjs`。原插件实验的摘要文件曾被后续驱动复用，已从保留的原始终端/进程日志重建并标注；本轮报告使用独立名称。私有报告和原始记录均未发布。

实验仅操作新建测试会话和临时项目。测试插件、marketplace 和 local MCP 配置已通过原生命令移除；测试 skill 已删除，进程已退出。没有修改实际工作会话。生产 `src/` 和已发布包未改变。
