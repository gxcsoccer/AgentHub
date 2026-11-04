# Verification

[简体中文](VERIFICATION.zh-CN.md)

## Automated checks

```sh
npm ci
npm run check
```

The suite contains 93 AgentHub tests and the 41 original Codex Session Bridge tests: 134 passing tests. The root check also runs formatting, strict TypeScript checks and coverage thresholds. The imported bridge is tested from its own directory, preserving its original fixtures and contract.

AgentHub coverage includes concurrent idempotency, capacity/expiry, payload conflicts, uncertain delivery, early/late replies, bounded reply forwarding, shutdown races, Codex tool-output delivery and explicit approval responses, Claude NDJSON framing and reverse callbacks over local test sockets, policy controls, malformed/expired callbacks, bounded history and cursor changes, authentication/origins, malformed HTTP requests, the original JSON CLI commands, all seven current MCP tools through a real stdio child, SSE slow consumers/CRLF/multiline frames, and OpenAPI consistency.

On Node 25.9.0, V8 coverage of compiled `dist/src/**/*.js` was 96.40% lines, 87.17% branches and 93.92% functions. This excludes the retained bridge and live scripts. `npm run test:coverage` enforces aggregate minimums of 90%/80%/85%; `npm run check` and CI include that command. These metrics do not prove exhaustive behavior or live compatibility. The audit found and fixed malformed-URL 500 responses, writes after SSE termination, CRLF/chunk-size parser errors, partial-constructor listener leaks and non-Error adapter rejection handling.

Additional tests cover SQLite transaction rollback, retention, schema/corruption/path rejection, disk failures, single-owner locks, explicit attach via HTTP/CLI, and conservative tool readiness. Actual child processes are SIGKILLed at native submission and reply-forward crash points: the lock is released, ambiguous messages are not replayed, stable IDs survive, and a late simulated Claude callback rebinds the original socket and forwards once.

Adapter unit tests use fake peers and RPC transports. They do not prove acceptance by a running model. The complete check passed locally on Node 22.23.2 and 25.9.0. CI is configured for Linux/macOS and Node 22/24; it does not run live model tests or use credentials. The first remote CI passed Linux/macOS Node 22/24 full checks, Windows Node 22/24 portable checks and a Linux synthetic soak. The final renamed commit is checked again before release.

## Live cross-harness validation

On 2026-11-04, validation ran on macOS with Node 25.9.0, Codex CLI/App Server 0.166.0 and Claude Code 2.1.318:

| Run                          | Claude addressing                                                                  | Result                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Private inbox                | Explicit binding of the newly created session and private socket                   | Passed                                                         |
| Default inbox                | Production `claude agents --json` discovery and `/tmp/cc-socks/<pid>.sock` mapping | Passed                                                         |
| Entrypoints and fault matrix | Default discovery/inbox, HTTP SDK, JSON CLI, MCP stdio and SSE                     | 14 checks passed, including a post-run read-only archive audit |

The original two runs exercised the reusable adapters and Hub:

1. Create a fresh allowlisted Codex thread and a fresh Claude process in temporary working directories.
2. Send Codex a tool output. Codex calls an owner-registered test delegation tool.
3. Send the delegated message to Claude through the native inbox.
4. Claude replies with native `SendMessage` to the Hub callback socket.
5. Hub forwards the correlated reply to Codex as another tool output; Codex acknowledges through `agenthub_reply`.
6. Verify message IDs and payload, Codex history without user-message injection, and Claude history carrying peer origin.
7. Stop only the test Claude process, archive the test Codex thread and verify it is unloaded, then remove the temporary working directory.

All four functional checks passed in each original run. The expanded matrix additionally tested:

- A JSON CLI submission through HTTP, SDK-driven cross-harness delegation, all seven MCP tools through a spawned stdio process, and correlated SSE reply evidence.
- Claude hold/release and refusal, identical retries and payload conflicts, deterministic busy queuing, bounded status polling and late replies. Gate tools keep the target verifiably busy without relying on timing guesses.
- Codex busy messages joining the same turn, deduplication, explicit gate responses, and a session without the reply tool that accepts input without claiming a correlated reply.
- Transport disconnection with an explicit gap, retained receipts, history reload and no automatic replay/reattach.
- A fault proxy that forwards to the real Claude inbox but withholds transport closure: the sender reports `unknown`; native history proves delivery occurred once, and retrying the same ID does not resubmit.
- An exited Claude target that rejects new input without resume, plus native-history identity/tool-scope checks across both owned Codex threads.

Cleanup confirmed `allOwnedUnloaded: true` and `onlyOwnedSessionsMutated: true`. The matrix intentionally terminates its own Claude target. Existing working sessions received no messages, resumes, interrupts, approval responses or setting changes. Claude native history identifies the Hub process as its peer; the upstream author is envelope metadata, not a separately authenticated native peer.

**Recovery follow-up:** the earlier matrix timed out waiting for a Codex reply after reconnection because `turn/start` does not restore its listener. Its failed report remains `.local/verification/entrypoints-matrix-reply-recovery-failed.json`. The supported recovery is now explicit owner attachment, not automatic resume.

A separate real recovery run passed all **6 functional checks**, plus cleanup, in `.local/verification/recovery.json`:

1. Read-only readiness and refusal of an unloaded or unverified-tool target, with no implicit resume.
2. Disconnect while Codex is held in a test tool; explicit reattach, the same turn continues and returns the correlated reply.
3. Hold real Claude before its reply, SIGKILL the Hub child, reopen the same SQLite state, explicitly reattach Codex, release Claude, receive its native SendMessage on the old callback address and forward once to Codex.
4. Restart again, recover completed receipts and stable forwarding IDs; duplicate requests do not resubmit and conflicting payloads fail.
5. Three explicit attachments preserve model, directory, approval policy/reviewer and read-only sandbox with network disabled.
6. Native histories preserve identity and exact input count: one Claude peer delivery, three Codex tool outputs (including controller bootstrap), no shell/file/web activity or user-message injection.

The run used a newly created Claude process with an explicitly bound private inbox and three allowlisted Codex threads. Every test process exited and every owned Codex thread was archived/unloaded; only owned sessions were mutated. It does not establish callback delivery while Hub is down, machine/power-loss behavior, arbitrary live tool installation, or automatic listener recovery. That historical recovery run used process-local events; schema 2 now separately verifies durable cursors.

The existing live matrix was rerun after the recovery changes: all 14 in-run checks passed in `.local/verification/entrypoints-matrix-after-recovery.json`, with successful archive/unload and owned-process cleanup. This is separate from the earlier 14-check report, which included an additional post-run read-only audit.

Two earlier recovery attempts remain as failed evidence: `recovery-first.json` found that a new, never-run Codex thread may not yet have persisted metadata (readiness correctly stays unknown); `recovery-second.json` passed the six functional checks but cleanup redundantly archived an already archived thread. The final runner bootstraps its isolated existing session and tracks completed cleanup actions.

Reproduce manually, with an already running Codex App Server and authenticated CLIs:

```sh
# Omitting --run performs no live actions.
npm run smoke:isolated
npm run smoke:isolated -- --run --report .local/verification/cross-harness.json
npm run smoke:isolated -- --run --default-inbox --report .local/verification/cross-harness-default.json
npm run smoke:isolated -- --run --default-inbox --matrix --report .local/verification/entrypoints-matrix.json
npm run smoke:recovery -- --run --report .local/verification/recovery.json
```

The script consumes model quota. Codex uses a read-only sandbox, untrusted approvals, disabled execution network and narrowly scoped test tools. Claude exposes `SendMessage` and, for the matrix/recovery tests, a local deterministic gate MCP tool; it has no shell/file tools. Only the newly created Claude process receives controller-driven policy changes. Native transcripts remain in native history. Reports contain private transcripts and environment data, use mode 0600, and stay in ignored `.local/verification/`; do not publish them.

## Read-only doctor acceptance

Eight additional automated tests cover GET-only diagnosis, missing/detached reply tools, Claude opt-in/version/inbox distinctions, authentication failures, timeout without retry, malformed responses, partial failure, the 32-instance/four-concurrent limit, content omission and CLI exit codes.

Three local live read-only checks completed: default instance diagnosis, one loaded Codex root and one running Claude session. The Codex target correctly reported a missing reply tool warning; Claude reported declared capabilities and `processVersionVerified:false`. Evidence is in `.local/verification/doctor-readonly.json`. Native RPC was restricted to thread/list, thread/loaded/list and thread/read; all HTTP requests were GET, with no sends, attachment, callbacks or existing-session changes. This is not a substitute for the live delivery acceptance above.

```sh
npm run smoke:doctor -- --run
```

## Limits

- The matrix covers the named scenarios, not all combinations, long-duration load, every approval subtype or every harness/provider version. CLI success paths and MCP tools are exercised individually; branch coverage remains below 100%.
- No Doubao runtime acceptance, Windows native-model acceptance, arbitrary existing-session tool registration, or native Codex agent-mailbox equivalence is claimed.
- MCP is exercised over real stdio and HTTP against live harnesses; this still does not prove Doubao accepts a particular plugin configuration.
- The original bridge's historical 22-operation isolated acceptance is documented in `vendor/codex-bridge/docs/VERIFICATION.md`. Importing that evidence does not mean all 22 operations were rerun live for AgentHub or normalized into the new API.
- CLI version checks cannot establish the version of every already-running Claude process. The native protocol adapter remains explicitly enabled and version-specific.

## Distribution

`npm pack` builds the package. The package allowlist includes compiled library/CLI modules, the retained bridge, licenses, schemas, documentation and examples. It excludes live reports, research caches and test transcripts. Before publication, install the tarball in an empty temporary project, verify the five exported entrypoints and both CLI help commands, and run the check suite. No publication is performed by the check or smoke commands.

## Expanded acceptance (2026-11-04)

`smoke:claude-initiated -- --run` passed five checks: the actual Claude model initiated MCP sends to two logical Codex instances using separate connections on the same App Server, retrieved both correlated replies, verified history/search isolation, and rejected an unauthorized cross-instance address. Both newly created Codex sessions were archived and the Claude child exited. Private report: `.local/verification/claude-initiated.json`. This is not two independent backend servers.

New automatic tests cover caller-scoped discovery, reads, replies, SSE, approvals, private credential files, durable event migration/replay and atomic rollback, bounded full-text scanning, and official ACP v1 SDK interoperability with a real fixture process. The ACP fixture is not a real coding model. Windows pipe tests distinguish wire transport from native model receipt. See [extension boundaries](EXTENSIONS.md).

A 120-second synthetic run passed 3,352 HTTP submissions, 442 duplicate checks and 23 SQLite/server reopen cycles. Native submission count matched unique requests; event cursors survived restarts. Post-GC heap grew about 3.7 MiB, RSS about 69.4 MiB and active resources stayed at four. This is a bounded load check, not proof of long-term production stability. A longer run and remote CI results are recorded when completed.

The ten-minute synthetic run passed 16,432 unique submissions, 2,168 duplicate checks and 114 server/SQLite reopen cycles. Native calls matched unique messages. Open file descriptors stayed at 21; post-GC heap grew 4.04 MiB and RSS 89.69 MiB, within the scripted limits. Private report: .local/verification/soak.json. This is not ten minutes of real-model load or a proof against longer-term leaks.
