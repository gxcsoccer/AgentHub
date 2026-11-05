# 交付状态与剩余验证

[English](ROADMAP.md)

`@gxcsoccer/agenthub@0.1.0` 已发布到 npm，并提供对应的 [GitHub Release](https://github.com/gxcsoccer/AgentHub/releases/tag/v0.1.0)。发布后改动通过 PR 审阅，不代表又发布了一个 npm 版本。

| 工作组         | 实现和证据                                                                                                                        | 边界                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 调用方授权     | 独立 token、实例／会话／操作授权、回执／SSE／审批隔离、转发检查                                                                   | 不隔离同一 OS 用户下的恶意代码                               |
| 真实 ACP 后端  | 实际 Claude、Codex 模型回复、去重、历史隔离、连续对话与测试进程退出                                                               | 显式托管会话，不代表 live attach 或原生历史恢复              |
| 独立后端 E2E   | 真实 Claude 经 MCP 调用两个 PID、home、socket 均独立的 Codex App Server，验证隔离和单后端故障                                     | 后端在同一台机器，未验收远端网络和认证                       |
| 兼容与持续负载 | Claude 2.1.317／2.1.318 明确白名单、Codex 0.165.0／0.166.0 验收、Linux/macOS Node 22／24／26 CI、有界合成负载和手动长时负载工作流 | 具体通过项和失败尝试见验证文档；模型是否回复仍取决于模型行为 |
| 发布与文档     | npm 安装方式、已安装 CLI 示例、中英文验收命令和发布状态                                                                           | 本 PR 的改动须后续发布才会进入 npm 包                        |
| 已有扩展       | SQLite 有界事件回放、单会话历史全文扫描和托管 ACP v1                                                                              | 消费者自行保存游标，没有共享全量历史索引                     |

[验收说明](ACCEPTANCE.zh-CN.md)提供复现命令；[验证文档](VERIFICATION.zh-CN.md)区分实际模型、协议测试进程、合成负载和历史证据；[扩展说明](EXTENSIONS.zh-CN.md)定义接口边界。

本次排除 Windows 补齐：原生模型验收、回调回复和私有持久状态仍待完成。豆包运行时、Agent OpenAPI 和 MCP Events adapter 继续 pending，[调研](DOUBAO.zh-CN.md)和示例不代表已完成运行时验收。

持久消费组、全量历史索引、权限热更新属于按需求增强。更长期生产观测和其他原生版本需要新增证据。已有 Codex 会话的原生动态回复工具仍受创建时注册限制；当前分支的连接器通过 App Server MCP reload 接入，并已完成真实双向验收。AgentHub 不通过隐式恢复来模拟工具安装。

## Agent 自动接入（实施中）

[设计提案第 11 版](AGENT_CONNECTOR.zh-CN.md)已进入实施，当前分支完成消息语义、Claude/Codex 原生登记与共享工具；Codex connect 已实现并通过真实双向验收，Claude CLI 接入已有生产实现，原生 MCP 外部 reload 仍待完成。[原生身份实验](SESSION_IDENTITY_EXPERIMENT.zh-CN.md)已验证 Claude 启动 ID、clear 后旧环境问题和 Codex 逐调用身份。v1 拟在通过验收的宿主上自动登记，手工绑定兜底；使用一个隐式团队和可消歧的名称地址。按顺序推进：

1. 已实现（当前分支未发布）：两端 adapter 的 request/result 渲染、回复入口及核心校验、schema 3 存储保护与旧消息兼容。
2. Claude 原生身份登记、生命周期刷新、名称消歧、三个工具和可选 deadline 已实现，9 项真实检查通过；手工兜底、完整诊断和剩余故障验收待补。
3. Codex / Claude 双向闭环及 Codex 安装激活已通过。停用/卸载、完整诊断、兼容矩阵和故障验收仍待补。

[收发原型](CONNECTOR_ROUNDTRIP_EXPERIMENT.zh-CN.md)已验证双向请求/回复及 clear 隔离；[生命周期原型](CONNECTOR_LIFECYCLE_EXPERIMENT.zh-CN.md)补充安装、凭证分层、正常服务重启、MCP 重连、停止后 resume/fork 及受控竞态。[CLI 插件热加载](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.zh-CN.md)另通过 7 项检查，同一 Claude 会话动态获得新 MCP。正式 Claude 核心已通过 9 项真实检查；并发乱序、强杀恢复和所有忙碌交错仍待扩大验收。其他宿主兼容性继续单独测试。多团队、租约、独立请求状态机、双期限、迟到结果推送和高级预算后置。

这一提案不扩大 Windows、豆包和远端接入范围，也不将既有测试结果作为新方案的验收证据。

[会话外自动激活补测](CLAUDE_AUTO_ACTIVATION_EXPERIMENT.zh-CN.md)记录了普通 MCP 外部安装未自动激活，以及 skill → CLI 的限定成功、clear 刷新与失败尝试。原生 MCP 外部 reload 仍缺少控制入口；当前已实现显式启用的原生消息 → CLI 接入，详见接入说明。

Claude 生产连接器已通过 9 项隔离真实检查，配置与边界见[接入说明](CONNECTOR_SETUP.zh-CN.md)。剩余重点：Claude 原生 MCP 外部 reload、统一安装器的卸载/停用、手工绑定兜底、完整就绪诊断、启动顺序和强杀/入队后 clear 等故障覆盖。历史绑定自动回收与可配置预算也仍待完善。

Codex connect 及两端共享工具新增 6 项真实检查通过：已有 Codex 根会话安装激活、无需模型轮次的只读身份握手、复用配置且保留权限、双向请求/回复/结果、结果终止。未使用动态回复工具或 thread/resume。

Claude CLI connect 新增 10 项真实检查，Claude CLI 与 Codex MCP 组合另通过 7 项。无 Bash 的会话收到消息并回报后仍保持未核验；只有目标进程链中的实际 CLI 调用能够完成激活。此路径会使用模型和目标原有权限，未安装新 MCP。剩余重点是 profile 自动生成、统一卸载/停用、只读诊断与故障/容量完善。
