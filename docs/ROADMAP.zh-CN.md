# 交付状态与剩余验证

[English](ROADMAP.md)

按要求一起推进五组工作，能力与验收边界分别记录。豆包继续 pending。

| 工作组                   | 已有实现和证据                                                                                            | 验证边界／剩余事项                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 调用方授权               | 独立 token、实例／会话／操作授权、回执／SSE 隔离、审批范围、转发检查及自动测试                            | 不承诺隔离相同 OS 用户下的恶意代码                                                                  |
| 模型主动发起与多实例 E2E | 真实 Claude 调用 MCP，向两个 Codex 实例收发，检查关联回复和历史／检索隔离，五项通过                       | 两个逻辑实例共用一个 App Server，未验收独立远端后端                                                 |
| 兼容与持续负载           | Linux／macOS Node 22／24 完整检查矩阵；Windows Node 22／24 ACP／pipe 子集；资源／负载／重启脚本           | 首轮 CI 与十分钟测试已通过，结果见验证文档；原生 harness 仍限定 macOS Codex 0.166.0、Claude 2.1.318 |
| 发布                     | Changelog、包白名单、明确公开 registry；发布 npm 包 @gxcsoccer/agenthub，并提供对应 GitHub release assets | 发布前要求最终 CI 通过和 npm 官方认证；包名为 @gxcsoccer/agenthub，CLI 为 agenthub                  |
| 扩展                     | SQLite 有界持久事件、统一全文检索、官方 ACP v1 托管 adapter、Windows 单向实验性 inbox                     | Windows 原生模型收件／回复未实测；Windows 私有持久状态与原生 callback 不支持                        |

接口语义见[扩展说明](EXTENSIONS.zh-CN.md)，证据见[验证文档](VERIFICATION.zh-CN.md)，发布范围见 [Changelog](../CHANGELOG.md)。

后续按需求：持久消费组、原生历史全量索引、新 harness 版本验收、Windows 原生回调／私有持久状态、独立后端 E2E、更长期生产观测。任意已有 Codex 会话动态安装回复工具仍受上游限制，不通过隐式恢复模拟实现。

豆包运行时、Agent OpenAPI 和 MCP Events adapter 继续 pending；[调研](DOUBAO.zh-CN.md)和配置示例不代表已经通过运行时验收。
