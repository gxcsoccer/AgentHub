# v0.1 设计

核心目标是连接已有 harness 进程，用同一套调用方式表达真实能力差异。

后续[自动接入与最小感知协作设计](AGENT_CONNECTOR.zh-CN.md)定义会话绑定、角色寻址和简化协作工具；这些新增部分尚未实现。

## 分层

1. Core：复合会话地址、发现、详情、历史、消息身份、幂等、回执、有界事件和可选关联回复转发。
2. Codex Adapter：复用原 WebSocket over UDS transport，通过工具输出投递；完整旧 Bridge 独立保留。
3. Claude Adapter：只读 CLI 发现、原生 inbox 与反向回调、本地日志历史。原生协议按 CLI 2.1.317 / 2.1.318 显式开启。
4. 接入层：本地 HTTP/SSE、fetch SDK、JSON CLI、官方 SDK 的 MCP stdio 服务。CLI/MCP 共用守护进程的回执。
5. 豆包：先提供本地 CLI/MCP 入口和配置说明。OpenAPI 管理会话及 MCP Events 保留为后续适配方向。

## 地址与身份

地址为 `{ harness, instance, sessionId }`，核心不强加 UUID；原生适配器自行验证。Codex 的 `tool_output` 与 Claude 的 `peer_message` 分开声明，不静默降级成用户输入。来源字段用于归因，不授予额外权限。

每条消息有 UUID、来源、目标、投递方式、可选关联字段、期限、跳数。明确设置 replyTo 才转发回复，且只转发第一次关联回复。转发使用新 UUID，保留关联，不再设置 replyTo；失败写入原回执。

回执区分 pending、transport_written、accepted、held、received、replied、rejected、failed、unknown。原生回调可能早于提交响应，后到的弱证据不能覆盖已收到的回复。

幂等记录最多 10,000 条，提交完成后保存 24 小时。可选 SQLite 存储在守护进程中默认开启，在适配器 I/O 前提交保留记录。记录区分 reserved/dispatching/settled；提交中断后的非终态记录恢复为 unknown，不重放。回复和固定转发 ID 一起提交，再将父消息状态和子消息保留记录原子提交，之后才执行转发。只有尚未保留子消息的转发意图可以在启动时新提交。SQLite 与后端 I/O 不能组成一个事务，不保证 exactly-once。事件随 SQLite 持久化，待审批请求仍只在进程内保存，游标缺口明确报错。

存储使用 Node 原生 SQLite（Node >=22.13）、完整同步提交、schema 版本和私有权限。单独的 SQLite 事务锁确保单实例所有权，进程崩溃后由 OS 释放。损坏状态、不支持的版本和写盘失败均拒绝继续。Claude 在原生写入前保存回调路径/inode 和发件关联；启动仅重新绑定不存在或同 inode、同用户且已失活的端点，拒绝仍活跃或被替换的端点。停机期间发出的回调不由 Hub 重放。不传 store 的基础库保留内存行为。

## 本地信任边界

服务绑定回环地址并要求私有令牌，浏览器 Origin 默认拒绝。Claude 回调 socket 使用随机文件名和私有权限，只接受预期地址和关联 ID 的回调。Node 接收端没有验证内核 peer PID，因此信任边界是同一 OS 用户。Claude 历史中的 verifiedPeerPid 标识 Hub 进程，不是消息最初作者。

不修改已有 socket、Claude 接收策略或权限。Codex 的关联回复依赖会话所有者注册 agenthub_reply，并要求当前连接持有原生 thread 监听关系。turn/start 不会建立或恢复该监听关系，真实断连测试已确认仅重连传输不能保证关联回复。只读就绪检查根据本地持久工具元数据及本连接已观察的监听关系给出结果。所有者可显式通过无配置覆盖的 thread/resume 为已加载、工具核验通过的根会话 attach，并接受检查后卸载的竞态。断连使本连接就绪状态失效，不自动 attach，也不为任意已有会话安装工具。其他审批显式交给所有者，agent-facing MCP 不提供审批接口。

## 验收

保留原 Codex 测试，增加消息状态、传输、历史和接口合同测试。真实 smoke 仅操作新建 allowlist 会话，关闭执行网络并使用只读 Codex 沙箱；验证跨 harness 关联回复、历史身份及清理。官方 MCP 客户端测试不等于豆包客户端验收。

新增调用方权限、持久事件语义、全文检索和显式托管接口见[扩展说明](EXTENSIONS.zh-CN.md)。
