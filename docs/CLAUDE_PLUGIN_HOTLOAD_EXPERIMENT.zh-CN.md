# Claude 插件 MCP 动态加载实验

[English](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.md) · [接入设计](AGENT_CONNECTOR.zh-CN.md) · [前序生命周期实验](CONNECTOR_LIFECYCLE_EXPERIMENT.zh-CN.md)

2026-11-05，在 macOS / Claude Code 2.1.318 的隔离交互式 CLI 中，**已运行的会话成功加载新插件的 MCP，真实模型调用通过，PID 和 session UUID 均未改变**。这补充了此前只测试 `--mcp-config` 文件修改的结论。正式 AgentHub 插件尚未实现或发布。

## 实际步骤与结果

1. 新建测试 Claude，只配置原有 `keep` MCP。真实模型先调用 keep；日志确认此时没有插件 MCP。
2. 在另一个进程中，添加临时本地 marketplace，以 `--scope local` 安装仅作用于测试工作目录的唯一命名插件。插件 `.mcp.json` 声明一个 stdio probe server。
3. 在原会话输入 `/reload-plugins`。无需重启或 resume，新 MCP 进程启动。
4. 原会话真实模型调用新增的 `mcp__plugin_<name>_bridge__probe`。MCP 启动 UUID 等于原会话 UUID，PPID 等于原 Claude PID。
5. 原 keep 工具继续被模型成功调用。
6. 卸载测试插件，再输入 `/reload-plugins --force`。摘要显示插件 MCP 数量归零；进程检查确认插件 MCP PID 已退出。后续请求没有产生该工具调用，模型报告 MISSING_TOOL。

最终通过 **7 项检查**：安装前真实调用、安装前插件缺席、新工具真实调用、新进程启动、会话与身份不变、原工具可用、运行中移除。

安装发生在测试会话空闲时。模型权限只放行两个实验 probe，未采用 bypass 模式；本轮没有验证忙碌工具期间的插件替换、任意插件内容或用户审批交互。

## strict 模式与宿主边界

首轮带 `--strict-mcp-config`：reload 摘要列出一个插件 MCP，但普通 reload 和 `--force` 后均未观察到该 MCP 进程启动，驱动在模型调用前停止。这项负向证据只证明该测试条件下的启动未发生。第二轮去掉 strict，保留其他主要条件后，真实调用成功。CLI 对 strict 的定义是只使用显式 `--mcp-config` 的 server，因此不能把插件数量当作连接就绪证据。[MCP 文档](https://code.claude.com/docs/en/mcp#project-scope)

官方将 `/reload-plugins` 定义为应用安装、更新和启停等待生效变化。若增加/删除工具会使提示缓存失效，普通 reload 会提示，再用 `--force` 接受下一次请求重新读取上下文的成本。本次安装普通 reload 即成功；卸载时测试控制器显式使用 force。[插件命令参考](https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins)

同一官方参考说明：桌面、SDK、`-p` 等无交互终端的会话里，这个 slash command 不连接或断开插件 MCP。此处是**文档边界，未做桌面/SDK 实测**。Agent SDK 另提供 `Query.setMcpServers()` 动态配置接口；这是持有 Query 的宿主能力，不是对任意已有 CLI session 的接管接口，本轮未测试。[SDK 参考](https://code.claude.com/docs/en/agent-sdk/typescript#mcpsetserversresult)

## 对 AgentHub 的设计影响

交互式 CLI 的首选安装形态可改为 Claude 插件：安装到所有者选择的 scope，在当前会话执行 reload，再由 MCP 的原生 UUID/进程证据登记。工具加载仍是所有者的宿主操作；本实验未通过 peer 消息驱动 slash command。新会话可从已安装配置直接加载。

strict 会话和其他宿主分别报告实际能力，保留下一次正常启动的路径。无需把“所有已有 Claude 会话必须退出”作为统一前提，也不能把 CLI 成功推广为所有宿主都支持相同热加载方式。

## 证据与清理

私有 0600 报告：`.local/verification/claude-plugin-hotload.json`；首轮记录：`claude-plugin-hotload-strict-attempt.json`。本机脚本是忽略目录中的 `.local/lifecycle-spike/plugin-hotload.mjs`，复用 probe 和 PTY helper；完整终端和独立进程观察保留在报告引用的临时目录。

插件运行 manifest 验证通过；目录提交检查提示缺少 README/LICENSE/icon。该夹具只用于本地实验，没有提交插件目录，也不代表可发布包验收。

两轮测试进程均退出。测试插件和 marketplace 已卸载/移除，注册表复查无残留记录。安装使用测试项目 local scope；用户其他插件、工作会话及其权限未作修改。生产 `src/` 未改变。
