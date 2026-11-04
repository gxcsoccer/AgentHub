# Real-backend acceptance

[简体中文](ACCEPTANCE.zh-CN.md)

These opt-in scripts consume model quota. They create their own sessions and processes and never attach to working sessions. Run from a source checkout after `npm ci` and `npm run build`. Reports and logs stay private in ignored `.local/verification/`; publish only the summaries in the verification documentation.

## Managed ACP

Install the pinned upstream adapters in an ignored directory; they are not AgentHub production dependencies:

```sh
npm install --prefix .local/acceptance/runtime --save-exact --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org @agentclientprotocol/claude-agent-acp@0.100.0 @agentclientprotocol/codex-acp@2.5.0
npm run smoke:acp -- --run
```

The real Claude and Codex executables must already be authenticated. Override `AGENTHUB_TEST_CLAUDE`, `AGENTHUB_TEST_CODEX`, `AGENTHUB_TEST_ACP_RUNTIME`, or `AGENTHUB_TEST_REPORT` to select explicit executable paths, the install root, or a private report path. The script checks adapter versions before starting work. Sources: [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp), [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp).

Each backend creates two managed sessions. HTTP prompts obtain a unique exact token from the actual model; repeating the message ID does not extend history; the other session has no matching history; a new prompt in the first session recalls its token. Ordinary send cannot promote the message to user input. Cleanup checks owned descendants have exited. This does not establish live attach, persisted native-history recovery, all permission types or real-model cancellation behavior; deterministic fixtures cover timeout and cancellation separately.

For this test, a transparent executable shim removes Claude's model tools, configured MCP servers and user hooks while preserving SDK stream transport and authentication. It does not mock model output. Codex runs with a private temporary home, file authentication copied from the owner's `CODEX_HOME/auth.json`, and read-only mode with execution networking disabled. Only that credential file is copied, never working-session storage or user configuration. Credentials stay in a sibling backend home outside the model workspace. The copied Codex home is removed in a cleanup finally block, including when descendant discovery, backend closure or exit confirmation fails. A failed run may retain its workspace/logs and records that directory, but not its copied credentials. Credential-removal errors also fail the run explicitly. File authentication is a prerequisite; the script does not extract keychain credentials or initiate login.

The shim handles both `--flag value` and `--flag=value`, removes all values of repeated/variadic controlled options and rejects a `--` separator that would bypass appended restrictions. Session-routing variables, including `CODEX_THREAD_ID`, are removed for direct spawns; ACP uses explicit empty overrides because its launcher merges the parent environment. Cleanup never signals historical PID records. Native test servers and compatibility runners use an owned supervisor that keeps the process group reserved after the command exits. Shutdown sends TERM, waits the grace period, then kills the group while the supervisor is still live and waits for its pipes to close. Controller IPC loss triggers group cleanup. Unexpected supervisor loss fails cleanup without signalling its old group ID. This covers processes remaining in that group, not descendants that deliberately create a new session/group. ACP descendant snapshots remain observation-only. These guards have credential-free regression tests in `npm run test:scripts`.

## Independent native backends

```sh
npm run smoke:claude-initiated -- --run
```

This now starts two App Servers with separate PIDs, sockets and temporary homes. A real Claude model calls AgentHub's restricted MCP tools to send to both and retrieve correlated replies. Native cross-server reads fail; history/search and caller grants remain isolated. Stopping one owned backend does not break the other. `AGENTHUB_TEST_CODEX_ALPHA` and `AGENTHUB_TEST_CODEX_BETA` can select different executables; `AGENTHUB_TEST_CLAUDE` selects the caller and `AGENTHUB_TEST_REPORT` selects its private report. Backend homes are siblings of model workspaces. The failure check waits for RPC disconnection rather than a fixed delay. This is independent local-process acceptance, not remote networking, remote authentication, or a multi-host deployment.

## Native version matrix

Prepare a private JSON array naming installed executable paths:

```json
[
  { "name": "current", "codex": "/absolute/path/to/codex", "claude": "/absolute/path/to/claude" },
  {
    "name": "previous",
    "codex": "/absolute/path/to/older-codex",
    "claude": "/absolute/path/to/older-claude"
  }
]
```

```sh
npm run smoke:compatibility -- --run --config /absolute/path/to/matrix.json
```

Each row starts its own App Server and runs the native message fault matrix: idle/busy, hold/refuse, duplicates/conflicts, delayed replies, disconnect, history identity and owned-session cleanup. Selecting a binary does not bypass AgentHub's version gate. An unvalidated version must fail. The tested Claude allowlist remains explicit; installed-CLI checks cannot establish every running process's version. Metadata and native submission evidence use `installedCliVersion`, `versionSource: installed_cli_cached` and `processVersionVerified: false`; `cliVersion` remains a compatibility alias for the installed version.

## Sustained synthetic load

```sh
node --expose-gc scripts/soak.mjs --seconds 1800 --report .local/verification/soak-1800.json
```

The bounded run exercises actual HTTP/SSE/SQLite with a synthetic owned adapter, eight concurrent submissions and four consumer connections per batch, periodic server/storage reopening, deduplication, cursor continuity and resource thresholds. It is not a real-model load test or proof of production stability. Duration is validated as an integer between 5 and 3600 seconds. The separate **Extended synthetic soak** workflow can be dispatched manually after it is merged into the default branch; only its synthetic report is uploaded, never model transcripts or credentials.

Windows work and Doubao runtime integration remain outside this acceptance expansion.
