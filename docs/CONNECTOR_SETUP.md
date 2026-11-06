# Session connectors (0.2.0)

[简体中文](CONNECTOR_SETUP.zh-CN.md) · [Design](AGENT_CONNECTOR.md)

Claude lifecycle enrollment, Codex per-call enrollment and three shared MCP tools are implemented. Models supply a target, body and request handle; Hub derives the source from native identity and applies existing grants. The original seven-tool `agenthub mcp` remains available.

The first Claude configuration loads MCP **at startup**. Existing Claude CLI sessions can choose the CLI transport below: `connect` sends a native message and verifies a handshake executed under existing Bash permissions. Codex App Server uses the same command to install and reload MCP. Reports distinguish activation scope, model execution and permission prerequisites.

## Configuration

Install `npm install -g @gxcsoccer/agenthub@0.2.0`. For a source checkout, run `npm run build` and replace `agenthub` below with `node /ABS/AgentHub/dist/src/cli.js`. Upgrade the Hub and its connector processes together. Replace all example paths. Configuration/token files must be regular files owned by the current user with mode `0600`; use private directories (`0700`).

Generate three distinct random credentials of at least 32 characters for `owner.token`, `agents-api.token` and `enrollment.token`, for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Only the enrollment credential goes to the agent helper.

`hub.json`:

```json
{ "codex": false, "claude": [{ "instance": "local", "nativeMessaging": true }] }
```

`access.json` defines existing caller permissions. This example authorizes all sessions in the instance. Add `sessions: ["UUID"]` to restrict the grant; after `/clear`, a newly generated UUID needs separate owner authorization. Enrollment never expands grants.

```json
{
  "callers": [
    {
      "id": "agents",
      "tokenFile": "agents-api.token",
      "grants": [{ "harness": "claude", "instance": "local", "operations": ["read", "send"] }]
    }
  ]
}
```

`connectors.json` binds enrollment to that restricted caller, never `@owner`:

```json
{
  "profiles": [
    {
      "id": "claude-local",
      "callerId": "agents",
      "harness": "claude",
      "instance": "local",
      "enrollmentTokenFile": "enrollment.token",
      "epoch": 1,
      "enabled": true
    }
  ]
}
```

```sh
agenthub serve --config /ABS/hub.json --access-file /ABS/access.json \
  --connector-file /ABS/connectors.json --token-file /ABS/owner.token
```

`client.json` references only enrollment credentials. Relative token paths resolve against the containing configuration file. The MCP process retains its issued business credential in memory.

```json
{ "url": "http://127.0.0.1:3211", "enrollmentTokenFile": "enrollment.token" }
```

Add the MCP server in Claude's configuration:

```json
{
  "mcpServers": {
    "agenthub": {
      "command": "/ABS/node",
      "args": ["/ABS/AgentHub/dist/src/cli.js", "mcp", "--connector-profile", "/ABS/client.json"]
    }
  }
}
```

Merge lifecycle hooks into Claude settings, preserving existing hooks. `exec` keeps the helper a direct Claude child. Host configuration and tool permissions must be enabled normally; this command does not approve tools.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "exec /ABS/node /ABS/AgentHub/dist/src/cli.js connector-hook --connector-profile /ABS/client.json",
            "timeout": 20
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "exec /ABS/node /ABS/AgentHub/dist/src/cli.js connector-hook --connector-profile /ABS/client.json",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

The helper enrolls when it starts, without a model turn. It keeps retrying while the Hub is unavailable, and retries for up to two minutes until the native directory lists the session. Every session in the install scope therefore binds at startup; use `disconnect` to remove one. If startup binding stops, the first tool call enrolls. After `/clear`, the `SessionStart` hook binds the new UUID if that host's helper is still running and holds an unexpired credential. Otherwise the next tool call does, provided the Hub received that `SessionStart`. Calls recheck native UUID and process identity. Direct parentage, startup `CLAUDE_CODE_SESSION_ID` and the native directory PID must agree. macOS uses `python3 -I` with libproc for microsecond process-start identity; Linux uses `/proc` start ticks, boot ID and effective UID. Linux has deterministic tests only. Real model acceptance covers macOS and Claude 2.1.318. Unsupported or insufficient evidence fails closed.

## Tools and diagnostics

| Tool          | Input                                       | Behavior                                                                                                                    |
| ------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `list_peers`  | None                                        | Authorized addresses, names, state and capabilities; no history                                                             |
| `ask_agent`   | `to`, `message`, optional `deadlineSeconds` | Asynchronous request with generated ID and derived source/return route; default 3600 seconds, maximum 14400                 |
| `reply_agent` | `request`, `message`                        | Only the addressed session may reply; identical replies deduplicate, conflicting replies fail, results cannot be replied to |

Discovery returns `peers` plus `gaps` identifying omitted instances (backend errors, repeated cursors or the ten-page/1,000-session bound). An unavailable instance does not discard other instances. Codex collaboration discovery uses `thread/loaded/list` and reads metadata only for loaded IDs; unloaded and child sessions are excluded. Session-scoped grants read only their allowlisted IDs. Historical session listing remains unchanged, so stored history size does not consume the live peer discovery budget. Aliases query only their harness and require complete discovery across its authorized instances; use a canonical address when a gap prevents unambiguous resolution. Activation verifies the local identity independently of peer discovery.

Targets accept `{harness, instance, sessionId}` or `@claude/name` / `@codex/name`. Names are a one-time lookup; ambiguity fails and submission fixes the native address. Both endpoints need external delivery; missing target reply tools/listeners report unready without implicit attachment.

The acknowledgement includes a request ID and asynchronous waiting guidance. Continue independent work or end the turn; a correlated external result arrives later. Intervening user requests remain separate. Failed requests are never automatically retried; errors include the request ID for owner diagnosis through `agenthub status --message-id UUID`. Another model `ask_agent` call is a new request, not a deduplicated retry.

```sh
agenthub connections --url http://127.0.0.1:3211 --token-file /ABS/owner.token
```

Owner-only diagnostics expose historical bindings and profile switches, never credentials. Bindings are not liveness signals: operations consult native discovery/process identity, with SessionEnd as additional evidence. No lease is implemented.

Bindings, hook evidence and business-token hashes persist in the existing SQLite store. A graceful Hub restart rechecks process identities. Business credentials last at most 24 hours. Enrollment returns `expiresAt`; the helper refreshes its cached credential before the next operation after expiry. An explicit pre-dispatch `credential_expired` response also permits one reenrollment and retry using the same message ID, payload and deadline. Expired credential hashes are retained for a 60-second grace period so an in-flight request can still receive this classification after another registry write. They remain invalid immediately at expiry and count toward the existing 4096-record bound; after grace, writes prune them normally. Revocation, unknown credentials and network uncertainty are not automatically retried. Change profile `epoch` or token and restart Hub to revoke old credentials; changed grants apply after restart; `enabled:false` disables the profile. Each registry category has a 4096-record limit and fails with 429 when full; automatic historical binding/hook collection is pending. Ephemeral mode loses enrollment on restart.

The trust boundary is one OS user, not protection from malicious same-user code. After `/clear`, old requests retain their old UUID return route; failure appears as the original receipt's `forwardError`. Missing valid SessionStart or lagging native discovery fails closed. Failed hooks are not automatically replayed. If the Hub is unreachable, the hook exits 0 and notes it on stderr, so a stopped Hub doesn't show a startup error. The event is lost, and the helper can't recover on its own. After a `/clear` during an outage, tool calls return `identity_pending` until a new `SessionStart` reaches the Hub, for example from another `/clear` or a restarted session. A Hub refusal still exits nonzero. New replies at or after the request deadline return `request_expired` before acceptance or forwarding. An identical reply already accepted on time remains idempotent. Callers can choose a longer request deadline; there is no separate return window.

## Verification

```sh
npm run check
npm run smoke:connector -- --run
```

The opt-in script creates two isolated Claude processes and limits discovery to their exact PIDs and temporary working directories. Current CLI/MCP/hooks load at startup. Only the three test MCP tools are preauthorized; models have no shell/file tools. Reports and terminal logs remain private under ignored `.local/verification/`; owned process groups and temporary configuration are cleaned up. Real models incur usage charges. This does not verify one-command activation of arbitrary existing work sessions, other Claude versions, Windows or Linux live models.

## Codex: install and activate an existing session

Use the same Hub and restricted caller policy. Add a Codex adapter with its explicit instance/socket path, add Codex `read`/`send` grants to the selected caller, and add a distinct enrollment profile/token. The token must differ from owner/API tokens and the Claude enrollment token. `mcpServerName` defaults to `agenthub`.

```json
{
  "profiles": [
    {
      "id": "codex-local",
      "callerId": "agents",
      "harness": "codex",
      "instance": "local",
      "enrollmentTokenFile": "codex-enrollment.token",
      "mcpServerName": "agenthub"
    }
  ]
}
```

Merge that profile with existing profiles. A private `codex-client.json` references its token and the same running Hub:

```json
{
  "url": "http://127.0.0.1:3211",
  "harness": "codex",
  "enrollmentTokenFile": "codex-enrollment.token"
}
```

```sh
agenthub connect --harness codex --instance local --session-id THREAD_UUID \
  --connector-profile /ABS/codex-client.json --wait-ms 30000 \
  --url http://127.0.0.1:3211 --token-file /ABS/owner.token
```

This owner-only command:

1. Verifies a loaded root thread, matching local Hub/profile and existing grants.
2. Reads the target App Server's effective configuration and base user layer. Uses `config/value/write` with the native version for conflict detection; an incompatible existing/overriding entry fails without replacement. Existing matching launch configuration retains its additional settings, including tool permissions. Profile-specific user layers are not selected for writes.
3. Reloads MCP through the native API when needed. **Activation scope is the whole App Server instance**, including its other loaded threads. No sandbox, tool permission or approval configuration is changed.
4. Cross-checks the loaded thread's native MCP inventory, tool names and helper startup identifier. If needed, invokes **only the connector's `list_peers`** through the native MCP API once to complete enrollment. This owner-requested read-only handshake starts no model turn, resumes no session and sends no peer task. It is not a background diagnostic.
5. Returns one JSON report: exit `0` for verified connection and current binding; `2` for incomplete readiness; `1` for a failure such as conflict, missing grants or unsupported activation. `verificationMethod` identifies native read-only verification versus a previously verified binding. Repeating a ready installation preserves configuration and skips reload. Concurrent installs are serialized per adapter; unchanged configuration has a 30-second instance reload cooldown while startup or an earlier reload outcome is uncertain. A subsequent owner connect may retry reload after that interval; it does not run in the background. Target readiness tries each distinct enabled profile server on the instance.

The helper uses request `_meta.threadId`; when `_meta.sessionId` exists it must agree. Direct native MCP calls were observed to supply threadId alone. Model inputs cannot specify the source. Each helper advertises a random connection ID in its MCP version; Hub checks it against the selected instance/thread's native inventory, alongside process PID/start/UID. A stale binding or another connection's ID cannot establish readiness. Native IDs fix result routing; legacy dynamic `agenthub_reply` remains compatible but is not required for this connector route. No `thread/resume` attachment is needed.

Current acceptance covers **macOS, Codex App Server 0.166.0 and Claude 2.1.318**. The Codex fixture was already loaded before installation and had no dynamic reply tool. Both real models initiated requests, replied through the same three tools and consumed the correlated results. Configuration reload was tested on an isolated idle instance, not arbitrary busy desktop/TUI hosts. Tool availability is not a grant to perform future work; normal host policy still applies.

```sh
npm run smoke:connector:codex -- --run
```

This creates an independent App Server/home/socket and fresh Claude PTY, guards native writes by owned thread IDs, archives its Codex thread, stops both owned groups and removes temporary files/copied authentication. The test owner separately authorizes the three fixture tools; `connect` does not do that. Private evidence: `.local/verification/connector-codex-live.json`.

Automatic profile generation/target selection, installer uninstall/disable, manual binding fallback, startup-order recovery and broader host/fault compatibility remain follow-ups. `connections` still reports historical bindings; use the `connect` report for onboarding evidence.

Hosts whose install path can change can set `mcpCommand` on a Codex profile, for example `{ "command": "/ABS/launcher", "args": [] }`. `connect` writes that command instead of the current Node and CLI paths, and compares against it on later connects. It replaces the default command entirely, so the launcher must run `agenthub mcp --connector-profile FILE` itself. Use `exec`, because identity checks require Codex to be the helper's direct parent. The command must be absolute. Changing it changes the profile revision, so sessions connect again. After a host moves, a running helper keeps its old path until its process restarts, and `config/mcpServer/reload` doesn't restart it when the config is unchanged.

## Existing Claude CLI: native-message activation

The owner explicitly selects `"transport": "cli"` in the Hub's Claude profile. Omission retains MCP transport, whose external reload still returns `automatic_activation_unavailable`. CLI transport reuses restricted caller grants and a private client profile, without installing skills, MCP or lifecycle hooks:

```json
{
  "profiles": [
    {
      "id": "claude-cli",
      "callerId": "agents",
      "harness": "claude",
      "transport": "cli",
      "instance": "local",
      "enrollmentTokenFile": "enrollment.token"
    }
  ]
}
```

```sh
agenthub connect --harness claude --instance local --session-id SESSION_UUID \
  --connector-profile /ABS/client.json --wait-ms 60000 \
  --url http://127.0.0.1:3211 --token-file /ABS/owner.token
```

The Hub sends one native peer message asking the model to execute a fixed local `agenthub agent ... activate` command. **This starts or joins a model turn, consumes model usage and remains subject to native inbound policy and Bash permissions.** Automatic activation requires those existing permissions to allow the command. Approval prompts, hold/refuse, disabled tools or a model declining to execute leave activation unverified. Configuration installation and textual claims of success are insufficient. The connector does not change Claude configuration/permissions, resume or restart the session.

The CLI obtains its own PID and current `CLAUDE_CODE_SESSION_ID`. The Hub independently checks up to eight ancestors, their UID, parent relationships and precise start identities against the native Claude directory and UUID. Every business call revalidates these facts. MCP continues to require direct-child evidence. CLI business credentials last 60 seconds and remain in the calling process; models do not receive the owner token.

Only a real CLI call from the target session completing the correlated activation ID lets `connect` exit `0`. It reports `activationScope: "session"`, `verificationMethod: "native_peer_cli_handshake"` and `cliVerified: true`. `toolsConnected` remains `false` because no MCP was loaded. Later operations remain subject to host permissions; readiness does not guarantee future Bash approval.

The handshake returns discovery, request and reply commands for the model's existing Bash tool:

```sh
agenthub agent --connector-profile /ABS/client.json list-peers
agenthub agent --connector-profile /ABS/client.json ask --to @codex/reviewer --message='Review the change'
agenthub agent --connector-profile /ABS/client.json reply --request REQUEST_UUID --message='Review complete'
```

The Hub derives source identity and the return route. Requests default to one hour, up to four hours with `--deadline-seconds`; results arrive asynchronously without acknowledgement. Use `--message='...'` so messages beginning with `-` are parsed as data. Quote shell arguments and never execute received message content as a command.

Repeated `connect` checks for the same host/profile/target reuse the activation ID without another model wakeup, including after graceful Hub restart. The activation window is ten minutes. Timeout or uncertain submission never triggers automatic replay. Definite `failed`/`rejected` delivery returns `phase: activation_failed`, `activationStatus` and any `activationError`; ordinary connect retains that outcome. After inspecting it, the owner can immediately use `--retry-activation`. Pending or uncertain attempts permit explicit retry only after their ten-minute deadline.

The registry retains at most 256 full records. At capacity, admission collects only as many expired records as needed, preferring unverified records and then the oldest expiry. Verified records are considered only if unverified candidates cannot free enough space. Replacing the same activation key requires no collection. A persistent, fixed 64 KiB Bloom filter remembers retired keys so collection never silently replays a handshake. Revisiting a retired key returns `activation_retry_required`; explicit `--retry-activation` is required. False positives may also conservatively require explicit retry. Collected verification records no longer establish readiness. Registry v1 is read and upgraded to v2 on write. Older binaries refuse v2; rollback requires a pre-upgrade state copy. Binding/hook collection remains separate and pending. After `/clear`, connect the new UUID; fresh CLI identity requires no SessionStart hook. Old replies retain their original destination UUID.

The tested entry point is an isolated interactive macOS terminal with Claude CLI 2.1.318. The test owner preauthorized the precise CLI command; this does not prove permission-free activation in arbitrary working sessions, desktop/SDK hosts or other platforms. See [verification](VERIFICATION.md):

```sh
npm run smoke:connector:cli -- --run
npm run smoke:connector:codex -- --run --claude-cli
```

## Disconnect

```sh
agenthub disconnect --harness codex --session-id ID
agenthub reconnect --harness codex --session-id ID
```

`disconnect` is owner-only and takes effect for later operations without a Hub restart. Library and HTTP callers can target one session (`{ address }`) or one connector profile (`{ profileId }`), and the result reports how many bindings, credentials and lifecycle records were removed. The decision persists across restarts because a session could otherwise bind itself again on its next tool call.

| Target          | New sessions                      | While disconnected                                                           |
| --------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `{ address }`   | Unaffected                        | That session's tools fail, and a canonical address gets `peer_not_connected` |
| `{ profileId }` | Refused with `connector_disabled` | Every session of that profile fails                                          |

`reconnect` takes the same target and reverses it without a handshake. The session enrolls again on its next tool call, including an MCP Claude session that `connect` can't activate. `changed` is false when nothing was disconnected. Owner `connect` also reverses a session disconnect and a disconnect of the profile matching its credential; if it throws, the disconnect is restored. Disconnect records aren't evicted: at 4096 records, a new `{ address }` disconnect is refused with `connector_capacity` until the owner reconnects older ones or disconnects the profile.

Native MCP and hook configuration is not changed, and requests already accepted by a target are not cancelled. Delivery is checked again at the last moment, so a request or forwarded result that hasn't reached the target yet is refused. A disconnected session isn't listed, so asking for it by name reports a missing or ambiguous peer.

With the `ConnectorService` option `connectedPeersOnly`, off by default, only sessions with a binding from a current, enabled profile can be listed or asked. Bindings are still not liveness signals.

If the Hub is unavailable, `reply_agent` retries for up to 25 seconds with the same text, then returns an error containing the request ID. The Hub accepts a replay of identical text as a duplicate. A reply can still be lost in a longer outage if the agent doesn't retry. `ask_agent` is never retried.

## Codex reply fallback

A plain Codex session may print its answer without calling `reply_agent`, which leaves the requester waiting. Embedders can opt in with `new CodexAdapter({ replyFallback: true })`. It is off by default because `replied` otherwise means an explicit reply.

When a request's turn ends, the adapter reads that turn:

- If the turn starts with the request, contains no other input, and has exactly one final answer, that answer becomes the reply. Only item types a model produces itself are allowed after the request, so an unknown item counts as another input. `reply.metadata.source` is `turn_final_message`, and the forwarded result's origin name says the text came from a final answer.
- Otherwise no text is sent, because a merged turn can contain the user's own work. The receipt gets `noReply: { reason, at }`, and a later real reply clears it. Reasons are `merged_turn`, `reply_call_failed`, `no_single_answer`, `turn_interrupted` and `turn_failed`.

A returned answer isn't always an answer to the request: in real testing, a Codex session that declined an instruction from its peer had that refusal returned as the reply. `reply.metadata.source` shows when this happened.

`noReply` is visible to the owner only. The requesting agent isn't notified yet, so a busy target can leave it waiting until the deadline. This was checked against turn shapes from Codex 0.166.0.
