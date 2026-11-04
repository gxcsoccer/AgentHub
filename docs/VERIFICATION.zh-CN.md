# 验证说明

[English](VERIFICATION.md)

## 自动化检查

```sh
npm ci
npm run check
```

当前在 Linux/macOS 包含 97 项 AgentHub、原 Codex Session Bridge 的 41 项及 18 项真实验收脚本防护测试，共 156 项，并执行格式、严格 TypeScript 和覆盖率门槛检查。原 Bridge 从自己的目录运行测试，保留其原始路径与契约。

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

本地检查通过 97 项 AgentHub、41 项原 Bridge、18 项脚本防护测试，共 156 项；源码覆盖率为行 96.43%、分支 87.27%、函数 93.98%。最后调整 UTF-8 输出捕获后，脚本测试再次通过。新增用例覆盖直接启动时变量真正不存在、主命令先于抗 TERM 后代退出、控制器 IPC 丢失、监督进程意外丢失后不向旧组发信号、受限输出捕获／失败／超时，以及后代发现、关闭或退出检查失败后的凭证删除。首次控制器断开测试等待 `close` 事件超时，实际进程和管道已退出；现直接检查这两个真实后置条件。失败记录保留在私有 `review-followup-check-first.log`。

真实 ACP 使用 Claude 2.1.318 / Codex 0.166.0，七项通过，确认后代退出并报告 `credentialsRemoved: true`。独立原生后端使用 Claude 2.1.318、Codex 0.166.0 / 0.165.0 和新监督进程，七项通过。私有报告为 `.local/verification/review-followup-acp-live.json`、`review-followup-independent-backends.json`。安装包再次通过五个导出入口、两个 CLI、HTTP、SQLite 和空事件游标恢复验证。原生协议和负载代码未变，本次未重跑完整版本矩阵和 30 分钟合成负载；兼容性运行器的新命令包装由确定性命令测试覆盖，没有将其描述成重新完成全部原生矩阵。
