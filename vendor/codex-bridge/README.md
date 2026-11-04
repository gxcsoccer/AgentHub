# Codex Session Bridge

[简体中文](README.zh-CN.md) · [API guide](docs/API.md) · [Architecture](docs/ARCHITECTURE.md) · [OpenAPI](openapi.json)

A local HTTP API and TypeScript/JavaScript SDK for applications that need to inspect and communicate with **existing Codex sessions**.

The bridge connects to one running Codex App Server through its Unix control socket. It exposes session discovery, search, history, messages, live events, and approval/question responses. It does not start another Codex instance or edit session files.

**Status:** initial `0.1.0` implementation; not yet published to npm. Independently developed; not an official OpenAI SDK.

## Capabilities

| Area          | Included                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------ |
| Discovery     | Stored session list, loaded thread IDs, metadata, cursor pagination                        |
| Search        | Cross-session indexed search, occurrences within a paginated session                       |
| History       | Paginated turns and message/tool items                                                     |
| Communication | User-message submission, active-turn steering, context injection, interruption             |
| Lifecycle     | Explicit create, attach, resume, detach, fork, rename, archive and unarchive               |
| Interaction   | Pending server requests; explicit approval, question and tool-result responses             |
| Events        | SSE, text deltas, turn/item lifecycle, bounded cursor replay, connection-gap notifications |
| Integration   | Bearer token, explicit CORS origins, typed fetch SDK, OpenAPI 3.1                          |

`sessionId` in bridge URLs is the Codex **thread ID**. Codex also has a separate session-tree ID; do not substitute it for a child thread ID.

## Quick start

Requirements: Node.js 22+, npm, and a running Codex App Server with a control socket. Local read-only integration was verified against Codex CLI/App Server `0.166.0` on macOS. The public repository's implementation was checked at `f2b94ef8b5` (2026-11-04). Older versions and other hosts may expose fewer methods.

```sh
git clone https://github.com/gxcsoccer/Codex-MultiAgentV2.git
cd Codex-MultiAgentV2
npm ci
npm run build
npm start
```

The HTTP listener binds to `127.0.0.1:3210`. A token is created at `~/.codex-session-bridge/token` with mode `0600`; its value is never printed. To use a different already-running Codex instance:

```sh
npm start -- --socket /absolute/path/to/app-server-control.sock --port 3211
```

The default socket is `${CODEX_HOME:-~/.codex}/app-server-control/app-server-control.sock`. A desktop app or standalone CLI can use another instance; only sessions in the selected backend are visible. A socket's existence alone does not prove that it serves the desktop window you intend to control.

```sh
export CODEX_BRIDGE_TOKEN="$(cat "$HOME/.codex-session-bridge/token")"
curl -H "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  'http://127.0.0.1:3210/v1/sessions?limit=20'

curl -H "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  'http://127.0.0.1:3210/v1/sessions/search?q=mailbox&limit=10'
```

Use `GET /v1/sessions/loaded` to find currently loaded thread IDs. Inspect a chosen thread with `GET /v1/sessions/{sessionId}`. Read its messages through `/items` or `/turns`.

## Send a message

```sh
curl -X POST \
  -H "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: deskmind-event-0001' \
  'http://127.0.0.1:3210/v1/sessions/REPLACE_WITH_THREAD_UUID/messages' \
  -d '{"source":"DeskMind","text":"The CI report is ready. Please review it.","mode":"start"}'
```

The response contains `status: "accepted"` and a `turnId`. This is an acceptance receipt, not proof of completion. Follow `turn.completed` and inspect its status/error and output.

Messages are ordinary **user input**, prefixed with `[External app: DeskMind]`. `source` is a caller-supplied label, not authenticated app identity. Native MultiAgentV2 `send_message`/`followup_task` and direct child-agent input are not exposed by this bridge.

## SDK

Before a registry release, install from a local checkout or an npm tarball:

```sh
npm run build
npm pack
# In a consuming application:
npm install /absolute/path/to/codex-session-bridge-0.1.0.tgz
```

```ts
import { CodexBridgeClient } from 'codex-session-bridge';

const client = new CodexBridgeClient({ token: process.env.CODEX_BRIDGE_TOKEN! });
const { data } = await client.loadedSessions();
const threadId = data[0]; // Select the intended thread after inspecting detail.
if (!threadId) throw new Error('No loaded sessions');
console.log(await client.detail(threadId));

// Explicitly subscribe. See the attach/resume boundary below.
await client.attach(threadId);
let submittedTurnId: string | undefined;
for await (const event of client.events({ sessionId: threadId })) {
  if (event.type === 'ready') {
    const receipt = await client.sendMessage(
      threadId,
      { source: 'DeskMind', text: 'Summarize the current findings.' },
      { idempotencyKey: crypto.randomUUID() },
    );
    submittedTurnId = receipt.turnId;
  }
  if (event.type === 'response.delta') process.stdout.write(String(event.data.delta));
  if (event.type === 'turn.completed' && event.turnId === submittedTurnId) break;
}
```

Breaking the event iterator cancels the HTTP stream. It does not interrupt the Codex turn. To steer a specific running turn, use `mode: 'steer'` with its `expectedTurnId`.

## Operational boundaries

- **One backend:** the service is not a machine-wide or cross-device session directory. Run separate bridge instances on distinct ports for separate Codex instances.
- **No implicit restoration during send:** unloaded sessions return `409 session_not_loaded`. `/resume` explicitly restores a session. `/attach` checks loaded state, then subscribes through upstream `thread/resume`; if Codex unloads the thread between those steps, upstream may restore it. Codex currently has no atomic subscribe-only API.
- **Upstream submission semantics:** `mode: start` calls `turn/start`, which may steer an already-active turn. Use `mode: steer` plus `expectedTurnId` for a strict active-turn precondition. No automatic fallback starts a new turn when steering fails.
- **Idempotency:** message keys retain the same result or error for 24 hours **within one bridge process**, including uncertain deliveries. Maximum 10,000 entries; no early eviction. Receipts do not survive restart. Other mutations are not deduplicated. Never blindly retry an uncertain write.
- **Events:** attach explicitly before observing an existing session. Events only cover notifications received by this connection. A bounded in-memory replay buffer cannot recover downtime; expired/other-process cursors return `409`. Reconnect emits gap notifications and requires explicit reattachment.
- **Human interaction:** requests wait for an explicit reply and expire after five minutes with an error. The bridge never automatically approves commands, file changes or permissions. A response receipt means forwarded, not backend-confirmed execution.
- **Local trust:** the token grants access to the selected backend's exposed session operations. Give it only to trusted apps. Browser origins are denied unless allowed with `--allow-origin http://localhost:3000`. No public-network or multi-tenant deployment is provided.

## Development

```sh
npm test                 # Compile and run unit / HTTP / WebSocket / SDK tests
npm run test:coverage
npm run check            # Formatting + strict TypeScript + tests
npm run schema           # Regenerate OpenAPI from the runtime route definitions
npm run smoke:readonly   # Optional: real Codex reads only, no prompts or resumes
```

The ordinary test suite uses a simulated Codex peer; it does not call a model. A separate live probe sends a real message to an explicitly selected idle root thread, verifies the streamed reply, history, search and idempotency, then detaches:

```sh
npm run smoke:live -- --session YOUR_IDLE_THREAD_UUID --report /private/path/report.json
```

This leaves one test exchange in the selected conversation and uses the configured model. It is opt-in and is not run in CI. The live send/reply probe passed against an existing local session on 2026-11-04 in approximately 5.7 seconds.

For broader acceptance testing, the isolated suite creates its own sessions and temporary working directory, refuses mutations to any other session, and archives/unloads its test sessions afterward:

```sh
npm run smoke:isolated -- --run --report .local/verification/full-suite.json
```

This calls the real model, exercises approvals/questions and lifecycle operations, and may approve **only an exact fixed-marker print command** in its test directory. It does not change global Codex configuration. On 2026-11-04, all **22 API operations passed 25 real-backend checks**, including steering, interruption, context recall, approval acceptance/decline, fork, archive/unarchive and resume. Desktop visual rendering remains outside this API acceptance test. See the [verification matrix](docs/VERIFICATION.md), [compatibility evidence](docs/ARCHITECTURE.md#compatibility-evidence), [contributing](CONTRIBUTING.md), [security](SECURITY.md), and the [changelog](CHANGELOG.md). MIT licensed.
