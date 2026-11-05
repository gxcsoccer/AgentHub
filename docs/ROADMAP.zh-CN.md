# 交付状态与剩余验证

[English](ROADMAP.md)

`@gxcsoccer/agenthub@0.4.0` 包含 PR #1–#3 和 #9 的改动，对应 [GitHub Release](https://github.com/gxcsoccer/AgentHub/releases/tag/v0.4.0)。升级要求和能力边界见[变更记录](../CHANGELOG.md)。

| 工作组         | 实现和证据                                                                                                                        | 边界                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 调用方授权     | 独立 token、实例／会话／操作授权、回执／SSE／审批隔离、转发检查                                                                   | 不隔离同一 OS 用户下的恶意代码                               |
| 真实 ACP 后端  | 实际 Claude、Codex 模型回复、去重、历史隔离、连续对话与测试进程退出                                                               | 显式托管会话，不代表 live attach 或原生历史恢复              |
| 独立后端 E2E   | 真实 Claude 经 MCP 调用两个 PID、home、socket 均独立的 Codex App Server，验证隔离和单后端故障                                     | 后端在同一台机器，未验收远端网络和认证                       |
| 兼容与持续负载 | Claude 2.1.317／2.1.318 明确白名单、Codex 0.165.0／0.166.0 验收、Linux/macOS Node 22／24／26 CI、有界合成负载和手动长时负载工作流 | 具体通过项和失败尝试见验证文档；模型是否回复仍取决于模型行为 |
| 发布与文档     | npm 安装方式、已安装 CLI 示例、中英文验收命令和发布状态                                                                           | 豆包 setup 已纳入 0.3.0；可选插件商店发布仍待完成            |
| 已有扩展       | SQLite 有界事件回放、单会话历史全文扫描和托管 ACP v1                                                                              | 消费者自行保存游标，没有共享全量历史索引                     |

[验收说明](ACCEPTANCE.zh-CN.md)提供复现命令；[验证文档](VERIFICATION.zh-CN.md)区分实际模型、协议测试进程、合成负载和历史证据；[扩展说明](EXTENSIONS.zh-CN.md)定义接口边界。

本次排除 Windows 补齐：原生模型验收、回调回复和私有持久状态仍待完成。0.3.0 的豆包接入实现无需插件的 MCP 配置生成、可选本地 CLI 插件，并完成 stdio MCP 到真实 Claude/Codex 的隔离验收；豆包 2.35.15 已完成真实宿主收发验收及 5 项自动登记/移除检查。统一 setup 命令管理生成配置和 Hub；原生 MCP 配置移除仍需手工完成。忙碌交错/宿主断线、原生身份、主动唤醒、Agent OpenAPI 和 MCP Events 仍待完成。[接入说明与边界](DOUBAO.zh-CN.md)。

持久消费组、全量历史索引、权限热更新属于按需求增强。更长期生产观测和其他原生版本需要新增证据。已有 Codex 会话的原生动态回复工具仍受创建时注册限制；0.2.0 的连接器通过 App Server MCP reload 接入，并已完成真实双向验收。AgentHub 不通过隐式恢复来模拟工具安装。

## Agent 自动接入（实施中）

[设计提案第 11 版](AGENT_CONNECTOR.zh-CN.md)已进入实施，0.2.0 完成消息语义、Claude/Codex 原生登记与共享工具；Codex connect 已实现并通过真实双向验收，Claude CLI 接入已有生产实现，原生 MCP 外部 reload 仍待完成。[原生身份实验](SESSION_IDENTITY_EXPERIMENT.zh-CN.md)已验证 Claude 启动 ID、clear 后旧环境问题和 Codex 逐调用身份。v1 拟在通过验收的宿主上自动登记，手工绑定兜底；使用一个隐式团队和可消歧的名称地址。按顺序推进：

1. 已实现（0.2.0）：两端 adapter 的 request/result 渲染、回复入口及核心校验、schema 3 存储保护与旧消息兼容。
2. Claude 原生身份登记、生命周期刷新、名称消歧、三个工具和可选 deadline 已实现，9 项真实检查通过；手工兜底、完整诊断和剩余故障验收待补。
3. Codex / Claude 双向闭环及 Codex 安装激活已通过。停用/卸载、完整诊断、兼容矩阵和故障验收仍待补。

[收发原型](CONNECTOR_ROUNDTRIP_EXPERIMENT.zh-CN.md)已验证双向请求/回复及 clear 隔离；[生命周期原型](CONNECTOR_LIFECYCLE_EXPERIMENT.zh-CN.md)补充安装、凭证分层、正常服务重启、MCP 重连、停止后 resume/fork 及受控竞态。[CLI 插件热加载](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.zh-CN.md)另通过 7 项检查，同一 Claude 会话动态获得新 MCP。正式 Claude 核心已通过 9 项真实检查；并发乱序、强杀恢复和所有忙碌交错仍待扩大验收。其他宿主兼容性继续单独测试。多团队、租约、独立请求状态机、双期限、迟到结果推送和高级预算后置。

这一提案不扩大 Windows、豆包和远端接入范围，也不将既有测试结果作为新方案的验收证据。

[会话外自动激活补测](CLAUDE_AUTO_ACTIVATION_EXPERIMENT.zh-CN.md)记录了普通 MCP 外部安装未自动激活，以及 skill → CLI 的限定成功、clear 刷新与失败尝试。原生 MCP 外部 reload 仍缺少控制入口；当前已实现显式启用的原生消息 → CLI 接入，详见接入说明。

Claude 生产连接器已通过 9 项隔离真实检查，配置与边界见[接入说明](CONNECTOR_SETUP.zh-CN.md)。剩余重点：Claude 原生 MCP 外部 reload、统一安装器的卸载/停用、手工绑定兜底、完整就绪诊断、启动顺序和强杀/入队后 clear 等故障覆盖。历史绑定自动回收与可配置预算也仍待完善。

Codex connect 及两端共享工具新增 6 项真实检查通过：已有 Codex 根会话安装激活、无需模型轮次的只读身份握手、复用配置且保留权限、双向请求/回复/结果、结果终止。未使用动态回复工具或 thread/resume。

Claude CLI connect 新增 10 项真实检查，Claude CLI 与 Codex MCP 组合另通过 7 项。无 Bash 的会话收到消息并回报后仍保持未核验；只有目标进程链中的实际 CLI 调用能够完成激活。此路径会使用模型和目标原有权限，未安装新 MCP。豆包 setup 工作流已补配置生成、受管理 Hub 的卸载/停用、只读诊断和显式宿主登记/移除；通用原生 MCP 配置移除及更广的故障/容量验收仍待完成。

## 下一步：发起方反馈

目标这一轮结束但没有回复时，发起方的 Agent 收不到通知，连接器工具也查不了状态。计划如下，尚未实现：`ask_agent` 返回有竞争的 `targetBusy` 提示；一轮结束没有回复时，Hub 经转发通道发一条 `result` 通知。这条通知不要求回复，所以不会形成循环，但会消耗发起方一轮模型额度。之后的真实回复仍要能送达。

要把 Codex 回复兜底放宽到合并的一轮，需要先拿到两种真实样本：信封在用户工作中途并入，以及紧挨着的多条信封。turn 结构判断不了回答内容的来源。

目标等待批准时也有同样的缺口：发起方只能等，发给该会话的后续消息也会排在批准之后。一次真实运行中，Codex 改文件时等待批准，后面两条请求都没有被处理。把这种情况告知发起方，应和上面的反馈一起做。

## Codex 任务可靠性

在 Codex 0.166.0 的普通 TUI 真实运行中，没有 `developer_instructions` 时，对端请求的处理并不稳定。同样的 `pwd` 在一个线程执行，在另一个线程被拒绝。改文件、审查和明确要求调用 `reply_agent` 都因“外部内容不能授权”被拒绝。用 `developerInstructions` 创建的线程 4 条请求全部执行。样本很少，说不出比例，因此不能承诺普通会话一定会做事。

是用带自己 `developerInstructions` 的专用协作者线程，还是配置全局 `developer_instructions`，尚未决定。`collaborationMode` 不能替代它们：`default` 模式下自定义文字会被模型目录覆盖，`plan` 则会改变会话模式。回复文本里的拒绝无法在协议层判断。
