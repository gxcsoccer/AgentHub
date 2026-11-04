# Delivery status and remaining verification

[简体中文](ROADMAP.zh-CN.md)

`@gxcsoccer/agenthub@0.1.0` is published on npm with matching [GitHub release assets](https://github.com/gxcsoccer/AgentHub/releases/tag/v0.1.0). Post-release changes are reviewed through a PR; they are not yet another published package version.

| Work group                    | Implementation and evidence                                                                                                                                         | Boundary                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Caller authorization          | Per-caller tokens, instance/session/operation grants, receipt/SSE/approval isolation and forwarding checks                                                          | Same-OS-user malicious code is outside the isolation model                                   |
| Real ACP backends             | Actual Claude and Codex model replies, deduplication, history isolation, conversation continuity and owned-process cleanup                                          | Explicit managed sessions; no live attach or native-history recovery                         |
| Independent backend E2E       | Real Claude MCP calls to two separate Codex App Servers with distinct PIDs, homes and sockets; isolation and single-backend failure checks                          | Same host; remote networking/authentication are not validated                                |
| Compatibility and load        | Explicit Claude 2.1.317/2.1.318 allowlist, Codex 0.165.0/0.166.0 acceptance, Linux/macOS Node 22/24/26 CI, bounded synthetic soak and manual extended-soak workflow | Exact successes and failed attempts are in verification; model reply remains model-dependent |
| Publication and documentation | npm distribution, installed CLI examples, bilingual acceptance commands and release status                                                                          | New PR changes require a later release before npm users receive them                         |
| Existing extensions           | SQLite bounded event replay, per-session history text search and managed ACP v1                                                                                     | Consumer checkpoints remain client-owned; no shared full-history index                       |

[Acceptance](ACCEPTANCE.md) gives reproducible commands. [Verification](VERIFICATION.md) separates real models, protocol fixtures, synthetic load and historical evidence. [Extensions](EXTENSIONS.md) defines API limits.

Windows completion is excluded from this follow-up: native model acceptance, callbacks/replies and private durable storage remain pending. Doubao runtime, Agent OpenAPI and MCP Events adapters also remain pending; [research](DOUBAO.md) and examples are not runtime acceptance.

Durable consumer groups, full-history indexing and hot policy updates are optional future work. Longer production observation and additional native versions require fresh evidence. Arbitrary existing Codex sessions still cannot acquire a reply tool through a documented non-disruptive operation; AgentHub does not simulate that with implicit resume.
