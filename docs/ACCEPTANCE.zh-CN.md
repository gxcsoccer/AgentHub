# 真实后端验收

[English](ACCEPTANCE.md)

以下脚本需要显式 `--run`，会消耗模型额度。只创建自己的会话和进程，不接管工作会话。在源码目录先执行 `npm ci` 和 `npm run build`。私有日志与报告保存在忽略的 `.local/verification/`，对外只发布验证文档中的汇总。

## ACP 托管会话

在忽略目录安装固定版本的上游适配器，不加入 AgentHub 生产依赖：

```sh
npm install --prefix .local/acceptance/runtime --save-exact --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org @agentclientprotocol/claude-agent-acp@0.100.0 @agentclientprotocol/codex-acp@2.5.0
npm run smoke:acp -- --run
```

真实 Claude、Codex 可执行文件须已认证。可通过 `AGENTHUB_TEST_CLAUDE`、`AGENTHUB_TEST_CODEX`、`AGENTHUB_TEST_ACP_RUNTIME`、`AGENTHUB_TEST_REPORT` 指定可执行文件路径、依赖安装根目录和私有报告路径。脚本会先校验适配器版本。上游：[Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)、[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)。

每个后端创建两个托管会话，通过 HTTP 获取真实模型返回的唯一标记；重复消息 ID 不增加历史；另一个会话没有对应历史；首个会话的新一轮对话能回忆标记。普通 send 不能将消息升格为用户输入。清理阶段检查测试进程的后代已退出。这不证明 live attach、原生历史恢复、所有审批类型或真实模型取消行为；超时与取消另有确定性协议测试。

测试专用启动包装器保留 Claude 的 SDK 流式协议和认证，关闭模型工具、已配置 MCP 和用户 hooks，不模拟模型输出。Codex 使用临时私有 home，只复制所有者 `CODEX_HOME/auth.json` 的文件认证，启用只读模式并关闭执行网络；不复制工作会话、用户配置。凭证放在模型工作目录之外的同级后端 home；确认清理后删除认证副本。若无法确认后代进程退出，验收失败并记录保留的私有目录。文件认证是前置条件，脚本不提取钥匙串凭证，也不发起登录。

包装器同时处理 `--flag value` 和 `--flag=value`，移除受控选项的重复、多值参数，并拒绝会绕过追加限制的 `--` 分隔符。会话路由环境变量（含 `CODEX_THREAD_ID`）统一设置空值，后续合并环境也不会恢复父会话身份。清理不会向历史 PID 记录发信号；仅在被跟踪的子进程组长仍存活时终止进程组，后代快照只用于观察退出。无凭证回归测试为 `npm run test:scripts`。

## 独立原生后端

```sh
npm run smoke:claude-initiated -- --run
```

脚本现在启动两个 PID、socket、home 各自独立的 App Server。真实 Claude 模型调用受限 MCP 工具，分别发送消息并取得关联回复。验证跨后端原生读取失败、历史／搜索和授权隔离，并关闭一个测试后端，确认另一个仍工作。可用 `AGENTHUB_TEST_CODEX_ALPHA` 和 `AGENTHUB_TEST_CODEX_BETA` 指定不同版本，`AGENTHUB_TEST_CLAUDE` 指定调用方，`AGENTHUB_TEST_REPORT` 指定私有报告。后端 home 与模型工作目录为同级目录；故障检查等待 RPC 实际断开，不依赖固定延时。这是本机独立进程验收，不是远端网络、远端认证或多机部署验收。

## 原生版本矩阵

准备私有 JSON 数组，填写已安装版本的路径：

```json
[
  { "name": "current", "codex": "/absolute/path/to/codex", "claude": "/absolute/path/to/claude" },
  {
    "name": "previous",
    "codex": "/absolute/path/to/older-codex",
    "claude": "/absolute/path/to/older-claude"
  }
]
```

```sh
npm run smoke:compatibility -- --run --config /absolute/path/to/matrix.json
```

每一行使用独立 App Server，执行空闲／忙碌、hold／refuse、重复／冲突、迟到回复、断线、历史身份与测试会话清理等矩阵。选择可执行文件不会绕过版本门禁；未验证版本必须拒绝发送。Claude 仍采用明确版本白名单，安装的 CLI 版本不能证明所有运行中进程的版本。metadata 和原生提交证据明确使用 `installedCliVersion`、`versionSource: installed_cli_cached`、`processVersionVerified: false`；`cliVersion` 作为安装版本的兼容别名保留。

## 持续合成负载

```sh
node --expose-gc scripts/soak.mjs --seconds 1800 --report .local/verification/soak-1800.json
```

运行实际 HTTP／SSE／SQLite，适配器为合成测试对象。每批八个并发提交、四个消费者连接，周期性重开服务和存储，验证去重、游标连续性和资源阈值。不是实际模型负载，也不证明生产长期稳定。时长必须是 5–3600 秒整数。独立的 **Extended synthetic soak** 工作流合并到默认分支后支持手动触发，只上传合成负载报告，不上传模型历史或凭证。

本次验收扩展不包含 Windows 补齐和豆包运行时对接。
