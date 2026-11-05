# Automatic enrollment and cross-harness roundtrip experiment

[简体中文](CONNECTOR_ROUNDTRIP_EXPERIMENT.zh-CN.md) · [Identity experiment](SESSION_IDENTITY_EXPERIMENT.md) · [Integration design](AGENT_CONNECTOR.md)

Date: 2026-11-05. Environment: macOS, Claude Code 2.1.318, Codex App Server 0.166.0, Node 26.12.1.

This extends identity inspection into **automatic source attribution, name resolution, native dispatch, correlated replies, return delivery and model observation**. Eight checks passed in the final run: five requests received five native replies; source models observed four returned results; one old-session answer was retained without return delivery. Fixed markers validate communication, not complex collaboration quality.

This is isolated prototype acceptance, **not acceptance of a released AgentHub connector kit**. Production `src/` was unchanged.

## Executed path

The experimental connector exposes `ask_agent(to, message)`. Models supply only a target name and body. The connector supplies source identity, request IDs, bindings and return routing. Claude startup environment/hooks and Codex per-call MCP metadata come from real hosts; no session ID is manually injected into MCP configuration.

A localhost HTTP registry cross-checks same-user process ancestry, parent start identity, native discovery and owned process/session allowlists. Requests reuse the existing AgentHub core and adapters. Codex replies through `agenthub_reply`; Claude replies through native `SendMessage`.

Experiment-only result rendering uses Codex `toolOutput` and Claude's native inbox without reply templates. A result counts as observed only when the source model actually calls the test-only `record_result(request, text)`. That tool records evidence without sending a message. This does not exercise production result rendering, which remains unimplemented.

## Results

| Scenario                      | Observation                                                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude enrollment             | Shared MCP/hook configuration automatically enrolled the native startup UUID without per-session source-ID configuration                                                               |
| Claude → @codex/beta → Claude | Real model initiation, native Codex dynamic-tool reply, then a new message actually observed by Claude                                                                                 |
| Codex → @claude/alpha → Codex | Real per-call metadata identified Codex; Claude replied natively; Codex actually observed the returned result                                                                          |
| Duplicate Codex names         | A second owned same-name thread made resolution ambiguous without submitting another message; renaming restored unique resolution. The controller invoked this negative resolver check |
| Clear while waiting           | A test gate held Codex's reply while Claude cleared to a new UUID; after release, the answer stayed in its original receipt and return delivery reported binding_unavailable           |
| Collaboration after clear     | Same MCP PID and stale startup UUID; a new hook and native directory established a new binding and invalidated the old one. A subsequent request/result used the new UUID              |
| Native rename                 | After Claude renamed to gamma, the old name stopped resolving; Codex actually asked @claude/gamma and received a reply from the post-clear UUID                                        |
| Request/result counts         | Five requests, five replies, four return deliveries and model observations, one suppressed stale return; no result acknowledgement loop occurred in this run                           |

## Problems encountered

Failed attempts are retained. The final result was not one uninterrupted, fully unattended green run.

1. Initial TUI trust-prompt keystroke timing failed before messaging. The driver was corrected and retried.
2. Codex `thread/list` omitted a newly created thread with no conversation content. A read-only cross-check returned listCount=0 while `thread/loaded/list` plus `thread/read` returned its ID and name. Resolution now uses the latter.
3. Claude hooks can belong to a different process group. Requiring the helper to share Claude's group rejected a startup hook. Validation now checks helper UID, actual PPID and the Claude parent's start identity; process groups only establish test ownership of that parent.
4. Codex requested approval for new MCP tools and did not initiate the reverse request. Only the three allowlisted experiment tools—ask_agent, record_result and hold—were explicitly permitted in the new test home. Working-session approvals were unchanged; peer messages did not grant permission.
5. During the final run Codex used alias instead of the schema field to. MCP validation rejected it before submission. The controller supplied precise argument names, then the real model successfully retried. No already-submitted request was resent. Subsequent fixture prompts explicitly name the fields.

## Evidence, cleanup and limits

Private mode-0600 report `.local/verification/connector-roundtrip.json` contains versions, eight checks, source/target/binding records, hooks, per-call identity, native replies, dispatches and model observations. Argument correction is recorded in `connector-model-argument-retry.json`; three previous attempts are retained as `connector-roundtrip-*-attempt.json`. Full TUI output and event logs remain in private temporary directories referenced by the reports.

Ignored `.local/connector-spike/` contains run.mjs, registry.mjs and connector.mjs, reusing the identity experiment's PTY/process helpers. These are local prototype fixtures, not a published general-purpose smoke command.

All test processes exited. The final run's two Codex threads were archived; copied authentication and the experimental HTTP token file were removed. Earlier attempts also cleaned up. No working session received messages, renames, resume or interrupt operations.

Later [lifecycle experiments](CONNECTOR_LIFECYCLE_EXPERIMENT.md) add prototype evidence for stopped-session Claude resume/fork, MCP reconnect, enrollment credentials and durable bindings. Still untested: Codex CLI/desktop, deliberately shared MCP processes, Linux/Windows, actual PID reuse and arbitrary lifecycle races. The in-memory prototype registry uses owned-resource allowlists; production enrollment authorization, configuration, durable bindings and crash recovery are not implemented. The ordered clear test does not prove atomicity between native-directory validation and transport writes.

The evidence supports native-identity binding and name addressing on the tested hosts, with lifecycle refresh, ambiguity handling and tool-enable permissions as explicit integration requirements.
