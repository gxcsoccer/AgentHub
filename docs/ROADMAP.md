# Delivery status and remaining verification

[简体中文](ROADMAP.zh-CN.md)

The five requested work groups are being delivered together. Capability and verification boundaries remain explicit; Doubao is pending.

| Work group                             | Delivered implementation and evidence                                                                                                    | Remaining verification                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Caller authorization                   | Per-caller tokens, instance/session/operation grants, receipt/SSE isolation, explicit approval scope, forwarding checks; automatic tests | No claim of isolation from malicious code under the same OS user                                                                          |
| Model-initiated and multi-instance E2E | Real Claude MCP sends to two Codex instances, correlated replies and isolated history/search; five checks passed                         | Both logical instances share one App Server; independent remote backends are not tested                                                   |
| Compatibility and sustained load       | Linux/macOS Node 22/24 full-check matrix; Windows Node 22/24 portable ACP/pipe matrix; repeatable resource/load/restart test             | First CI and the ten-minute run passed; details are in verification; native harness scope remains Codex 0.166.0 / Claude 2.1.318 on macOS |
| Release                                | Changelog, package allowlist, explicit public registry metadata; npm package `agenthub` with matching GitHub release assets              | Publication requires a green CI gate and npm authentication; package name and CLI are `agenthub`.                                         |
| Extensions                             | SQLite bounded event replay, unified history text search, official ACP v1 managed adapter, experimental one-way Windows inbox            | Native Windows model reception/replies are unverified; Windows private durable store and native callbacks are unsupported                 |

See [Extensions](EXTENSIONS.md) for precise API semantics, [Verification](VERIFICATION.md) for evidence and [Changelog](../CHANGELOG.md) for the release scope.

Future work requires separate demand: durable consumer groups, full native history indexing, new harness-version acceptance, native Windows replies/private durable state, independent backend E2E and longer production observation. Arbitrary existing Codex sessions cannot dynamically acquire a reply tool through a documented non-disruptive operation; do not simulate that by implicit resume.

Doubao runtime, Agent OpenAPI and MCP Events adapters remain pending. The [Doubao research](DOUBAO.zh-CN.md) and configuration examples do not imply runtime acceptance.
