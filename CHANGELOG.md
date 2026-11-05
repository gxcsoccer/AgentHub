# Changelog

## Unreleased

- Add plugin-free local MCP setup with absolute launch paths, scoped caller credentials and inherited-owner-token removal. A local Doubao CLI plugin and allowlisted ZIP packaging remain optional; bilingual guides cover both paths.
- Add unified setup target discovery, private generation, managed serve/connect/doctor/disable/enable/uninstall, plus explicit experimental Doubao 2.35.15 CDP registration, enable/disable and removal with ownership checks and uncertain-create recovery.
- Recover failed host registration with offline cleanup before creation or an exact-name `host-forget` acknowledgment that retains uncertain host records. Allow cleanup with unrelated port services, distinguish unknown ownership, and share UUID validation between initialization and manifest loading.
- Report verified Doubao removal separately from unchecked native connector configuration during uninstall. Add isolated CLI discovery tests for Claude/Codex pagination, empty results, malformed responses, unavailable backends and read-only behavior.
- Verify real Doubao STDIO requests and visible replies from isolated Claude/Codex sessions, and a separate five-check host API lifecycle. Busy host interleaving/disconnect remain unverified; native identity and proactive wake-up remain unimplemented. No store publication is performed.

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
