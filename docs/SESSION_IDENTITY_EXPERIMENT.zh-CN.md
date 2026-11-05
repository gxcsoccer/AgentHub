# 原生会话身份与自注册实验

[English](SESSION_IDENTITY_EXPERIMENT.md) · [接入设计](AGENT_CONNECTOR.zh-CN.md)

日期：2026-11-05。环境：macOS，Claude Code 2.1.318，Codex CLI / App Server 0.166.0，Node 26.12.1；仅 SDK 改名对照使用 Claude Agent SDK 0.3.316。

这是实际进程和模型调用的实验记录。13 项证据断言通过，包含对不成立假设的确认；不是 13 项生产功能验收。AgentHub 的自动注册功能尚未实现。

后续已完成[自动登记与双向收发原型实验](CONNECTOR_ROUNDTRIP_EXPERIMENT.zh-CN.md)，包括实际 clear 后刷新和旧结果隔离；生产接入套件仍未实现。

## 实测结论

| 问题                                 | 操作与观察                                                                                                                        | 结论                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Claude MCP 能否知道所属会话          | 两个新建 `--print` 会话使用相同 cwd、相同 MCP 配置，实际调用 probe；各自 MCP 环境的 `CLAUDE_CODE_SESSION_ID` 与原生目录 UUID 一致 | 启动时可直接取得 ID，实验没有把该 ID 传给 MCP 配置                                                  |
| hook 与 MCP 能否配对                 | 比较两者 PPID、macOS proc_pidinfo 返回的父进程启动秒/微秒，再与原生目录 PID 核对                                                  | 两个并行会话都一一对应；同 cwd 不妨碍配对                                                           |
| Claude 交互式行为是否一致            | 新建 TUI 会话实际调用相同 probe                                                                                                   | 交互式 MCP 启动环境同样包含正确 ID                                                                  |
| `/rename` 改什么                     | 在该 TUI 执行 `/rename`，重新读取 `claude agents --json`                                                                          | 名称更新，UUID 和 PID 保持不变                                                                      |
| SDK 改名是否等同实时改名             | 对另一个新建会话调用 renameSession，然后分别读取 SDK 元数据与原生运行目录                                                         | 持久标题更新，但本次即时读取的运行目录仍为旧名称；不能假设二者同步                                  |
| 同名是否唯一                         | 同时启动两个同名 Claude；同一隔离 App Server 创建两个同名 Codex                                                                   | 两边均允许同名、不同 ID；harness 前缀不能消除同 harness 内重名                                      |
| Claude `/clear` 是否更换身份         | TUI 执行 `/clear` 后读取 SessionStart hook 与原生目录                                                                             | UUID 变化，PID 和名称不变                                                                           |
| MCP 环境能否永久代表当前 Claude 会话 | `/clear` 前后分别让真实模型调用 probe                                                                                             | 同一个 MCP PID 继续运行，环境里的 UUID 仍是旧值；启动环境会过期                                     |
| Claude 调用 metadata 是否补充了新 ID | 检查上述两次 MCP `tools/call` 原始请求                                                                                            | 本次只有 progressToken、claudecode/toolUseId，没有当前 sessionId/threadId                           |
| Codex 是否必须从环境推断             | 同一隔离 App Server 的两个新会话实际调用 MCP probe                                                                                | 两个 MCP 环境均无 CODEX_THREAD_ID，但每次调用的 `_meta.threadId`、`_meta.sessionId` 均为对应会话 ID |
| Codex 原生工具调用是否也有身份       | 两个模型分别调用创建时注册的 identity_native                                                                                      | App Server 请求携带正确 threadId、turnId、callId，可与 MCP 调用逐一核对                             |
| Codex 名称与 ID                      | 使用 thread/list、thread/loaded/list、thread/name/set、thread/read                                                                | 可列出 ID/名称/运行状态；改名后 ID 不变                                                             |

## 对设计的具体影响

### Codex：优先使用逐调用身份

实验观察到的 MCP 请求形状如下，值已匿名化：

```json
{
  "method": "tools/call",
  "params": {
    "name": "probe",
    "arguments": { "marker": "ID_CODEX_A", "gate": false },
    "_meta": {
      "threadId": "NATIVE_THREAD_ID",
      "sessionId": "NATIVE_THREAD_ID",
      "callId": "NATIVE_CALL_ID"
    }
  }
}
```

模型只填写 marker/gate。身份来自宿主附带的 metadata。连接器可以在授权实例中核对该 threadId，再登记地址；本次路径无需用户逐会话绑定，也无需借助 PPID 区分同一个 App Server 下的会话。

本轮两个会话各启动了一个 MCP 进程。虽然使用的是逐调用字段，但尚未刻意构造“多个会话共享同一 MCP 进程”的验收，也未验证 Codex CLI/TUI、桌面端及切换会话后的行为。MCP metadata 是本地宿主证据，不是远程身份认证。

### Claude：启动身份加生命周期刷新

启动时直接读取 `CLAUDE_CODE_SESSION_ID` 是可用的捷径；把它当成连接器整个生命周期的固定身份则已被 `/clear` 实验否定。

推荐实现路径：

1. MCP 启动时读取 UUID，并与原生目录和父进程启动身份核对。
2. SessionStart / SessionEnd hook 向 Hub 报告生命周期；以已核对的 Claude 进程身份关联仍存活的 MCP 连接。
3. 在 clear / 切换事件后更新当前 sessionId，并在新调用时再核对原生目录。旧请求继续保留旧 ID，避免把旧结果交给新会话。
4. 新身份与旧缓存不一致时暂停新调用归因，等核验完成或退回显式绑定。

本次只验证 `/clear` 的事件和目录更新。后续[收发实验](CONNECTOR_ROUNDTRIP_EXPERIMENT.zh-CN.md)验证原型刷新，[生命周期实验](CONNECTOR_LIFECYCLE_EXPERIMENT.zh-CN.md)补充正常停止后的 resume/fork 与 MCP reconnect。生产实现、异常退出及真实 PID 复用仍待验收。

### 名称前缀：可作为地址，不能作为唯一身份

`@claude/reviewer`、`@codex/developer` 可以由已授权原生目录自动生成。内部保留 `{harness, instance, nativeSessionId}`；提交时固定实际 ID。同名时要求实例/ID 消歧；名称变化只影响后续解析。`/clear` 实验还表明，同一个名称和 PID 可以先后代表不同 UUID。

此次验证了生成这些地址所需的真实目录和来源身份。本轮未测试新的名称解析、自注册 HTTP 接口、授权登记或完整跨 harness 工具；后续原型证据见上述实验，生产实现仍待交付。

## 实验隔离、证据与复现范围

- 两个 headless Claude 会话使用新生成的 UUID，同名、同目录、同 MCP 配置；模型只有测试 probe 工具。另一个全新交互式 Claude 仅用于改名、clear 和前后工具调用。
- Codex 使用独立 App Server、home 和 socket，只复制认证，创建两个新会话；使用 read-only 沙箱、关闭执行网络，模型仅被要求调用测试动态工具和 probe。控制器对写操作检查 owned allowlist。
- hook/MCP probe 只记录允许的身份环境变量、进程启动信息和测试调用。消息认证 token 仅记录是否存在，不记录其值。
- 所有测试进程组已停止，两个 Codex 会话已归档，复制的认证目录已删除；未向工作会话发送消息、改名、恢复或中断。
- 原始报告权限为 0600，位于忽略的 `.local/verification/session-identity.json`、`session-identity-interactive.json`、`session-identity-summary.json`。完整终端转录和测试工作目录保留在报告引用的私有路径。

本机实验脚本位于忽略的 `.local/identity-spike/`：`run.mjs`、`interactive.mjs`、`probe.mjs`、`pty-launch.py`、`stream-launch.mjs`、`process-info.py`。它们是本轮 spike 夹具，尚未整理为可发布的通用 smoke 命令；不能将其运行范围描述为跨平台兼容测试。

复现步骤是：创建隔离会话并记录原生 UUID → 使用同一 MCP 配置调用 probe → 对照 hook/环境/原始 MCP metadata 与原生目录 → 在新建 TUI 执行 rename、clear 并再次调用 probe → 关闭所有自有进程并核对清理。需要真实模型认证与额度，始终使用新建会话。
