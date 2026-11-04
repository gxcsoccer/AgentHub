# Verification

[简体中文](VERIFICATION.zh-CN.md)

## Automated checks

```sh
npm ci
npm run check
```

The suite contains 97 AgentHub tests, the 41 original Codex Session Bridge tests and 21 live-runner safety tests: 159 tests on Linux/macOS. The root check also runs formatting, strict TypeScript checks and coverage thresholds. The imported bridge is tested from its own directory, preserving its original fixtures and contract.

AgentHub coverage includes concurrent idempotency, capacity/expiry, payload conflicts, uncertain delivery, early/late replies, bounded reply forwarding, shutdown races, Codex tool-output delivery and explicit approval responses, Claude NDJSON framing and reverse callbacks over local test sockets, policy controls, malformed/expired callbacks, bounded history and cursor changes, authentication/origins, malformed HTTP requests, the original JSON CLI commands, all seven current MCP tools through a real stdio child, SSE slow consumers/CRLF/multiline frames, and OpenAPI consistency.

On Node 25.9.0, V8 coverage of compiled `dist/src/**/*.js` was 96.40% lines, 87.17% branches and 93.92% functions. This excludes the retained bridge and live scripts. `npm run test:coverage` enforces aggregate minimums of 90%/80%/85%; `npm run check` and CI include that command. These metrics do not prove exhaustive behavior or live compatibility. The audit found and fixed malformed-URL 500 responses, writes after SSE termination, CRLF/chunk-size parser errors, partial-constructor listener leaks and non-Error adapter rejection handling.

Additional tests cover SQLite transaction rollback, retention, schema/corruption/path rejection, disk failures, single-owner locks, explicit attach via HTTP/CLI, and conservative tool readiness. Actual child processes are SIGKILLed at native submission and reply-forward crash points: the lock is released, ambiguous messages are not replayed, stable IDs survive, and a late simulated Claude callback rebinds the original socket and forwards once.

Adapter unit tests use fake peers and RPC transports. They do not prove acceptance by a running model. The complete check passed locally on Node 22.23.2 and 25.9.0. CI is configured for Linux/macOS and Node 22/24/26; it does not run live model tests or use credentials. The first remote CI passed Linux/macOS Node 22/24 full checks, Windows Node 22/24 portable checks and a Linux synthetic soak. Published commit 3b8a216 passed all seven release jobs: https://github.com/gxcsoccer/AgentHub/actions/runs/41842156518. The post-release matrix adds Linux/macOS Node 26. Package installation from an empty npm cache also passed locally.

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

- A JSON CLI submission through HTTP, SDK-driven cross-harness delegation, the six MCP tools available at the time through a spawned stdio process, and correlated SSE reply evidence.
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

The script consumes model quota. The historical runs used untrusted approvals; the current isolated runner uses on-request approvals (fresh Codex configuration rejects untrusted), a read-only sandbox, disabled execution network and narrowly scoped test tools. Claude exposes `SendMessage` and, for the matrix/recovery tests, a local deterministic gate MCP tool; it has no shell/file tools. Only the newly created Claude process receives controller-driven policy changes. Native transcripts remain in native history. Reports contain private transcripts and environment data, use mode 0600, and stay in ignored `.local/verification/`; do not publish them.

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

A 120-second synthetic run passed 3,352 HTTP submissions, 442 duplicate checks and 23 SQLite/server reopen cycles. Native submission count matched unique requests; event cursors survived restarts. Post-GC heap grew about 3.7 MiB, RSS about 69.4 MiB and active resources stayed at four. This is a bounded load check, not proof of long-term production stability. This historical result is superseded by the longer runs below.

The ten-minute synthetic run passed 16,432 unique submissions, 2,168 duplicate checks and 114 server/SQLite reopen cycles. Native calls matched unique messages. Open file descriptors stayed at 21; post-GC heap grew 4.04 MiB and RSS 89.69 MiB, within the scripted limits. Private report: .local/verification/soak.json. This is not ten minutes of real-model load or a proof against longer-term leaks.

## Post-release acceptance (2026-11-04)

Reproduction and isolation details are in [real-backend acceptance](ACCEPTANCE.md). The local check at that stage on Node 26.12.1 passed 95 AgentHub tests plus 41 retained bridge tests (136 total), with 96.41% lines, 87.46% branches and 93.96% functions. Tarball installation validated all five exports, both CLI binaries, HTTP, SQLite and empty-event cursor recovery. Live tests remain opt-in and are not part of credential-free CI.

| Run                             | Actual backend versions                                                                 | Result                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Managed ACP, current            | Claude ACP 0.100.0 + Claude 2.1.318; Codex ACP 2.5.0 + Codex 0.166.0                    | 7 checks, including real replies, deduplication, isolated history, conversation continuity and descendant exit  |
| Managed ACP, previous           | Same ACP adapters; Claude 2.1.317 and Codex 0.165.0                                     | Same 7 checks passed                                                                                            |
| Independent App Servers         | Codex 0.166.0 and 0.165.0 in separate processes/homes/sockets; Claude 2.1.318 initiator | 7 checks, including native-store isolation, two real MCP round trips and one-backend-exit isolation             |
| Native message matrix, previous | Codex 0.165.0 / Claude 2.1.317                                                          | All 14 checks passed; owned sessions archived/unloaded                                                          |
| Native message matrix, current  | Codex 0.166.0 / Claude 2.1.318                                                          | All 14 checks passed after tightening the test's queued-envelope instructions; owned sessions archived/unloaded |

Private reports: `acp-live-final.json`, `acp-live-previous.json`, `independent-backends.json`, `compat-codex-0165-claude-2317.json` and `compat-codex-0166-claude-2318-gate.json` under `.local/verification/`. Each ACP run uses fresh managed sessions, not a restored live conversation. The version matrix covers the two listed pairs, not every cross-product or provider. Independent servers are local, not remote hosts. Windows and Doubao were not expanded.

The initial current-version matrix failed at a busy Codex reply: native history showed the second envelope once in the same turn, but the model answered the first envelope and finished without a correlated reply to the second. `compat-codex-0166-claude-2318.json` preserves that failure. The test now asks the model to finish all delivered envelopes before its final answer; the gate reminder contains no message ID or payload, so it cannot substitute for native delivery. This was a test-instruction change, not a transport guarantee or automatic message retry. Native acceptance and history evidence still do not prove model processing or a reply.

Earlier ACP/independent-server startup failures are preserved as `acp-live-first.json` and `independent-backends-first.json`: fresh Codex configurations reject `approval_policy="untrusted"`. The new runners use on-request approvals and retain read-only execution. The original close-on-creation-failure behavior was replaced during PR review, as recorded below.

The 30-minute synthetic run passed 49,856 unique HTTP submissions, 6,579 duplicate checks and 347 server/SQLite reopen cycles on macOS arm64 / Node v26.12.1. Native calls matched unique requests and durable event cursors survived reopen. Post-GC heap changed by 4.01 MiB and RSS by 48.55 MiB from the first sample; sampled file descriptors were 21–21, active resources 4–4. All scripted thresholds passed. Private report: `.local/verification/soak-1800.json`. These are synthetic-adapter results, not model throughput or a production reliability guarantee.

The expanded code commit 304ec1a passed all nine [CI jobs](https://github.com/gxcsoccer/AgentHub/actions/runs/41847300219), including Linux/macOS Node 22/24/26, Windows Node 22/24 portable checks and synthetic soak. The uploaded synthetic report was downloaded and checked: Linux x64 / Node 24.22.2, 30 seconds, 816 unique submissions and five reopens. The separate manual soak workflow becomes dispatchable after merge into the default branch; it has not been dispatched from this unmerged PR.

## PR review fixes (2026-11-05)

The regressions reproduced two defects before the fixes: failed ACP creation closed an unrelated session with a pending permission, and equals/variadic launcher options escaped the test restrictions. The updated tests pass. Uncertain creation now blocks only further creation; known sessions can complete permissions, replies and subsequent prompts without restarting the backend. An explicit parameter rejection permits a later creation.

`npm run check` on Node 26.12.1 passed 97 AgentHub, 41 retained bridge and seven launcher/cleanup tests (145 total). Source coverage was 96.43% lines, 87.40% branches and 93.98% functions. `npm run test:package` again verified five exports, both CLIs, HTTP, SQLite and empty-event cursor recovery.

The affected real ACP run passed all seven checks with Claude 2.1.318 / Codex 0.166.0 and the same pinned ACP adapters. Independent backends passed all seven checks with Codex 0.166.0 / 0.165.0 and Claude 2.1.318. Both runs confirmed owned-process cleanup. Reports are private: `review-acp-live.json` and `review-independent-backends.json` under `.local/verification/`. The independent run uses backend credential homes outside model workspaces and observes RPC disconnection before asserting failure isolation. The unchanged 30-minute soak and adjacent-version native matrices were not repeated for these review fixes.

## Review follow-up: cleanup and recovery (2026-11-05)

The local check passed 97 AgentHub, 41 retained bridge and 18 script-safety tests (156 total), with 96.43% line, 87.27% branch and 93.98% function source coverage. The script suite also passed after the final UTF-8 capture and failed-command diagnostic preservation adjustments. New cases cover absent variables in direct child environments, command exit before a TERM-resistant descendant, controller IPC loss, unexpected supervisor loss without stale-group signalling, bounded command capture/failure/timeout, and credential removal after discovery, closure or exit-check failure. The first controller-loss test waited for a `close` event that was not observed despite process exit and closed pipes; verification now checks those actual postconditions directly. This failure remains in the private `review-followup-check-first.log`.

Real ACP passed all seven checks with Claude 2.1.318 / Codex 0.166.0, confirmed descendant exit and reported `credentialsRemoved: true`. Independent native backends passed all seven checks with Claude 2.1.318 and Codex 0.166.0 / 0.165.0 using the new supervisor. Reports: `.local/verification/review-followup-acp-live.json` and `review-followup-independent-backends.json`. Package installation again passed five exports, both CLIs, HTTP, SQLite and empty-event cursor recovery. The full native-version matrix and 30-minute synthetic soak were not repeated: native protocol and load code are unchanged. The compatibility runner's new owned-command wrapper is covered by deterministic command tests, not a new complete native-matrix run.

Final diagnostic follow-up: `npm run check` passed 159 tests (97 AgentHub, 41 bridge, 21 script tests). Three new isolated-process cases verify original command/startup errors and stderr survive a secondary cleanup failure, and cleanup-only failures still reject. The three-second grace period is intentionally retained because command exit alone does not prove descendant shutdown. This change affects error reporting only; real-model acceptance and the long soak were not rerun.
