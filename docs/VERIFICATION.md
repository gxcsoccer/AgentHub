# Verification

## 0.4.3 release checks (2026-11-06)

PR #15 is merged. With the package and OpenAPI version set to 0.4.3, `npm run check` passes **280 tests** (211 core, 41 retained bridge, 28 script checks); coverage is **96.97% lines / 88.47% branches / 94.83% functions**. `npm run test:package` passes.

`npm run smoke:connector -- --run` passed 10 of 10 with Claude Code pinned to 2.1.318. The same run failed with 2.1.319, which auto-updated on this machine that day: `ask_agent` returned `Peer name is missing or ambiguous`. 2.1.319 isn't in the validated version list, so that session doesn't offer `peer_message` by default. The startup binding checks had passed. 2.1.319 isn't validated.

The startup screen wasn't checked in a real Claude session with a stopped Hub.

## 0.4.2 release checks (2026-11-06)

PR #13 is merged. With the package and OpenAPI version set to 0.4.2, `npm run check` passes **279 tests** (210 core, 41 retained bridge, 28 script checks); coverage is **97.01% lines / 88.75% branches / 94.82% functions**. `npm run test:package` passes.

At `f5f9aac`, `npm run smoke:connector -- --run` passed 10 of 10 checks with Claude Code 2.1.318 on macOS. Two real interactive sessions were bound before any tool call, and a session was bound to its new UUID after `/clear`, again before any tool call. The run used `--strict-mcp-config`.

A Hub that starts after the session, and a slow native directory, have only fake-fetch coverage. A session that resumes, MCP servers loaded without `--strict-mcp-config`, and `/clear` after the helper's 24-hour credential expires weren't tested. In the last case, the code leaves the new UUID unbound until the next tool call.

## 0.4.1 release checks (2026-11-06)

PR #11 is merged. With the package and OpenAPI version set to 0.4.1, `npm run check` passes **276 tests** (207 core, 41 retained bridge, 28 script checks); coverage is **96.56% lines / 88.50% branches / 94.74% functions**. `npm run test:package` passes.

A real Codex 0.166.0 TUI run in an isolated home used a data-directory launcher that starts Node with `exec`, at `c9b1292`. `connect` reached `ready`, the config held the launcher and no app path, and `list_peers` completed with identity verified. After renaming the app directory and rewriting only the launcher, the config was byte-identical, `connect` stayed `ready` with `changed: false`, and a new thread's helper ran from the new path.

That run used non-empty args, so the omitted-args fix in `144f598` has only fake-RPC and real CLI-config coverage. A launcher during a busy instance or a Hub outage wasn't tested.

## 0.4.0 release checks (2026-11-06)

PR #9 is merged. With the package and OpenAPI version set to 0.4.0, `npm run check` passes **274 tests** (205 core, 41 retained bridge, 28 script checks); coverage is **96.88% lines / 88.53% branches / 94.72% functions**. `npm run test:package` passes fresh installation, five exports, both binaries, HTTP/SQLite and the installed setup CLI.

Real runs used isolated homes with Codex 0.166.0 TUI and Claude 2.1.318. The last code change, `60e0ff3`, passed: session and profile disconnect and reconnect, enrollment of a new session during a session disconnect, solo-turn fallback, merged-turn `noReply` without leaking user work, and forwarded results after a Hub SIGKILL (2 of 2, Claude to Claude). `4700953` passed a reply retried through an 11.8-second outage with one model call, and `gap: true`. A real `reply_agent` call succeeded in a plain TUI.

Not verified: `reply_call_failed`, whether `turn/completed` reaches this connection (polling covers it), Codex as requester across a Hub restart, and `fileChange`, `webSearch` and `plan` items in a fallback turn. The 25-second retry window is an estimate. Plain TUI task handling was inconsistent, as recorded in the [roadmap](ROADMAP.md). Early refusal runs were contaminated by a test prompt that said `Use no tools`. No working sessions were contacted.

## 0.3.0 release checks (2026-11-05)

PR #3 is merged. With the package and OpenAPI version set to 0.3.0, `npm run check` passes **250 tests** (181 core, 41 retained bridge, 28 script checks); coverage is **96.66% lines / 88.11% branches / 94.52% functions**. CLI, MCP and connector version metadata follow the package manifest. The release adds unified setup and experimental Doubao host registration without changing the core SQLite schema from 0.2.0.

`npm run test:package` passes fresh installation, five exports, both binaries, HTTP/SQLite and the installed setup CLI. Real Doubao acceptance was performed at `9c37af1` before the recovery/reporting fixes; the 17 host/backend checks and five API lifecycle checks below were not rerun for the version bump. This release verification uses local fixtures and isolated package installation, with no working sessions contacted. Private reports are under `.local/verification/release-0.3.0-*`.

## PR #3 cleanup reporting and target discovery (2026-11-05)

`npm run check` passes **250 tests** (181 core, 41 retained bridge, 28 script checks); coverage is **97.08% lines / 88.37% branches / 94.52% functions**. Five new process tests exercise the compiled `setup targets` CLI against an isolated Claude executable and Codex WebSocket/Unix-socket fixture: discovery, both pagination paths, empty results, malformed responses/cursors, invalid harnesses and unavailable backends. They verify read-only calls, connection closure and absence of generated configuration or state. Existing uninstall tests now assert all four Doubao cleanup states, separately unchecked native configuration and repeat-uninstall consistency, including compiled CLI output after verified host removal.

`npm run test:package` also passes fresh installation, exports, binaries, HTTP/SQLite and installed setup CLI checks. These are local CLI/fixture checks. No real harness sessions or Doubao UI were contacted; the earlier real host evidence remains at `9c37af1`. Private logs are under `.local/verification/pr3-followups-*`.

## PR #3 recovery fixes (2026-11-05)

`npm run check` passes **245 tests** (176 core, 41 retained bridge, 28 script checks); coverage is **96.30% lines / 87.58% branches / 94.12% functions**. All ten new regression tests failed before the fix and pass afterward. They cover UUID validation before file creation; cleanup with unrelated 401/HTML/non-Hub JSON services; explicit unknown ownership for a hung port with credential preservation; offline cleanup before creation; and exact-name `host-forget` after rejected creation, a lost response, manual entry deletion or a host upgrade.

The host error cases use a fake API; port cases use local HTTP servers, and recovery exercises the compiled CLI in separate processes. These checks do not rerun the real Doubao/model acceptance below, which was completed at the earlier PR head `9c37af1`. No working sessions were contacted during the fixes. The package-installation check also passes with the updated CLI. Private logs remain under `.local/verification/pr3-fix-*`.

## Doubao host and unified setup (2026-11-05, development branch)

`npm run check` passes **235 tests** (166 core, 41 retained bridge, 28 script checks). Coverage: **96.56% lines / 87.34% branches / 94.08% functions**. Package installation also checks the installed setup CLI. New process tests cover the generated MCP launcher, disable/restart, owned SIGKILL recovery, refusal to control a legacy daemon, private-file checks and preservation of edited/user files. Host API tests cover unique registration, lost-create recovery without duplication, uncertain-outcome retention and removal verification.

Actual macOS **Doubao Work 2.35.15** host acceptance passed **17 checks**: the 15 isolated backend/MCP checks plus two fixed requests sent by Doubao and matching Claude/Codex replies visibly displayed in the test conversation. The host also displayed duplicate-request results; backend deduplication has independent store assertions. Loading used **插件 · 技能 · 伙伴 → 添加 → 新建自定义连接器 → STDIO**. The temporary connector was removed through the UI; owned Claude/Codex processes, test thread and temporary credentials were cleaned. Native versions: Claude **2.1.318**, Codex **0.166.0**. Private evidence: `.local/verification/doubao-host-live.json` and excluded UI screenshots.

A separate production `setup host-*` CLI run passed **five live API checks**: create and exact launcher readback; repeated installation reusing the ID; disabled/enabled readback; removal preserving all prior local connector IDs; generated setup uninstall. Private report: `.local/verification/doubao-host-api-live.json`. The experiment was informed by [dbtrace's earlier connector research](https://github.com/gxcsoccer/dbtrace/blob/main/docs/research/doubao/mcp-connector.md). Current behavior required observed desktop device context for listing and **`connector/disconnect` for removal**. The old generic delete route returned success without removing this entry; it is not used. Cookies and authentication query values are not exported or persisted by the implementation.

These are separate acceptance scopes: the API lifecycle run does not prove a model tool call, and registration returns `hostLoadingVerified: false`. Busy host/user interleaving, actual host disconnect/recovery, proactive wake-up, native Doubao conversation identity and other platforms remain unverified or unimplemented. Manual native Claude/Codex MCP configuration cleanup remains outside generated-file uninstall. The older CLI-only run passed 13 checks and direct MCP-only run 15; neither alone establishes host acceptance. See [setup and reproduction](DOUBAO.md).

## 0.2.0 release verification (2026-11-05)

The exact verified 0.2.0 tarball was published to npm, its registry integrity matched, and a fresh tarball installation passed CLI help verification. The [GitHub release](https://github.com/gxcsoccer/AgentHub/releases/tag/v0.2.0) is public. These development-branch setup/Doubao changes are not part of 0.2.0.

`npm run check` passes 215 tests (151 unified, 41 retained Codex Bridge, 23 runner-safety); coverage is 96.99% lines, 88.83% branches and 94.93% functions. Package installation verifies five exports, both binaries, version metadata, HTTP, SQLite and empty event cursor recovery. The 0.2.0 Codex MCP / Claude CLI isolated run passes all eight checks, including both request/reply/result directions, loaded peer discovery and cleanup. Native versions remain macOS Codex 0.166.0 / Claude 2.1.318. No working sessions are used. Private reports are kept under ignored `.local/verification/release-0.2.0-*`.

## 2026-11-05: Claude CLI activation and mixed transports (0.2.0)

`npm run check` passed **130 main-project + 41 Bridge + 21 test-process safety checks: 192 total**, with **96.95% / 88.10% / 94.99%** main-project line/branch/function coverage. `npm run test:package` passed temporary installation, exports, CLIs, HTTP and SQLite checks. New contracts cover process ancestry/start identity, UUID changes, credential separation/revocation, activation correlation, text replies not establishing readiness, expiry/explicit retry, discovery failure not committing readiness, and restricted CLI entry points with inferred origins.

`smoke:connector:cli -- --run` passed **ten live checks** on macOS + Claude Code 2.1.318. Three fresh PTYs were used: two were activated through the production owner CLI after startup and an ordinary model turn; a third lacked Bash and remained unverified despite native receipt/reply, with no resend on repeated connect. Positive cases cover both Claude initiators, request/reply/result, durable activation/bindings across graceful Hub restart, an independent user turn before the correlated result, reconnecting a new UUID after clear, old in-flight reply isolation, and results without business replies.

`smoke:connector:codex -- --run --claude-cli` passed **seven further live checks**, using Codex App Server 0.166.0 and Claude 2.1.318: MCP installation/read-only enrollment into an existing Codex root, native CLI activation of an existing Claude session, real MCP metadata, idempotent onboarding preserving permissions, both cross-harness request/reply/result directions, and result termination. Codex activation itself used no model turn; Claude activation did. Neither thread/resume nor native dynamic reply tools were used.

The test owner preauthorized the precise CLI command for the two successful targets. Runtime connect installed no skills/MCP/hooks and changed no host permissions. The production Hub independently verified ancestry/native discovery instead of trusting caller-supplied ancestors. A preliminary three-check probe verified triggering without a skills directory and fresh environment identity after clear; it is not counted as production acceptance.

Failed attempts are retained: an initial probe command containing shell environment expansion was denied by existing Bash rules. The first production run quoted every safe path and was also denied by the fixture rule; connect did not return success. Rendering now quotes arguments only when shell syntax requires it. Fresh isolated runs passed without broadening permissions. This establishes only the tested commands/rules, not other permission combinations.

Private 0600 reports: `.local/verification/connector-claude-cli-live.json` and `connector-codex-claude-cli-live.json`; failed evidence: `claude-cli-activation-spike.json` and `connector-claude-cli-quoted-command-live.json`, with adjacent terminal logs. All three Claude fixture groups and the mixed test's Claude/App Server stopped; the Codex thread was archived, temporary directories/copied authentication removed. Working sessions were untouched. Do not publish private evidence.

Scope: this is model-driven activation explicitly enabled with `transport: cli`, subject to existing permissions, not Claude external MCP reload or a guarantee of permission-free access. The independent user turn finishes before result arrival; graceful restart does not prove forced-crash recovery. Real busy activation, full concurrency/deadline matrices, queued-before-clear, Linux/Windows/desktop/SDK remain unaccepted. Connector registry version 3 reads versions 1/2; activation metadata has version 1, while core message storage remains schema 3. Activation records are bounded at 256; automatic collection is pending. See [setup](CONNECTOR_SETUP.md).

## 2026-11-05: Codex connector and unified connect (partial phase 3, 0.2.0)

`npm run check` passed 124 main-project tests, 41 Bridge tests and 21 test-process safety checks: **186 total**, with **96.80% / 88.17% / 94.80%** main-project line/branch/function coverage. New coverage includes per-call identity and connection nonce verification, concurrent identities in one MCP process, configuration version conflicts, repeated onboarding, the read-only handshake and rejection of historical bindings as current readiness. `npm run test:package` passed temporary package installation, public exports, CLIs, HTTP and SQLite recovery.

`npm run smoke:connector:codex -- --run` passed **six live checks** on macOS, Codex App Server 0.166.0 and Claude Code 2.1.318:

1. Production `agenthub connect` installed configuration, reloaded MCP, enrolled identity and returned ready for an idle Codex root created before MCP installation, without starting a model turn.
2. A subsequent real Codex MCP call verified host metadata and the connection nonce; discovery correctly reported the current session's connector reply readiness.
3. Repeated connect skipped reload and preserved existing tool permissions.
4. Claude initiated a request, Codex used `reply_agent`, and Claude actually read the correlated result.
5. Codex initiated a request, Claude replied, and Codex actually read the correlated result.
6. Results received no business replies. No native dynamic reply tool was registered and no `thread/resume` call occurred.

The first owner handshake uses native `mcpServer/tool/call`, which injects `threadId`. Model calls also include `sessionId`; it must match when present. Both routes verify the native MCP connection nonce in the configured instance. Discovery reports connector readiness for the just-verified source; other configured Codex peers are checked on `ask_agent`, avoiding misleading legacy dynamic-tool status.

The runner used only an independent App Server/home/socket and a fresh Claude PTY with its connector loaded at startup. The test owner separately authorized the three fixture tools; the installer preserved permissions. Cleanup archived the Codex thread, stopped both process groups and removed temporary state/copied authentication. Private evidence is ignored at `.local/verification/connector-codex-live.json`; do not publish it.

This covers idle roots and the listed versions, not busy Codex reload, CLI/TUI/desktop entry points, other platforms or external automatic activation of arbitrary existing Claude sessions. Reload affects the entire App Server instance. Owners must still prepare connector profiles and caller grants; automatic profile generation, uninstall and full readiness diagnostics remain pending. See [setup](CONNECTOR_SETUP.md).

## 2026-11-05: Claude connector core (phase 2, 0.2.0)

`npm run check` passed 119 main-project tests, 41 Bridge tests and 21 test-process safety checks: **181 total**. Main-project line/branch/function coverage is **96.96% / 88.84% / 94.55%**. New coverage includes process identity, credential separation, SQLite reopen, native-directory changes, pagination/capacity limits, ambiguous names, revocation, cross-session reply rejection, CLI configuration and the official MCP client roundtrip.

`npm run test:package` also passed: pack/install in a temporary directory, connector public exports, both CLIs, HTTP and SQLite recovery. The package excluded private reports and test files.

`npm run smoke:connector -- --run` passed **nine live checks** on macOS + Claude 2.1.318: two native Claude MCP processes enrolled; actual ask/reply/result roundtrip; graceful Hub restart retained bindings and live process credentials; the second Claude initiated a request; an intervening independent user turn completed before its correlated result; real SessionStart refreshed identity after `/clear`; an old in-flight reply did not follow the new UUID; the new UUID completed another roundtrip; results produced no business replies.

Models were authorized only for the three test MCP tools, with no shell/file tools. Production CLI/hooks loaded at startup; the Hub discovered only the two owned PIDs/cwds. The final report confirms both process groups stopped and temporary configuration/state directories were removed. Private ignored evidence is `connector-claude-live.json` and adjacent terminal logs; do not publish it. The initial runner failed to normalize macOS `/tmp` versus `/private/tmp`; the corrected runner passed. The failed attempt remains `connector-claude-live-path-failure.json`.

This is not external automatic activation of arbitrary existing sessions. The user-turn case completes before result delivery, not every busy interleaving. Restart was graceful, not connector SIGKILL acceptance. Linux has process-reader fixtures only. Other hosts/platforms, queued-before-clear, real PID reuse and the complete concurrency/deadline matrix remain pending. See [configuration and limits](CONNECTOR_SETUP.md).

## 2026-11-05: connector phase 1 (0.2.0)

At phase-1 acceptance, feat/agent-connector implemented messageKind, result rendering in both adapters, ingress/core guards and schema 3 compatibility. Automatic enrollment, minimal tools and connect were unimplemented at that point; see phase 2 above for subsequent work. This section covers the new implementation; historical evidence below retains its original scope.

- npm run check passed 103 main-project tests, 41 retained Bridge tests and 21 test-process safety checks: 165 total. Main-project line/branch/function coverage is 96.48% / 87.85% / 93.98%. Coverage includes legacy payload idempotency, HTTP/MCP propagation, forced reply rejection, persistence and recovery guards.
- macOS, Claude 2.1.318 and Codex 0.166.0, with a separate App Server and newly created allowlisted sessions. The updated smoke:isolated passed seven checks. Both real models emitted an observation marker containing the new result ID and body, without a business reply on the result receipt.
- smoke:recovery passed seven checks: explicit busy-session reattachment, late replies and one forward after Hub SIGKILL, durable SSE cursors and another restart. Real Codex output confirms the result was read while its receipt remains accepted without another business reply.
- The first recovery run failed before result acceptance: an old assertion expected a cursor to expire on restart, conflicting with the existing schema 2 durable-event contract. After correcting it to replay through ready without a gap, a fresh isolated run passed. The failed attempt remains recorded and is not counted as a pass.

Private 0600 reports: .local/verification/connector-isolated.json and connector-recovery.json; the failed attempt is connector-recovery-stale-assertion.json. Test processes exited, owned threads were archived/unloaded, and temporary App Servers/copied test authentication were removed. Working sessions were untouched. This does not cover automatic enrollment, Claude automatic activation or two-Claude autonomous collaboration.

Schema 3 upgrades older stores and older binaries refuse it; rollback requires a pre-upgrade copy. Verification used temporary databases and did not upgrade a working Hub's state.

[简体中文](VERIFICATION.zh-CN.md)

## Automated checks

```sh
npm ci
npm run check
```

The pre-connector baseline contains 97 AgentHub tests, the 41 original Codex Session Bridge tests and 21 live-runner safety tests: 159 tests on Linux/macOS. Current local results are recorded in the phase sections above. The root check also runs formatting, strict TypeScript checks and coverage thresholds. The imported bridge is tested from its own directory, preserving its original fixtures and contract.

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

## Connector PR review corrections (2026-11-05)

The review regressions cover all nine findings: unrelated oversized/offline instances produce discovery gaps without blocking a Claude alias or activation; incomplete same-harness discovery still rejects ambiguous aliases; new late replies fail before acceptance; dash-prefixed CLI messages pass through ask/reply; failed/rejected activation is visible and explicitly retryable while unknown delivery stays reserved; expired activation collection preserves bounded replay protection; credential refresh preserves the original ID/deadline and never retries uncertainty; Codex target checks consider multiple profiles; repeated/concurrent installs avoid reload storms; and one CLI enrollment plus canonical ask uses three native listings with a fresh pre-send check. Legacy activation records upgrade from v1 to v2, including conservative behavior when the replay filter is saturated.

`npm run check` passed 208 tests (144 AgentHub, 41 retained bridge, 23 runner safety). Source coverage: 96.97% lines, 88.75% branches, 94.83% functions. Package installation passed five exports, both CLIs, HTTP, SQLite and event-cursor recovery. Large-directory, expired-credential, capacity, multi-profile and reload-cooldown cases use deterministic fixtures; their native latency/scale impact is not measured.

Real isolated macOS acceptance passed Claude CLI's ten checks (Claude 2.1.318), including unavailable Bash, restart, intervening user turns and clear isolation, plus seven bidirectional Claude CLI / Codex MCP checks (Codex 0.166.0). Owned process exit, thread archive and temporary/authentication cleanup were confirmed. Private reports: `.local/verification/pr2-fix-connector-claude-cli-live.json` and `pr2-fix-connector-codex-claude-cli-live.json`.

The first cross-harness attempt stopped on an early empty Codex `thread/read` turn marked `interrupted` with no completion time, before a model tool call. The runner previously treated any non-inProgress snapshot as final. It now observes the matching native `turn/completed` notification before reading completed history, handles notifications arriving before the start response, and fails on real interruption/timeout without resubmitting. Two new runner tests cover this race and listener cleanup. The failed attempt and its successful owned-resource cleanup remain in private `pr2-fix-first-connector-codex-claude-cli-live.json`; the fresh run passed all seven checks. Windows, the adjacent-version matrix and the long synthetic soak were not rerun for these connector corrections.

## Connector follow-up closeout (2026-11-05)

All three non-blocking follow-ups are addressed. Codex peer discovery now pages the loaded inventory while preserving normal historical listing and session-scoped read grants. A read-only pre-fix sample had 99 notLoaded threads among the first 100 history results and one loaded thread; this is a sample, not a total-history count. Tests use 1,100 historical threads plus paginated loaded roots, a child and an unloading race to verify discovery and alias routing without a history scan.

Activation collection now prefers unverified expired records, removes only enough records for admission, and skips collection when replacing the same key. Tests preserve existing verified readiness and replay protection. Credential records retain a 60-second expiry-classification grace period; an HTTP test advances the clock across expiry while another enrollment writes the registry, then verifies one refresh, unchanged message ID/deadline and exactly one submission. Expired credentials remain invalid, owner revocation takes precedence, and records are pruned at the grace boundary. Six regression assertions failed before the fixes and passed afterward.

`npm run check` passed 214 tests (150 AgentHub, 41 retained bridge, 23 runner safety), with 96.99% line, 88.82% branch and 94.93% function source coverage. Package installation again passed five exports, both CLIs, HTTP, SQLite and event-cursor recovery. Fresh macOS Claude 2.1.318 / Codex 0.166.0 isolated acceptance passed eight checks, adding native loaded-peer discovery to the existing two-way CLI/MCP round trip. Owned processes stopped, the owned thread was archived, and temporary files/copied authentication were removed. Private report: `.local/verification/pr2-closeout-connector-codex-claude-cli-live.json`. Large-directory and capacity boundaries remain deterministic fixture coverage; the separate ten-check Claude-only run, adjacent-version matrix, Windows live integration and long soak were not repeated.
