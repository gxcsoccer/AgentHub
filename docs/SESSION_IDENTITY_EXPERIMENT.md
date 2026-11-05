# Native session identity and self-registration experiment

[简体中文](SESSION_IDENTITY_EXPERIMENT.zh-CN.md) · [Integration design](AGENT_CONNECTOR.md)

Date: 2026-11-05. Environment: macOS, Claude Code 2.1.318, Codex CLI / App Server 0.166.0, Node 26.12.1. The SDK rename comparison used Claude Agent SDK 0.3.316 only.

This records actual processes and model tool calls. Thirteen evidence assertions passed, including confirmation of disproved assumptions; these are not thirteen production feature acceptance tests. AgentHub automatic registration is not implemented.

A subsequent [enrollment and bidirectional roundtrip prototype](CONNECTOR_ROUNDTRIP_EXPERIMENT.md) exercised refresh and old-result isolation after clear. The production connector kit remains unimplemented.

## Observations

| Question                                           | Experiment and observation                                                                                                                                         | Conclusion                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Can Claude MCP identify its session?               | Two new print-mode sessions used identical cwd/MCP configuration and actually invoked probe. Each MCP environment's CLAUDE_CODE_SESSION_ID matched its native UUID | Startup identity is directly available; the experiment did not supply it in MCP configuration                                          |
| Can hooks and MCP be paired?                       | Compare PPID and parent start seconds/microseconds from macOS proc_pidinfo, then native directory PID                                                              | Both concurrent sessions matched independently despite identical cwd                                                                   |
| Does interactive Claude behave similarly?          | A new TUI session invoked the same probe                                                                                                                           | Interactive MCP startup also had the correct ID                                                                                        |
| What does /rename change?                          | Execute /rename in that TUI and reread claude agents --json                                                                                                        | Name changed; UUID and PID remained stable                                                                                             |
| Does SDK rename immediately rename the live entry? | renameSession on another owned session, then SDK metadata and native-directory reads                                                                               | Persisted title changed, but the immediate live-directory read retained its old name                                                   |
| Are names unique?                                  | Two simultaneous same-name Claude sessions; two same-name Codex threads in one isolated server                                                                     | Both allow duplicate names with distinct IDs; a harness prefix does not remove same-harness ambiguity                                  |
| Does Claude /clear change identity?                | Read SessionStart hook and native directory after /clear                                                                                                           | UUID changed while PID and name remained unchanged                                                                                     |
| Can the MCP environment identify Claude forever?   | Actual probe calls before and after /clear                                                                                                                         | The same MCP process survived with the old environment UUID; startup identity became stale                                             |
| Does Claude call metadata supply the new ID?       | Inspect both raw MCP tools/call requests                                                                                                                           | Observed progressToken and claudecode/toolUseId, but no current sessionId/threadId                                                     |
| Must Codex infer identity from its environment?    | Two new threads in one isolated App Server actually invoked MCP probe                                                                                              | Both MCP environments lacked CODEX_THREAD_ID, while each request's \_meta.threadId and \_meta.sessionId matched the originating thread |
| Do native Codex tools carry identity?              | Both models called the registered identity_native tool                                                                                                             | App Server supplied correct threadId, turnId and callId, cross-checked with MCP calls                                                  |
| Codex names and IDs                                | Exercise thread/list, thread/loaded/list, thread/name/set and thread/read                                                                                          | IDs/names/runtime state were discoverable; renaming preserved the ID                                                                   |

## Design consequences

### Codex: prefer per-call identity

An observed MCP request had this shape, with values anonymized:

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

The model supplied marker/gate only; the host supplied identity metadata. A connector can validate threadId within an authorized instance and register its address. This tested path needs neither manual per-session binding nor PPID-based differentiation of threads sharing an App Server.

Each tested thread started its own MCP process. Although identity is per-call, this run did not deliberately exercise multiple threads sharing one MCP process, Codex CLI/TUI, desktop hosts or session switching. MCP metadata is local host evidence, not remote identity authentication.

### Claude: startup identity plus lifecycle refresh

Reading CLAUDE_CODE_SESSION_ID at startup works. Treating it as permanent connector identity was disproved by /clear.

Recommended implementation:

1. Read the startup UUID and cross-check it against native discovery and parent process-start identity.
2. Send SessionStart/SessionEnd lifecycle events to Hub; associate surviving MCP connections through the verified Claude process identity.
3. Refresh current sessionId after clear/switch events and recheck the native directory on new calls. Outstanding requests retain their original IDs so old results do not enter a new session.
4. Suspend new-call attribution when cached and current identities disagree, until validation or explicit binding resolves it.

This run verified clear events and directory updates. Later [roundtrip](CONNECTOR_ROUNDTRIP_EXPERIMENT.md) and [lifecycle](CONNECTOR_LIFECYCLE_EXPERIMENT.md) prototypes cover refresh, resume/fork after normal exit and MCP reconnect. Production implementation, abnormal exit and actual PID reuse remain pending.

### Name prefixes: addresses, not unique identity

An authorized native directory can provide @claude/reviewer and @codex/developer. Keep `{harness, instance, nativeSessionId}` internally and fix the actual ID when submitting. Disambiguate duplicate names with instance/ID; renames affect future resolution. The clear experiment also showed one name and PID representing different UUIDs over time.

This verified the real discovery and source identity required for those addresses. This run did not test new alias resolution, self-registration HTTP endpoints, enrollment authorization or complete collaboration tools. Later prototype evidence is linked above; production delivery remains pending.

## Isolation, evidence and reproduction limits

- Two headless Claude sessions used fresh UUIDs with identical names, cwd and MCP configuration. Models had only the test probe. A separate fresh interactive Claude handled rename, clear and before/after probe calls.
- Codex used an independent App Server, home and socket, copying authentication only. Two new threads used a read-only sandbox and disabled execution networking. Models were instructed to call only the test dynamic tool and probe; the controller guarded writes with an owned allowlist.
- Probe logs contain allowlisted identity environment fields, process-start information and test calls. Messaging tokens are represented only by a presence boolean, never their value.
- All owned process groups stopped; both Codex threads were archived and the copied authentication directory removed. No working session received messages, renames, resume or interrupt operations.
- Raw reports are mode 0600 under ignored `.local/verification/session-identity.json`, `session-identity-interactive.json` and `session-identity-summary.json`. Full terminal output and test directories remain in private paths referenced by those reports.

Local scripts under ignored `.local/identity-spike/` are run.mjs, interactive.mjs, probe.mjs, pty-launch.py, stream-launch.mjs and process-info.py. These are spike fixtures, not a published general-purpose smoke command or cross-platform compatibility suite.

Reproduction: create isolated sessions and record their UUIDs; invoke probe through identical MCP configuration; compare hook/environment/raw MCP metadata with native discovery; run rename and clear in a fresh TUI and invoke probe again; close owned processes and verify cleanup. Real model authentication/quota are required, and all sessions must be newly created.
