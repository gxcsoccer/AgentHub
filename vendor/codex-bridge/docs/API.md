# API reference

[简体中文](API.zh-CN.md) · [README](../README.md) · [OpenAPI 3.1](../openapi.json)

Base URL: `http://127.0.0.1:3210`. Every resource, including `/openapi.json`, requires `Authorization: Bearer <token>`. Request bodies use `application/json`; unknown fields are rejected. Versioning is in `/v1`. The pre-1.0 contract may change between minor releases.

`sessionId` means **Codex thread UUID**. Session metadata, history and search results preserve upstream fields, including new fields unknown to this SDK. The bridge does not normalize every Codex item variant.

## Discovery and history

| HTTP | Path                                       | Result / parameters                                                                    |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| GET  | `/v1/capabilities`                         | Bridge version, connection state, operations, event cursor, idempotency scope          |
| GET  | `/v1/sessions`                             | `{data: Thread[], nextCursor, backwardsCursor?}`                                       |
| GET  | `/v1/sessions/loaded`                      | `{data: string[], nextCursor}` for this backend's loaded thread IDs                    |
| GET  | `/v1/sessions/search?q=report`             | `{data: [{thread, snippet}], nextCursor, backwardsCursor?}`                            |
| GET  | `/v1/sessions/{sessionId}`                 | `{thread}` metadata; no implicit resume                                                |
| GET  | `/v1/sessions/{sessionId}/turns`           | `{data: Turn[], nextCursor, backwardsCursor?}`                                         |
| GET  | `/v1/sessions/{sessionId}/items`           | `{data: [{turnId, item, startedAtMs?, completedAtMs?}], nextCursor, backwardsCursor?}` |
| GET  | `/v1/sessions/{sessionId}/search?q=report` | `{data: Occurrence[], nextCursor}`                                                     |

All paginated routes accept an opaque `cursor` and `limit` from 1 to 100. Omitted values use backend defaults. `null` nextCursor ends pagination. Keep cursors with the original route, query and filters; do not parse them. `backwardsCursor`, where available, can be used when reversing `sortDirection`.

Session listing accepts `cwd`, `searchTerm`, `archived`, `currentAccountOnly`, `sortKey` (`created_at`, `updated_at`, `recency_at`) and `sortDirection` (`asc`, `desc`). Cross-session search accepts the same fields except `cwd` and `searchTerm`; use required `q`. Boolean query values are exactly `true` or `false`. Cross-session search uses Codex's index; results may lag recent writes and require a backend with search support.

Turns accept `sortDirection` and `itemsView` (`notLoaded`, `summary`, `full`). Items accept `sortDirection` and `turnId`. The first release accepts opaque item cursors, not upstream object anchors. Within-session search returns literal, case-insensitive matches in visible user/assistant text; `snippetMatchRange` uses **UTF-16 code-unit offsets** and `turnCursor` can locate the matching turn. It is not a search of every tool payload or file.

`capabilities.operations` describes this bridge's routes, not a negotiated guarantee that every Codex version supports each method. Unsupported upstream methods return `501 codex_error`.

Codex's normal list excludes threads whose preview is empty. A newly created thread or a fresh fork with inherited history may therefore be readable by ID but absent from `/sessions`, including after unarchiving. Send its first explicit user turn before expecting normal-list visibility. This is upstream filtering, not a failed unarchive or an indexing delay; archived listings may still include these threads.

## Communication

`POST /v1/sessions/{sessionId}/messages` requires an `Idempotency-Key` header (1–128 characters).

```json
{
  "source": "DeskMind",
  "text": "The build completed. Please review the result.",
  "mode": "start"
}
```

`source` is required, 1–64 ASCII letters, digits, `.`, `_` or `-`. It labels ordinary user input as `[External app: DeskMind]\n...`; it is not authenticated identity. `text` is nonblank and at most 100,000 characters. JSON bodies are bounded to 1 MiB.

```json
{
  "status": "accepted",
  "sessionId": "00000000-0000-0000-0000-000000000001",
  "turnId": "turn-from-codex",
  "messageId": "caller-idempotency-key",
  "source": "DeskMind",
  "mode": "start"
}
```

HTTP `202` means Codex accepted the input, not that the work succeeded. `mode: start` (default) calls `turn/start`, which may steer active work. For strict steering, send `mode: steer` and `expectedTurnId`. An outdated turn is rejected; there is no fallback to a new turn. Supplying `expectedTurnId` with start is invalid.

The target must be loaded in the selected backend. No message call resumes it. Direct child-agent input is rejected; use the root thread. Native MultiAgentV2 mailbox delivery is not implemented.

The same key and payload share one submission and return the same receipt **or error** for 24 hours after it settles, within this process. Reusing a key with a different target/payload returns `409 idempotency_conflict`. Maximum 10,000 entries; full capacity returns `429`. A restart forgets receipts. If a write times out or disconnects, `details.deliveryUnknown` is true: inspect history before taking action. Do not create a new key merely to bypass that result.

| HTTP | Path                                 | Body / effect                                                                                     |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| POST | `/v1/sessions/{sessionId}/context`   | `{source,text}`; injects `[External context: source]` as user-role context; does not start a turn |
| POST | `/v1/sessions/{sessionId}/interrupt` | `{turnId}`; requests interruption of that turn; returns `202`                                     |

Context visibility depends on the connected UI's rendering of injected items. It is not an agent mailbox entry and does not wake an idle agent. Only message submission has bridge idempotency.

Interruption targets an active turn. A `turn/start` acceptance receipt may precede the backend's active-task registration; immediate interruption can return `409` with `no active turn to interrupt`. The same response can mean a turn already ended. Observe the turn's events/state rather than assuming acceptance means it is already interruptible. The bridge does not issue an untargeted startup cancellation or retry against a different turn.

## Lifecycle

| HTTP  | Path                                 | Body / effect                                              |
| ----- | ------------------------------------ | ---------------------------------------------------------- |
| POST  | `/v1/sessions`                       | Optional `{cwd,model}`; creates a thread, `201`            |
| POST  | `/v1/sessions/{sessionId}/attach`    | Checks loaded state and subscribes through `thread/resume` |
| POST  | `/v1/sessions/{sessionId}/resume`    | Explicitly restores or attaches the thread                 |
| POST  | `/v1/sessions/{sessionId}/detach`    | Unsubscribes this bridge connection                        |
| POST  | `/v1/sessions/{sessionId}/fork`      | Optional `{lastTurnId}`; forks history, `201`              |
| PATCH | `/v1/sessions/{sessionId}`           | `{name}`; nonblank, at most 200 characters                 |
| POST  | `/v1/sessions/{sessionId}/archive`   | Archives the thread; Codex may unload it                   |
| POST  | `/v1/sessions/{sessionId}/unarchive` | Restores visibility in the session list                    |

There is no upstream subscribe-only method. Attach's loaded-state check and resume are not atomic: a concurrent unload may cause restoration. A new WebSocket connection does not inherit subscriptions. Creating/restoring threads uses existing Codex configuration; the API does not accept approval bypasses, sandbox overrides or arbitrary JSON-RPC methods.

## Events and recovery

`GET /v1/events?sessionId=<uuid>&after=<cursor>` returns SSE. Both query fields are optional. `Last-Event-ID` is an alternative to `after`; the query takes precedence. Bearer authentication requires `fetch` or this SDK, rather than a browser's native `EventSource` constructor.

Attach explicitly to observe an existing thread. Open the SSE stream and wait for `ready` **before** sending work, or retain a prior cursor. Reads and opening an event stream do not implicitly attach.

```text
event: ready
data: {"cursor":"process-epoch:0","connected":true}

id: process-epoch:1
event: response.delta
data: {"id":"process-epoch:1","type":"response.delta","sessionId":"thread-uuid","turnId":"turn-id","timestamp":"2026-11-04T00:00:00.000Z","data":{"threadId":"thread-uuid","turnId":"turn-id","delta":"Hello"}}

```

Named events: `turn.started`, `turn.completed`, `response.delta`, `session.status`, `item.started`, `item.completed`, `request.pending`, `request.responded`, `request.expired`, `bridge.connected`, `bridge.disconnected`. Other notifications are preserved as `codex.<method with slashes replaced by dots>`. `data` contains the original upstream parameters. A completed turn can have a failed/interrupted status: inspect `data.turn.status` and `data.turn.error`.

The buffer holds at most 2,000 events / 4 MiB. Replay is in process-local receipt order, not a durable event store. Global events (`sessionId: null`) also reach filtered streams. Heartbeats run every 15 seconds; slow clients are disconnected, with at most 64 streams. A replay cursor outside retained history or from another process returns `409`. Closing a stream does not interrupt a turn.

On `bridge.disconnected`, assume an event gap. After reconnect: read detail/history, explicitly attach, then start a new stream. Replaying buffered events cannot reconstruct missed backend notifications. No writes, approvals or subscriptions are automatically replayed.

## Approvals and questions

`GET /v1/requests?sessionId=<uuid>` returns unresolved requests received on this connection:

```json
{
  "data": [
    {
      "id": "bridge-request-uuid",
      "method": "item/commandExecution/requestApproval",
      "sessionId": "thread-uuid",
      "params": { "threadId": "thread-uuid", "command": "npm test" }
    }
  ]
}
```

Respond through `POST /v1/requests/{requestId}/response` with **exactly one** of `result` or `error`. The result schema depends on the upstream method; retain its original fields and explicitly collect the user's choice.

```json
{ "result": { "decision": "decline" } }
```

```json
{ "error": { "code": -32000, "message": "The application cannot handle this request" } }
```

HTTP `202 {status: "submitted", requestId}` means forwarded, not backend-confirmed. Requests expire after five minutes with an error, disappear when resolved elsewhere, and are invalidated on disconnect. Duplicate replies return `404`. Up to 128 requests are retained. The bridge never selects an approval or answers a question on its own.

## Errors

```json
{
  "error": {
    "code": "session_not_loaded",
    "message": "Session is not loaded in this Codex instance; resume it explicitly"
  }
}
```

| Status    | Typical meaning                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------ |
| 400       | Invalid input, malformed JSON/cursor, or upstream invalid parameters                             |
| 401 / 403 | Missing token / disallowed browser origin                                                        |
| 404       | Unknown route or no longer pending request                                                       |
| 409       | Unloaded/unsupported target, idempotency conflict, stale cursor or upstream precondition failure |
| 413 / 415 | Body too large / incorrect content type                                                          |
| 429       | Pending RPC, receipt, or stream capacity reached                                                 |
| 501       | Upstream does not implement the method                                                           |
| 502       | Other upstream rejection                                                                         |
| 503 / 504 | Backend unavailable/disconnected / request timeout                                               |

The SDK throws `BridgeApiError` with `status`, `code`, and optional `details`. It does not retry automatically. A broad upstream `-32600` rejection maps to `409`; inspect its message, not just the HTTP status.
