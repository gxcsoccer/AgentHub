# Real-backend verification

[简体中文](VERIFICATION.zh-CN.md) · [API reference](API.md)

Verified on **2026-11-04**, macOS, existing Codex App Server **0.166.0**, using the configured real model. The isolated suite completed **25 checks covering all 22 API operations and the OpenAPI document**. This is backend/API acceptance, not a visual desktop test or a guarantee for other versions.

## Operation matrix

| Operation           | Observed success criterion                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `capabilities`      | Connected backend and 22 declared operations                                                        |
| `listSessions`      | Newly populated test thread appears under its working directory                                     |
| `loadedSessions`    | Created/resumed IDs appear; archived IDs disappear                                                  |
| `searchSessions`    | Unique input marker finds the test thread in the real index                                         |
| `createSession`     | New root thread created in a temporary directory                                                    |
| `sessionDetail`     | Correct thread identity and state returned                                                          |
| `listTurns`         | Cursor advances to a different real turn                                                            |
| `listItems`         | Cursor advances to a different real item                                                            |
| `searchOccurrences` | Both real input and model reply found                                                               |
| `attachSession`     | Existing loaded test thread attaches and delivers subsequent events                                 |
| `resumeSession`     | Unloaded thread resumes and answers another real message                                            |
| `detachSession`     | Upstream unsubscribe acknowledged on the test connection                                            |
| `forkSession`       | Different ID; inherited history ends at the requested turn; own input works                         |
| `renameSession`     | Detail immediately reports the requested test name                                                  |
| `archiveSession`    | Thread unloaded and found in archived list                                                          |
| `unarchiveSession`  | Populated thread returns to the normal list                                                         |
| `sendMessage`       | Real reply persisted and streamed; steer changes the same turn; stale steering rejected             |
| `injectContext`     | No implicit turn; next model turn recalls the injected secret marker                                |
| `interruptTurn`     | Real waiting-input turn reaches `interrupted`; thread becomes idle                                  |
| `events`            | Start, text deltas and terminal events received through HTTP SSE                                    |
| `pendingRequests`   | Real question/command-approval request appears with its request ID                                  |
| `respondToRequest`  | Model consumes question answer; duplicate reply rejected; approval decline and accept both verified |

The approval accept case allows only an exact isolated Python print command (or its exact known shell wrapper), asserts the working directory, observes exit code 0 and the marker in actual command output. It does not approve a session-wide rule. All other commands fail the test's allowlist and are declined. The API server itself still never auto-approves; the test client explicitly supplies the decision.

The earlier existing-session smoke also verified same-key message deduplication: one receipt and exactly one new turn after repeated submission.

## Isolation and cleanup

- Tests create their own root/fork threads and a temporary working directory.
- Every mutating RPC must target an ID created by this run. Existing work sessions are not resumed, interrupted, renamed, archived or messaged.
- Read-only sandbox, network-disabled execution and approval-on-untrusted settings apply only to the test thread. Plan/default mode switches are also thread-local.
- Test threads are archived and confirmed unloaded before deleting the temporary directory. Archived test transcripts remain available for audit.
- Reports include private thread IDs and mutation records, are written with mode `0600`, and remain under ignored `.local/verification/` rather than in the package.

## Findings and limits

1. **Empty previews are hidden.** A fresh fork may have inherited history yet an empty preview. Normal listing excludes it even after unarchive; archived listing can include it. The test verifies populated-thread list visibility after its first own input.
2. **Accepted is not yet interruptible.** Immediate interruption can race upstream task registration and return `409`. The deterministic test waits for an actual blocking question before interrupting. It does not silently retry against another turn.
3. **Notifications can precede responses.** A fork's started notification may arrive before its ID is returned. The test ignores unowned notifications and separately enforces write ownership.
4. **Scope is explicit.** Desktop rendering, native child-agent mailboxes, cross-backend routing, restarts with durable receipts and every possible approval subtype are not covered by this result. The suite verifies real command approvals and user questions, not file-change, network-policy or every plugin-specific request.

## Reproduce

```sh
npm ci
npm run check
npm run smoke:isolated -- --run --report .local/verification/full-suite.json
```

This is an opt-in real-model test and is not part of ordinary CI. It creates persistent test transcripts, then archives them. Set `CODEX_BRIDGE_SOCKET` to target another already-running backend. Review the JSON report's `passed`, `unverifiedOperations`, `onlyOwnedSessionsMutated`, and `cleanupAllUnloaded` fields. Failed attempts are evidence of a failed run, even when subsequent corrected runs pass.
