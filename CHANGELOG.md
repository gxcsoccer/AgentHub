# Changelog

## 0.4.3 — 2026-11-06

- Accept Claude CLI 2.x from 2.1.317 by default, instead of an exact version list that broke at every auto-update. A new major version is still refused, and `supportsNativeVersion` still sets a stricter policy.
- Add session metadata `nativeVersionValidated`. `doctor` reports a warning, `unvalidated_version`, for a version that is allowed but untested. If such a version changed the private native protocol, a message can stay at `transport_written` with no error.
- Add Claude CLI 2.1.319 to the tested versions.
- `connector-hook` exits 0 when it can't reach the Hub, with a note on stderr, so a stopped Hub no longer shows a hook error at every Claude session start. A Hub refusal or bad input still exits nonzero. The event is still lost. After `/clear` during an outage, tool calls return `identity_pending` until a new `SessionStart` reaches the Hub, for example from another `/clear` or a restarted session.

Connector state is unchanged from 0.4.2.

本版默认接受 2.x 且不低于 2.1.317 的 Claude CLI，Claude 自动升级不再中断 peer 收发。未实测版本标记为未验证，`doctor` 报警告；如果后续版本改了私有协议，消息可能停在 `transport_written` 且没有报错。2.1.319 已实测。本版还让 `connector-hook` 在连不上 Hub 时退出 0 并写 stderr，Hub 停止时 Claude 启动界面不再报错。Hub 明确拒绝或配置错误时仍退出非 0。事件仍会丢失：停机期间 `/clear` 后，需要新的 `SessionStart` 送达 Hub 才能恢复。连接器状态与 0.4.2 相同。

## 0.4.2 — 2026-11-06

- Bind Claude MCP sessions when the connector helper starts, instead of on the first tool call, so `connectedPeersOnly` peers can reach a session that hasn't used a tool yet. The helper waits for a Hub that isn't up, and retries for up to two minutes until the native directory lists the session. Every session in a connector's install scope now becomes a connected peer at startup. Use `disconnect` to remove one.
- Rebind on `SessionStart` when that host already has a running helper, so a session stays reachable after `/clear`.

Upgrade the Hub and connector processes together. Connector state is unchanged from 0.4.1.

本版让 Claude MCP 会话在连接器 helper 启动时完成绑定，不再等第一次工具调用，因此安装范围内的会话启动后就是已连接对端，可用 `disconnect` 移除。`/clear` 后，若该宿主的 helper 仍在运行，也会绑定新 UUID。Hub 与连接器进程需同步升级。连接器状态与 0.4.1 相同。

## 0.4.1 — 2026-11-06

- Add connector profile option `mcpCommand` for Codex, so a host whose install path can change can register a stable launcher. `connect` writes it and compares against it. Without it, behavior is unchanged.

Upgrade the Hub and connector processes together. Connector state is unchanged from 0.4.0.

本版为 Codex profile 新增 `mcpCommand`，让安装路径可能变化的宿主能登记固定启动器。Hub 与连接器进程需同步升级。连接器状态与 0.4.0 相同。

## 0.4.0 — 2026-11-06

- Skip the user config write when a matching Codex MCP entry is already effective through an override layer. Conflicting overrides are still refused.
- Add `ClaudeAdapter` `supportsNativeVersion` for embedders with their own version policy. Sessions report the installed version and `nativeVersionSupported`, and `doctor` follows that result. The default remains the validated version list.
- Add `ConnectorService` option `connectedPeersOnly`, off by default. Only sessions with a current binding can be listed or asked.
- Add owner `disconnect` (library, `POST /v1/disconnect`, CLI) for one session or one connector profile, without a Hub restart. It persists until owner `reconnect` or `connect`, and `reconnect` works for MCP Claude sessions without a handshake. Native MCP and hook configuration is unchanged.
- Reclaim stale bindings and lifecycle records at capacity instead of refusing with 429. Connector state moves to version 4, so roll back only from a state backup.
- Add owner-only `listMessages` (library, `GET /v1/messages`) with an incremental cursor, request and reply text, and a `gap` flag when retained changes were removed.
- Add owner-only `clearMessages` (library, `DELETE /v1/messages`). It removes finished messages and retained events atomically, keeps requests still waiting for a reply or forward, and reports both counts. Connector bindings and credentials are unaffected.
- Retry `reply_agent` for up to 25 seconds after a network failure or 5xx response, using the same text. The Hub treats a replay as a duplicate. `ask_agent` is still never retried. A longer outage returns an error with the request ID, so the reply can still be lost if it isn't retried.
- Add `CodexAdapter` option `replyFallback`, off by default. When a request's turn ends without `reply_agent`, its final answer becomes the reply only if that request was the turn's sole input. The reply is labeled with its source. Otherwise the receipt gets `noReply` with a reason, and no text is sent.

Stop the Hub and back up its state before upgrading, and upgrade connector processes with the Hub. Connector state moves to version 4, and older builds refuse it, so rolling back needs that backup. Stored messages from 0.3.0 gain a change sequence on first start. `replyFallback` and `connectedPeersOnly` are off by default. Sessions under fully disconnected profiles are no longer offered as peers.

本版新增所有者断开与恢复、消息列表与清空、连接器记录回收、`reply_agent` 短时重试，以及可选的 Codex 回复兜底。升级前请停止 Hub 并备份状态，连接器进程需与 Hub 同步升级。连接器状态升至版本 4，旧版本无法读取，回滚需要该备份。普通 Codex TUI 执行对端任务并不稳定，详见 `docs/ROADMAP`。

## 0.3.0 — 2026-11-05

- Add plugin-free local MCP setup with absolute launch paths, scoped caller credentials and inherited-owner-token removal. A local Doubao CLI plugin and allowlisted ZIP packaging remain optional; bilingual guides cover both paths.
- Add unified setup target discovery, private generation, managed serve/connect/doctor/disable/enable/uninstall, plus explicit experimental Doubao 2.35.15 CDP registration, enable/disable and removal with ownership checks and uncertain-create recovery.
- Recover failed host registration with offline cleanup before creation or an exact-name `host-forget` acknowledgment that retains uncertain host records. Allow cleanup with unrelated port services, distinguish unknown ownership, and share UUID validation between initialization and manifest loading.
- Report verified Doubao removal separately from unchecked native connector configuration during uninstall. Add isolated CLI discovery tests for Claude/Codex pagination, empty results, malformed responses, unavailable backends and read-only behavior.
- Verify real Doubao STDIO requests and visible replies from isolated Claude/Codex sessions, and a separate five-check host API lifecycle. Busy host interleaving/disconnect remain unverified; native identity and proactive wake-up remain unimplemented. No store publication is performed.

Upgrade the Hub and connector processes together; Codex MCP handshakes require matching package versions. This release introduces generated setup manifests without changing the core SQLite schema from 0.2.0. Stop the Hub and back up its state before upgrading. Native MCP configuration cleanup remains manual.

本版新增统一 `agenthub setup`、无需插件的豆包本地 MCP 接入及实验性宿主登记 API，并补齐异常恢复与清理状态报告。升级前请停止 Hub 并备份状态；Hub 与连接器进程需同步升级。相较 0.2.0，核心 SQLite schema 不变。豆包宿主 API 仅验证 2.35.15，需显式开启 CDP；CLI 不自动重启豆包，原生 MCP 配置仍需手工清理。

## 0.2.0 — 2026-11-05

- Add native Claude/Codex connector enrollment, three shared MCP tools (`list_peers`, `ask_agent`, `reply_agent`) and a restricted Agent CLI with verified session identity.
- Add owner-driven `agenthub connect`: Codex installs/reloads MCP and verifies a read-only handshake; opt-in Claude CLI activation uses native peer messages and existing Bash permissions. Private profiles and explicit grants remain required.
- Separate request/result rendering throughout the API, SDK, adapters, forwarding and persistence. Results omit reply instructions; expired connector replies are rejected.
- Discover loaded Codex peers independently of historical sessions. Preserve caller grants, disambiguated names and explicit discovery gaps.
- Persist activation attempts and retired IDs, bound retries and retention, and refresh short-lived connector credentials without retrying uncertain delivery.
- Read CLI, MCP, ACP and OpenAPI versions from the package manifest, including strict same-version Codex connector handshakes.

- Add opt-in real Claude/Codex ACP acceptance, independent App Server tests and a native-version matrix with isolated cleanup.
- Validate Claude Code 2.1.317 alongside 2.1.318; preserve explicit opt-in and reject other versions. Report the cached installed CLI version explicitly; do not claim it verifies the target process.
- Preserve existing ACP sessions and pending permissions when another creation fails. Block further creation after an uncertain result, without restarting the backend.
- Add regression tests for isolated launcher arguments, absent versus merged session environments and supervised process-group cleanup; keep test credentials outside model workspaces and remove credential copies even when shutdown fails.
- Clarify ACP daemon restart recovery and the instance-wide creation availability boundary of `manage` grants.
- Extend Linux/macOS CI to Node 26 and provide a manually dispatched sustained synthetic soak with a separate report path.
- Correct published-package documentation and document real-model reply limits and reproducible acceptance commands.

### Upgrade notes / 升级说明

Stop the Hub and back up its state directory before upgrading from 0.1.0. Core SQLite storage migrates to schema 3; CLI activation metadata migrates to version 2. Older binaries refuse these newer formats. To roll back, stop the new Hub and restore the pre-upgrade copy. Upgrade the Hub and its connector processes together; Codex MCP handshakes require the same package version. Keep enrollment tokens and business credentials private.

从 0.1.0 升级前，请停止 Hub 并备份状态目录。核心 SQLite 自动迁移至 schema 3，CLI 激活元数据迁移至 v2；旧版程序会拒绝新格式。回退时应停止新版 Hub，再恢复升级前的备份。Hub 与连接器进程需同步升级；Codex MCP 握手要求版本一致。登记凭据和业务凭据应继续保密保存。

本版新增 Claude/Codex 原生登记、共享协作工具与受限 Agent CLI，统一 `connect` 接入，以及请求/结果消息语义。Codex reload 作用于整个实例；Claude CLI 激活可能启动模型轮次，并遵守现有 Bash 权限。首次接入仍需所有者准备 profile 和授权；Claude 外部动态 MCP reload、Windows 原生完整接入及豆包不在本版新增能力中。

Validation details and actual isolated native acceptance boundaries are recorded in [English](docs/VERIFICATION.md) and [中文](docs/VERIFICATION.zh-CN.md).

## 0.1.0

Initial public release of AgentHub, a TypeScript middleware for existing Codex and Claude Code sessions, with explicit native message semantics.

- Retains Codex Session Bridge's original 22-operation API and SDK under separate exports.
- Unified library, local HTTP/SSE, fetch SDK, CLI, OpenAPI and seven MCP tools.
- Codex external tool output and version-pinned Claude native peer messages with correlated replies.
- Scoped caller tokens, session allowlists, approval/attachment separation and receipt/event isolation.
- SQLite receipts, idempotency, bounded durable event replay and conservative crash recovery.
- Bounded full-text history search and read-only doctor diagnostics.
- Explicit managed ACP v1 sessions using the official SDK; separate user prompt permission and explicit approvals.
- Experimental Windows one-way Claude named pipes; no native reply confirmation. Windows daemon storage is ephemeral.
- Isolated real-model acceptance, crash tests, compatibility CI and synthetic sustained-load checks. Verification scope is documented; Doubao remains pending.

See [verification](docs/VERIFICATION.md) and [extension boundaries](docs/EXTENSIONS.md). The public package is `@gxcsoccer/agenthub`; the CLI command is `agenthub`. npm is the primary distribution channel; GitHub release assets provide a matching tarball and checksum.
