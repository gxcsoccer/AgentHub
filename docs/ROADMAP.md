# Delivery status and remaining verification

[简体中文](ROADMAP.zh-CN.md)

The `@gxcsoccer/agenthub@0.4.2` release includes PRs #1–#3, #9, #11 and #13, with matching [GitHub release assets](https://github.com/gxcsoccer/AgentHub/releases/tag/v0.4.2). See the [changelog](../CHANGELOG.md) for upgrade requirements and retained capability boundaries.

| Work group                    | Implementation and evidence                                                                                                                                         | Boundary                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Caller authorization          | Per-caller tokens, instance/session/operation grants, receipt/SSE/approval isolation and forwarding checks                                                          | Same-OS-user malicious code is outside the isolation model                                   |
| Real ACP backends             | Actual Claude and Codex model replies, deduplication, history isolation, conversation continuity and owned-process cleanup                                          | Explicit managed sessions; no live attach or native-history recovery                         |
| Independent backend E2E       | Real Claude MCP calls to two separate Codex App Servers with distinct PIDs, homes and sockets; isolation and single-backend failure checks                          | Same host; remote networking/authentication are not validated                                |
| Compatibility and load        | Explicit Claude 2.1.317/2.1.318 allowlist, Codex 0.165.0/0.166.0 acceptance, Linux/macOS Node 22/24/26 CI, bounded synthetic soak and manual extended-soak workflow | Exact successes and failed attempts are in verification; model reply remains model-dependent |
| Publication and documentation | npm distribution, installed CLI examples, bilingual acceptance commands and release status                                                                          | Doubao setup is included in 0.3.0; optional plugin store publication remains pending         |
| Existing extensions           | SQLite bounded event replay, per-session history text search and managed ACP v1                                                                                     | Consumer checkpoints remain client-owned; no shared full-history index                       |

[Acceptance](ACCEPTANCE.md) gives reproducible commands. [Verification](VERIFICATION.md) separates real models, protocol fixtures, synthetic load and historical evidence. [Extensions](EXTENSIONS.md) defines API limits.

Windows completion is excluded from this follow-up: native model acceptance, callbacks/replies and private durable storage remain pending. Doubao 0.3.0 provides plugin-free MCP setup, an optional local CLI plugin and isolated stdio MCP acceptance against real Claude/Codex; Doubao 2.35.15 now has real host request/reply evidence and five live checks for automatic host registration/removal. Unified setup commands manage generated configuration and the Hub; native MCP configuration removal remains manual. Busy host interleaving/disconnect, native identity, unsolicited wake-up, Agent OpenAPI and MCP Events remain pending. [Setup and boundaries](DOUBAO.md).

Durable consumer groups, full-history indexing and hot policy updates are optional future work. Longer production observation and additional native versions require fresh evidence. Native dynamic reply tools in existing Codex sessions retain creation-time registration constraints. The connector integrates App Server MCP reload into the connector with real bidirectional acceptance. AgentHub does not simulate tool installation with implicit resume.

## Automatic agent connections (implementation underway)

The [revision-11 design proposal](AGENT_CONNECTOR.md) is being implemented: 0.2.0 implements shared Claude/Codex tools and enrollment; Codex connect and bidirectional live acceptance pass, with opt-in Claude CLI activation now implemented and native MCP external reload still unavailable. [Native identity experiments](SESSION_IDENTITY_EXPERIMENT.md) verified Claude startup IDs, stale environments after clear and Codex per-call identity. V1 proposes automatic enrollment on accepted hosts, manual fallback, one implicit team and disambiguated name addresses. Planned order:

1. Included in 0.2.0: request/result rendering in both adapters, ingress/core guards, schema 3 protection and legacy-message compatibility.
2. Claude native enrollment, lifecycle refresh, name disambiguation, three tools and optional deadlines are implemented with nine live checks. Manual fallback, full diagnostics and remaining fault acceptance are pending.
3. Bidirectional Codex/Claude collaboration and Codex setup/activation pass. Disable/uninstall, full diagnostics, compatibility and fault acceptance remain.

The [roundtrip prototype](CONNECTOR_ROUNDTRIP_EXPERIMENT.md) verified bidirectional requests/replies and clear isolation. The [lifecycle prototype](CONNECTOR_LIFECYCLE_EXPERIMENT.md) adds installation, credential separation, graceful service restart, MCP reconnect, stopped-session resume/fork and controlled races. [CLI plugin hot loading](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.md) separately passed seven checks, adding MCP to the same live Claude session. The production Claude core now passes nine isolated checks; concurrent/out-of-order delivery, forced-crash recovery and all busy user interleavings remain broader acceptance work. Other hosts require separate compatibility tests. Multiple teams, leases, a separate request state machine, dual deadlines, late-result push and advanced budgets are deferred.

The proposal does not expand Windows, Doubao or remote-access scope. Existing test results are not acceptance evidence for the new design.

[External activation follow-up](CLAUDE_AUTO_ACTIVATION_EXPERIMENT.md) records installation without automatic MCP activation, a limited skill → CLI success, clear identity refresh and failed attempts. Native MCP external reload still lacks a control interface; opt-in native-message-to-CLI activation is now implemented as described in setup.

The production Claude connector passed nine isolated live checks; see [setup and limits](CONNECTOR_SETUP.md). Remaining work includes Claude native MCP external reload, installer uninstall/disable, manual binding fallback, full readiness diagnostics, startup ordering and forced-crash/queued-before-clear cases. Historical binding collection and configurable budgets also remain pending.

Codex connect and the shared tools passed six further live checks: existing-root installation/activation, a read-only identity handshake without a model turn, idempotent configuration preserving permissions, both request/reply/result directions, and result termination. No dynamic reply tool or thread/resume was used.

Claude CLI connect passes ten live checks, with seven additional Claude CLI/Codex MCP checks. A host without Bash remains unverified despite receiving and replying to activation; only an actual CLI call in the target process chain completes it. This path uses the model and existing host permissions without installing MCP. The Doubao setup workflow now provides profile generation, managed Hub removal/disable and read-only diagnostics, plus explicit host registration/removal. General native MCP removal and broader fault/capacity acceptance remain.

## Next: requester feedback

The requesting agent isn't told when a target ends its turn without replying, and connector tools can't query status. Planned, not implemented: `ask_agent` returns a racy `targetBusy` hint, and the Hub sends one `result` notice through the forward path when a turn ends without a reply. The notice requests no reply, so it can't loop, but it does cost the requester a model turn. A later real reply must still get through.

Widening the Codex reply fallback to merged turns needs real samples of an envelope merged in the middle of user work and of adjacent envelopes first. Turn structure can't show where an answer's content came from.

A target waiting for approval has the same gap. The requester only waits, and later messages to that session queue behind the approval. In one real run, a Codex edit waited for approval while the next two requests went unprocessed. Reporting this to the requester belongs with the feedback above.

## Codex task reliability

In real plain TUI runs on Codex 0.166.0 without `developer_instructions`, peer requests were handled inconsistently. The same `pwd` ran in one thread and was refused in another. Edits, a review and an explicit `reply_agent` request were refused because external content can't authorize them. Threads started with `developerInstructions` ran 4 of 4 requests. Samples are small, so no rate is known, and a plain session shouldn't be promised to do the work.

Whether to use a dedicated collaborator thread with its own `developerInstructions` or global `developer_instructions` is undecided. `collaborationMode` isn't a substitute: in `default` mode the model catalog overrides custom text, and `plan` changes the session's mode. A refusal in reply text can't be detected at the protocol level.
