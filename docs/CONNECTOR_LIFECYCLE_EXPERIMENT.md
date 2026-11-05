# Connector installation, authorization and lifecycle experiment

[简体中文](CONNECTOR_LIFECYCLE_EXPERIMENT.zh-CN.md) · [Design proposal](AGENT_CONNECTOR.md) · [Earlier roundtrip](CONNECTOR_ROUNDTRIP_EXPERIMENT.md)

Date: 2026-11-05. Environment: macOS, Claude Code 2.1.318, Codex App Server 0.166.0, Node 26.12.1.

Isolated real sessions exercised installation activation, enrollment permissions, reconnects, restoration and session changes. The main experiment passed **14 checks**. Separate runs observed MCP installation in an already-running Codex thread and tested stale Claude IDs with positive controls before and after clear. Production `src/` was unchanged: this is prototype feasibility evidence, not delivery of the connector kit.

## Installation and disabling

| Experiment                                  | Observation                                                                                                                                                                                                    | Integration consequence                                                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add MCP to an existing Codex thread         | The server was absent at thread creation. After editing the isolated home configuration and calling `config/mcpServer/reload`, the same thread's real model called the new tool with correct per-call identity | The App Server path can support explicit reload; verify the actual connection and invocation before declaring readiness                                 |
| Edit Claude MCP configuration while running | Started with `--strict-mcp-config --mcp-config <file>`. Adding a server did not produce a model tool invocation; `/mcp reconnect lifecycle` reported that the server was not found                             | Treat this configuration entry point as taking effect on the next normal launch; ordinary project configuration and plugin installation were not tested |
| Explicitly resume stopped Claude            | The controller exited its own Claude and resumed the same UUID; the new MCP loaded and the model called it                                                                                                     | Stopped-session restoration is verified; this does not justify concurrent resume of working sessions                                                    |
| Install hooks while Claude runs             | Edited the owned `.claude/settings.json`, allowed its watcher to settle, then observed an actual UserPromptSubmit hook                                                                                         | This hook path updated live; hook activation does not establish new MCP server activation                                                               |
| Edit configuration during a tool call       | A previously started MCP gate tool completed after the edit                                                                                                                                                    | The tested installation did not interrupt the running tool                                                                                              |
| Disable and uninstall                       | Disabling the profile rejected existing MCP calls immediately; restoring the original MCP/settings objects preserved the unrelated keep entry and a real model invocation                                      | Hub disables operations first; host activation timing for configuration removal remains separate                                                        |

The uninstall check established configuration preservation and invocation. The keep tool reused the experimental helper and received profile_disabled when contacting enrollment, so this is not full functional acceptance of arbitrary third-party MCP tools.

Earlier Codex attempts had a connected catalog and a successful direct `mcpServer/tool/call`, while the model twice answered MISSING_TOOL. The independent run observed a real model call. Its prompt allowed host tool discovery, but native items show only the MCP invocation, with no search invocation; the difference cannot yet be attributed to a discovery mechanism. Reload is feasible, while model tool selection remains a separate observation. Official [App Server documentation](https://learn.chatgpt.com/docs/app-server) describes reload; Claude [MCP](https://code.claude.com/docs/en/mcp) and [settings](https://code.claude.com/docs/en/settings) documentation describe other reconnect/configuration mechanisms. The evidence here covers only the tested entry points.

## Enrollment, authorization and restoration

A separate local enrollment service checked helper UID, actual PPID, parent start identity, native discovery and owned-resource allowlists. SQLite retained bindings and connector credential hashes. Real models invoked these operations through MCP:

| Scenario                               | Observation                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrollment versus operation credential | Enrollment succeeded; using its credential directly at the operation endpoint returned 401                                                                                                                                    |
| Session grants                         | Reading the allowed owned Codex thread succeeded. Production `AgentHub.getSession` / AccessPolicy denied another owned thread before a native read of that target occurred                                                    |
| Service process restart                | Gracefully stopped enrollment and started a new PID; the existing MCP process retained a usable credential and recovered the same bindingId                                                                                   |
| MCP reconnect                          | Claude `/mcp reconnect lifecycle` created a new MCP PID; enrollment recovered the same native UUID and bindingId                                                                                                              |
| Credential revocation                  | The owner advanced the profile epoch and rotated enrollment credentials. The old connector credential failed; a subsequent explicit call enrolled with the new credential. The failed operation was not automatically retried |
| Profile disabled                       | Later calls returned profile_disabled without restarting Claude                                                                                                                                                               |
| Resume after stopping                  | The native UUID and binding remained stable, with renewed connector validation                                                                                                                                                |
| Fork after stopping                    | `--fork-session --resume` created a different UUID and binding                                                                                                                                                                |

The main 14 checks also establish that both sessions existed before installation, the running tool continued, restoration loaded MCP, and hooks activated. These establish credential separation, read authorization and graceful restart, not authorization for every operation, crash transactions or in-flight replay. Enrollment remains experimental code within the same OS-user trust boundary.

## Clear between directory lookup and transport write

The main run initially sent only stale-ID frames, without a fresh-ID positive control; that did not establish native filtering. A separate isolated Claude run then:

1. Sent to the current UUID and observed a real MCP call, establishing a working channel.
2. Captured UUID/PID, cleared, and observed a different UUID with the same PID.
3. Wrote a frame containing a unique body marker and the captured old UUID to that PID's inbox; observed for 20 seconds.
4. Sent another frame to the fresh UUID and observed a real MCP call, establishing that the channel still worked.
5. Read the new session's complete history for this test: no old body marker or old-frame tool invocation appeared.
6. Sent a handle for an old-session result to the fresh UUID. The new session actually called the claim endpoint, which returned result_for_different_session without returning the answer body.

This supports stale-ID isolation for the tested version and ordering, and validates identity checks at result retrieval. It is not an atomicity proof for arbitrary scheduling: the observation window is bounded, and already-queued messages followed by clear, actual PID reuse and power failure were not exercised. Handle retrieval is an additional prototype defense, not a required V1 interface. The design retains UUIDs, bindingIds, per-operation checks and suspended return delivery when evidence is insufficient.

## Evidence and cleanup

Private mode-0600 reports live in ignored storage:

- `.local/verification/connector-lifecycle.json`: fourteen checks, actual calls, hooks, enrollment and cleanup.
- `.local/verification/codex-hotload-discovery.json`: before/after model records and MCP identity for the same thread.
- `.local/verification/connector-native-race.json`: positive controls, stale-frame observations, new-session history and denied cross-session retrieval; two explicit checks plus race observation fields.
- `connector-lifecycle-first-reload-attempt.json` and `connector-lifecycle-hotload-attempt.json`: retained earlier failures. The latter exposed a driver that mistook redrawn prompt text for completion; it was changed to await actual probe events.

Local fixtures under `.local/lifecycle-spike/` are run.mjs, codex-hotload.mjs, race.mjs, probe.mjs, registration-server.mjs and a PTY helper. They depend on the local identity fixtures and are not a published general-purpose smoke command.

Tests used new temporary directories, isolated Codex homes/sockets, owned Claude sessions and owned process groups. All writes targeted allowlisted test resources. All test processes exited, Codex test threads were archived, and copied authentication directories and plaintext enrollment configuration were removed. Working sessions received no messages, resume, rename or interrupt operations.

Identity, communication and basic lifecycle now have experimental support on these hosts. Production configuration/storage integration and acceptance remain: two Claude models initiating collaboration, user interruptions, concurrent/out-of-order replies, rejection of replies to results, deadline boundaries and forced-crash recovery. Codex CLI/desktop, shared MCP processes, native Linux identity and Windows are outside this run's support claims. A later [plugin hot-load experiment](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.md) verified a separate dynamic MCP installation path in interactive Claude CLI.
