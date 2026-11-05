# AgentHub

One API across coding harnesses. A TypeScript library and local service for communicating with existing Codex and Claude Code sessions.

[简体中文](README.zh-CN.md) · [API](docs/API.md) · [Design](docs/DESIGN.md) · [Verification](docs/VERIFICATION.md) · [Doubao integration](docs/DOUBAO.md) · [Roadmap](docs/ROADMAP.md)

Next design: [Automatic agent connections and minimal-awareness collaboration](docs/AGENT_CONNECTOR.md) (production kit not implemented; isolated prototypes cover [native identity](docs/SESSION_IDENTITY_EXPERIMENT.md), [bidirectional communication](docs/CONNECTOR_ROUNDTRIP_EXPERIMENT.md) and [installation/lifecycle](docs/CONNECTOR_LIFECYCLE_EXPERIMENT.md)).

## Current capabilities

| Capability                        | Codex                                             | Claude Code                                                         |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| Discovery                         | Persisted sessions; native search                 | Running sessions via `claude agents --json`; metadata search        |
| History                           | Native item pagination                            | Local transcript pagination/search, including busy peer attachments |
| External messages                 | `turn/start.toolOutput`                           | Native inbox, experimental opt-in for CLI 2.1.317 / 2.1.318         |
| Correlated replies                | Owner-registered `agenthub_reply` tool            | Native `SendMessage` to Hub callback socket                         |
| Approval responses                | Explicit library/HTTP owner response              | Unsupported by this live adapter                                    |
| Arbitrary live event subscription | Unsupported; requires an existing native listener | Unsupported; own callbacks only                                     |

Messages retain native semantics: `tool_output` and `peer_message`. The common API never falls back to user input. It never starts, resumes, restarts, or interrupts a session implicitly. Claude's inbound accept/hold/refuse policy remains in control.

The original Codex Session Bridge is retained under `vendor/codex-bridge`, with its 22-operation HTTP/SSE API, fetch SDK, OpenAPI, tests and MIT license. Its native lifecycle and user-input operations are available separately through the `codex-session-bridge` executable and `@gxcsoccer/agenthub/codex-bridge` exports. See [NOTICE](NOTICE).

## Install the release

Install the CLI from npm (Node.js 22.13 or newer):

```sh
npm install -g @gxcsoccer/agenthub
agenthub --help
```

0.4.0 adds owner disconnect and reconnect, message listing and clearing, and embedding options for Codex and Claude. Before upgrading, stop the Hub and back up its state directory; upgrade connector processes with the Hub. Connector state moves to version 4, so rolling back needs that backup. Upgrades from 0.1.0 still require the [migration notes](CHANGELOG.md#upgrade-notes--升级说明).

## Run from source

Requirements: Node.js 22.13+, an already running Codex App Server and/or Claude Code. Unix socket integration is validated on macOS; Windows clients/managed ACP and experimental one-way native pipes are described in [Extensions](docs/EXTENSIONS.md).

```sh
npm ci
npm run build
npm link
agenthub serve --config examples/local.json
```

The example explicitly enables experimental Claude native messaging. Without a config, Claude discovery/history work but sends are disabled. Codex connects lazily to its existing control socket. No backend is launched.

The daemon binds to `127.0.0.1:3211` and creates a private token file at `~/.agenthub/token`. It prints the token path, not the token. Client commands use the same file:

```sh
agenthub doctor
agenthub instances
agenthub sessions --harness claude
agenthub sessions --harness codex --search AgentHub
agenthub send --message-file /absolute/path/message.json
agenthub status --message-id MESSAGE_UUID --wait-ms 30000
```

`message.json` contains an explicit target and a caller-generated UUID. Replace the IDs with actual values:

```json
{
  "messageId": "95054348-8959-413e-89a3-3b98eab598d5",
  "to": { "harness": "claude", "instance": "local", "sessionId": "TARGET_SESSION_UUID" },
  "origin": { "name": "my-app" },
  "delivery": "peer_message",
  "text": "Please review the proposed interface and return a correlated reply."
}
```

Keep the same message ID and payload when checking a submission again. `transport_written` and `accepted` are not model-read acknowledgements. Use the receipt's `reply` when its status becomes `replied`. Ambiguous delivery is `unknown`; no automatic write retry occurs.

## Read-only diagnostics

```sh
agenthub doctor
agenthub doctor --harness codex --session-id SESSION_ID
agenthub doctor --harness claude --instance local --timeout-ms 10000
```

`doctor` uses the existing daemon and token, with GET requests only. By default it checks authenticated access and discovery. With a target it checks send/reply prerequisites, distinguishing missing tools, required attachment, disabled Claude sends, unsupported versions and unavailable inboxes. JSON output uses exit codes `0` for ok, `2` for warnings and `1` for errors. Each HTTP request defaults to 10 seconds; inspection is capped at 32 instances, four at a time, with one page of ten sessions per instance. This is a bounded sample, not a complete inventory.

It sends no probes, opens no callbacks and tests neither disk writes nor model receipt or Claude inbound policy. Reports omit session names, working directories, transcript content and raw backend errors. The SDK exposes `client.doctor({ scope: { harness: 'codex', instance: 'local' }, sessionId })`; SDK requests use the client's configured timeout (70 seconds by default).

## Library and SDK

```ts
import { AgentHub, CodexAdapter, ClaudeAdapter } from '@gxcsoccer/agenthub';

const hub = new AgentHub([
  new CodexAdapter({ instance: 'local' }),
  new ClaudeAdapter({ instance: 'local', nativeMessaging: true }),
]);
try {
  const sessions = await hub.listSessions({ harness: 'claude', instance: 'local' });
  console.log(sessions);
} finally {
  await hub.close();
}
```

For a separate application, import `AgentHubClient` from `@gxcsoccer/agenthub/client` and connect to the daemon. This fetch-only entry point does not import Node transports. The daemon keeps receipts and callback listeners alive across CLI/MCP calls.

Optional `replyTo` routes the first correlated reply to another explicit session. Forwarding uses a fresh message ID, preserves `inReplyTo`/correlation, increments the hop count, and uses `messageKind: "result"` without reply instructions or another reply route. Result receipts retain transport evidence rather than waiting for replied. Available in 0.2.0. Check `forwardedMessageId` and `forwardError` on the original receipt.

For Codex replies, the owner must register exported `codexReplyTool` when creating the session. `getSession()` reports `replyReadiness`: `ready`, `needs_attach`, `missing_tool`, `unknown`, or `unavailable`. Registration is checked against local session metadata; an unpersisted or inaccessible rollout remains unknown. Sending and reconnecting do not attach a listener. Owners can explicitly attach with the command below after a disconnect or Hub restart. It requires a loaded root with a verified tool, passes no configuration overrides, and acknowledges that an unload between the check and upstream `thread/resume` can cause a cold resume. Arbitrary live tool installation is not supported.

```sh
agenthub attach-reply --harness codex --session-id SESSION_ID --accept-resume-race
```

The daemon persists receipts, normalized payload hashes, reply routes and callback correlations in `state.sqlite` beside its token file by default. `--state-file FILE` / `AGENTHUB_STATE_FILE` changes the path; `--ephemeral` opts out. For library persistence use `await openLocalHub(config, { stateFile: absolutePath })`, or pass `await openReceiptStore(absolutePath)` to `new AgentHub(adapters, { store })` and await `hub.ready()`. Plain `new AgentHub(...)` remains in memory. State contains plaintext message/reply content: use a private 0700 directory; database and lock files are 0600.

## MCP and Doubao

```sh
env -u AGENTHUB_TOKEN agenthub mcp --origin-name 'Doubao Work' \
  --url http://127.0.0.1:3214 --token-file /ABS/PRIVATE/caller.token
```

This stdio facade uses the official MCP TypeScript SDK and exposes seven tools: `list_instances`, `list_sessions`, `get_session`, `get_history`, `search_history`, `send_message`, `get_message_status`. It connects to the same local daemon. Approval and lifecycle mutation tools are not exposed to agents.

[Doubao setup](docs/DOUBAO.md) in 0.3.0 provides target selection, private configuration, managed Hub lifecycle and an optional local CLI plugin. `agenthub setup` includes explicit CDP-based host registration for Doubao 2.35.15. Real Doubao STDIO requests returned visible Claude/Codex replies; automatic host creation/removal passed a separate five-check run. Native Doubao identity and proactive wake-up remain unimplemented.

## Verification and limits

```sh
npm run check
npm run smoke:isolated -- --run --default-inbox --matrix
npm run smoke:recovery -- --run
```

Live smoke creates isolated Codex/Claude sessions, runs Codex → Hub → Claude → Hub → Codex, verifies correlation and history identity, then stops/archives only those sessions. Reports are private under ignored `.local/verification/`. See [verification scope](docs/VERIFICATION.md).

- Durable receipts retain 24 hours / at most 10,000 entries. Interrupted submissions become `unknown` on restart and are never automatically replayed. Late Claude replies can return to the preserved callback address; Codex requires explicit reattachment. No exactly-once guarantee.
- Event replay is bounded to 2,000 events / 4 MiB; stale or restarted cursors fail explicitly.
- Claude wire format is version-specific. The installed CLI version is checked, but the version of each already-running process is not authenticated.
- Callback trust is the same OS user. Claimed origin is attribution, not a verified remote-agent identity.
- Claude history reads a bounded local snapshot (64 MiB transcript, 2 MiB record). It does not provide a global archived-session index or a live transcript subscription.

MIT. Original Codex Bridge attribution is preserved.

[Authorization, durable replay, search, ACP and Windows scope](docs/EXTENSIONS.md).

Claude/Codex enrollment, shared collaboration operations, Codex MCP connect and opt-in Claude CLI connect are available in 0.2.0. See [Connector setup](docs/CONNECTOR_SETUP.md) for configuration and limits. Claude CLI activation uses native messages and existing Bash permissions and can start a model turn; external MCP reload remains unavailable.
