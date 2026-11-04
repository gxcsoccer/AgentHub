# Changelog

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

See [verification](docs/VERIFICATION.md) and [extension boundaries](docs/EXTENSIONS.md). The public package name and CLI command are `agenthub`. npm is the primary distribution channel; GitHub release assets provide a matching tarball and checksum.
