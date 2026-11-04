# 真实后端验收

[English](VERIFICATION.md) · [API 参考](API.zh-CN.md)

验证日期 **2026-11-04**，环境为 macOS、已有 Codex App Server **0.166.0**，调用配置的真实模型。隔离测试完成了**覆盖全部 22 个 API 操作的 25 项检查**，并检查了 OpenAPI 文档接口。这是后端/API 验收，不是桌面视觉验收，也不保证其他版本具有相同行为。

## 接口矩阵

| 操作                | 实际检查的成功条件                                            |
| ------------------- | ------------------------------------------------------------- |
| `capabilities`      | 后端已连接，声明 22 个操作                                    |
| `listSessions`      | 有真实输入的测试 thread 出现在其工作目录列表中                |
| `loadedSessions`    | 新建/恢复的 ID 出现，归档后的 ID 消失                         |
| `searchSessions`    | 唯一输入标记能从真实索引找到测试 thread                       |
| `createSession`     | 在临时目录创建新的根 thread                                   |
| `sessionDetail`     | 返回正确会话身份和状态                                        |
| `listTurns`         | 游标翻页得到不同真实轮次                                      |
| `listItems`         | 游标翻页得到不同真实消息项                                    |
| `searchOccurrences` | 真实输入和模型回复均能搜到                                    |
| `attachSession`     | 连接已加载的测试会话，并收到后续事件                          |
| `resumeSession`     | 恢复已卸载会话，再发消息得到真实模型回复                      |
| `detachSession`     | 上游确认取消测试连接的订阅                                    |
| `forkSession`       | 新 ID，继承历史截至指定轮次，且可接受自己的新输入             |
| `renameSession`     | 详情返回指定测试名称                                          |
| `archiveSession`    | 会话卸载，并出现在归档列表                                    |
| `unarchiveSession`  | 已有自身输入的会话重新出现在普通列表                          |
| `sendMessage`       | 真实回复进入历史和事件流；steer 修改同一轮；过期 steer 被拒绝 |
| `injectContext`     | 不隐式启动轮次，下一轮模型能回忆注入的秘密标记                |
| `interruptTurn`     | 真实等待提问回复的轮次变为 `interrupted`，会话恢复空闲        |
| `events`            | 经 HTTP SSE 收到开始、文本增量和终态                          |
| `pendingRequests`   | 真实提问/命令审批携带 request ID 出现在待处理列表             |
| `respondToRequest`  | 模型消费提问答案；重复回复被拒绝；审批拒绝和允许均验证        |

审批允许用例仅放行精确匹配的隔离 Python 打印命令（或已知 shell 的精确包装），核对工作目录，并验证真实执行的退出码为 0、输出包含测试标记。不批准会话级规则，其他命令无法匹配白名单时一律拒绝。API 服务本身仍不自动审批，是测试客户端显式发送了决定。

此前对已有会话的冒烟还验证了消息幂等：同 key 重复提交返回相同回执，且只新增一个轮次。

## 隔离与清理

- 测试自行创建根会话、fork 和临时工作目录。
- 每个写 RPC 的目标都必须是本轮测试创建的 ID，不对已有工作会话恢复、中断、重命名、归档或发消息。
- 只读沙箱、执行网络关闭、非可信命令需审批等设置仅作用于测试 thread；Plan/Default 切换也只影响测试 thread。
- 测试会话归档且确认卸载后，才删除临时目录；归档测试记录保留用于审计。
- 报告包含私有 thread ID 和写操作记录，以 `0600` 保存于被忽略的 `.local/verification/`，不进入发布包。

## 发现与范围

1. **空预览会话被隐藏。** 新 fork 可能有继承历史，但预览为空。普通列表会过滤它，取消归档后也一样，而归档列表可能包含它。因此在其首轮自身输入后检查普通列表可见性。
2. **接受输入不代表立即可中断。** 立即中断可能与上游注册任务竞态，返回 `409`。稳定验收等待真实阻塞提问后再中断，不会静默换另一个轮次重试。
3. **通知可能早于回执。** fork 的 started 通知可能先于 fork ID 的返回；测试忽略非已知测试会话的通知，并独立限制写操作归属。
4. **结论限定范围。** 桌面渲染、原生子 agent mailbox、多后端路由、跨重启持久回执，以及每一种审批子类型不在本次覆盖范围。已验证真实命令审批和用户提问，不代表文件修改、网络规则或所有插件特有请求都已实测。

## 复现

```sh
npm ci
npm run check
npm run smoke:isolated -- --run --report .local/verification/full-suite.json
```

这是手动启用的真实模型测试，不属于普通 CI。它会创建持久测试对话，结束后归档。可用 `CODEX_BRIDGE_SOCKET` 指定其他已运行后端。查看 JSON 报告的 `passed`、`unverifiedOperations`、`onlyOwnedSessionsMutated`、`cleanupAllUnloaded`；失败尝试应保留为失败记录，不能因后续修正通过而抹掉。
