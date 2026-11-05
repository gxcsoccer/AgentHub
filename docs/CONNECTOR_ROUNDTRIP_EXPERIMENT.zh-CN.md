# 自动登记与跨 harness 收发实验

[English](CONNECTOR_ROUNDTRIP_EXPERIMENT.md) · [身份实验](SESSION_IDENTITY_EXPERIMENT.zh-CN.md) · [接入设计](AGENT_CONNECTOR.zh-CN.md)

日期：2026-11-05。环境：macOS、Claude Code 2.1.318、Codex App Server 0.166.0、Node 26.12.1。

本轮从“读取身份字段”推进到**实验连接器自动归因、名称解析、原生发送、关联回复、结果回程和模型读取**。最终运行 8 项检查通过：5 条请求收到 5 条原生回复，4 条结果被来源模型实际读到，1 条旧会话结果被保留且停止回程。测试使用固定标记验证通信，不评估复杂协作任务质量。

这是隔离原型验收，**不是已发布 AgentHub 接入套件的验收**。生产 `src/` 未修改。

## 实际运行链路

实验连接器提供 `ask_agent(to, message)`。模型参数只有目标名称和正文；来源 ID、请求 ID、绑定及回程均由连接器生成。Claude 启动环境及 hook、Codex MCP 的逐调用 metadata 是真实宿主提供的数据，未在 MCP 配置中手工注入会话 ID。

本机实验 HTTP registry 核验同一用户下的进程父子关系、父进程启动时间、原生目录和自有进程/会话白名单。请求复用现有 AgentHub 核心及两端 adapter；Codex 使用 `agenthub_reply`，Claude 使用原生 `SendMessage` 返回关联答案。

结果回程由实验代码渲染，使用 Codex `toolOutput` / Claude 原生 inbox，省略回复模板。来源模型实际调用测试专用 `record_result(request, text)` 后才记为已读。该工具只记录观测，不发消息。实验没有通过现有生产 adapter 的结果渲染，因为该功能仍待实现。

## 结果

| 场景                            | 观察结果                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Claude 自动登记                 | 安装统一 MCP/hook 配置后，以原生启动 UUID 自动登记；无需逐会话填写来源 ID                                                    |
| Claude → `@codex/beta` → Claude | 实际模型发起请求；Codex 原生动态工具回复；Claude 收到新消息并记录正确结果                                                    |
| Codex → `@claude/alpha` → Codex | 实际调用 metadata 自动确定 Codex 来源；Claude 原生回复；Codex 实际读取返回结果                                               |
| 同名 Codex                      | 增加另一个同名测试会话，解析返回歧义；未新增消息。改名后恢复唯一解析。这一负向检查由测试控制器调用解析器                     |
| 等待期间 `/clear`               | Codex 在测试 gate 等待，Claude 清空并产生新 UUID，再释放回复；答案留在原回执，原 UUID 已不在线，回程报告 binding_unavailable |
| `/clear` 后再次协作             | 同一 MCP PID、旧启动环境 UUID；连接器用新 hook 和原生目录建立新绑定、失效旧绑定；新请求及结果使用新 UUID                     |
| 原生改名                        | Claude `/rename gamma` 后旧名称无法解析；Codex 用 `@claude/gamma` 发起实际请求并收到回复，目标仍是 clear 后的新 UUID         |
| 请求/结果计数                   | 5 个请求、5 个关联回复、4 次回程与模型读取、1 次旧会话回程抑制；本轮未产生结果答谢循环                                       |

## 实验中遇到的问题

保留了失败尝试，不能将最终结果描述为一次无干预全绿运行。

1. 首次 TUI 启动的信任提示按键时序失败，在收发前结束；修正测试驱动的按键间隔后重试。
2. 普通 Codex `thread/list` 没有返回新建、尚无对话内容的线程。只读交叉检查得到 `listCount=0`，但 `thread/loaded/list` 加 `thread/read` 能取得 ID 和名称。名称解析改用后者。
3. Claude hook 可处于不同进程组。最初要求 helper 与 Claude 同组导致启动 hook 被拒绝；改为核验 helper 的 UID、实际 PPID 和所属 Claude 的启动身份。进程组只用于确认测试拥有 Claude 父进程。
4. Codex 对新的 MCP 工具请求审批，反向调用未开始。随后仅在新建测试 home 中，给 `ask_agent`、`record_result`、`hold` 三个受白名单限制的实验工具设置显式许可。原型未放开工作会话审批，也未将 peer 消息当作许可。
5. 最终运行中，Codex 曾把 `to` 写成 `alias`。MCP schema 在发送前拒绝了它；测试控制器追加精确参数提示后，真实模型重新调用并完成反向链路。这个纠正不是网络重发，也没有重复提交已发送请求。后续测试提示已写明字段名称。

## 证据、清理与局限

私有报告为 `.local/verification/connector-roundtrip.json`（0600）；包含版本、8 项检查、来源/目标/绑定、hook、逐调用身份、原生回复、回程和模型读取事件。参数纠正另存 `connector-model-argument-retry.json`；三个先前尝试保存在 `connector-roundtrip-*-attempt.json`。完整交互式终端和事件日志保留在报告引用的临时目录。

实验脚本是忽略目录 `.local/connector-spike/` 中的 `run.mjs`、`registry.mjs`、`connector.mjs`，并复用身份实验的 PTY/进程信息 helper。它们是本机原型夹具，不是已发布的通用 smoke 命令。

全部测试进程已退出，两个最终运行的 Codex 线程已归档，复制的认证目录和实验 HTTP token 文件已删除；前序尝试同样完成清理。未向工作会话发消息、改名、恢复或中断。

本轮未覆盖的 Claude 正常停止后 resume/fork、MCP reconnect、登记凭证和持久绑定，已有后续[生命周期实验](CONNECTOR_LIFECYCLE_EXPERIMENT.zh-CN.md)补充原型证据。仍未验收：Codex CLI/桌面端、多个会话共享一个 MCP 进程、Linux/Windows、真实 PID 复用，以及任意时刻发生的生命周期竞态。原型 registry 使用内存状态和自有资源白名单，尚未接入生产登记授权、配置、持久绑定和崩溃恢复；不能据此宣称这些已完成。测试覆盖的是按明确顺序触发的 clear，不证明目录检查与原生写入之间不存在竞态。

这次证据支持将“原生身份自动绑定 + 名称寻址”作为已测宿主的实现主路径，并要求生命周期刷新、名称消歧和工具启用权限成为接入流程的一部分。
