# API

All unified endpoints require `Authorization: Bearer <token>`. Bind the service to loopback. Browser origins are denied unless explicitly allowed by `createHubServer`. The contract is [openapi.json](../openapi.json), also served at `/openapi.json`.

| Method | Path                           | Purpose                                               |
| ------ | ------------------------------ | ----------------------------------------------------- |
| GET    | `/v1/instances`                | Configured instances and event cursor                 |
| POST   | `/v1/session/attach-reply`     | Explicit owner Codex listener attachment              |
| GET    | `/v1/sessions`                 | Discovery / session search                            |
| GET    | `/v1/session`                  | Session detail and capabilities                       |
| GET    | `/v1/history`                  | Native-preserving history page                        |
| POST   | `/v1/messages`                 | Submit an explicitly typed external message           |
| GET    | `/v1/messages/{messageId}`     | Receipt; optional `waitMs` up to 60,000               |
| GET    | `/v1/events`                   | SSE, optional `after` / `Last-Event-ID` replay cursor |
| GET    | `/v1/interactions`             | Pending explicit owner requests (Codex)               |
| POST   | `/v1/interactions/{requestId}` | Answer with `{ "result": <native response> }`         |

Session queries use `harness`, `instance` (default `local`), and, where applicable, `sessionId`. Paged queries accept `limit` (1–100), `cursor` and `search`. Codex unified history search returns unsupported; the preserved Codex Bridge exposes native `searchOccurrences`. Claude discovery searches metadata, while its history query searches transcript text. Search capabilities are intentionally not interchangeable.

Addresses are opaque in the core. Codex/Claude adapters validate their native UUIDs. Multiple instances are separate namespaces. Cursors are adapter-specific and must stay with the original target/query.

Messages require `messageId` (UUID), `to`, `origin.name`, `delivery`, and `text`. Optional fields: `origin.session`, `correlationId`, `inReplyTo`, `replyTo`, `expiresAt` (default one hour), `hopCount` (0–8). Origin is claimed provenance. Unknown fields are not forwarded. The first correlated reply is optionally forwarded once; the forward has a separate receipt.

HTTP 202 means the API produced a receipt, not that the model processed the message. Inspect `status`:

| Status            | Evidence                                                     |
| ----------------- | ------------------------------------------------------------ |
| pending           | Submission reserved                                          |
| transport_written | Socket write completed; no native receive acknowledgement    |
| accepted          | Native operation accepted                                    |
| held              | Native policy held the message                               |
| received          | Native receipt confirms release/delivery to the session      |
| replied           | A correlated response reached Hub                            |
| rejected          | Native refusal, expiry or drop; inspect `native` for details |
| failed            | Definite failure                                             |
| unknown           | Submission outcome is ambiguous; do not blindly resend       |

Same UUID + same normalized payload reuses one attempt, including failure; a different payload is a 409 conflict. With a store (the daemon default), this survives process restarts for the retention window. An interrupted reservation/submission becomes `unknown` with `process_restarted`; it is not automatically retried. Replies and stable forwarding IDs are committed before forwarding. A saved forwarding intent with no child reservation can be submitted once after restart; an already reserved child is never replayed. Model output is not a business-completion proof.

`POST /v1/session/attach-reply` takes `{ "address": { "harness": "codex", "instance": "local", "sessionId": "..." }, "acceptResumeRace": true }`. The SDK method is `attachReplyRoute(address, { acceptResumeRace: true })`. Session detail exposes `replyReadiness` with `state`, `tool`, `listener`, and `reason`. Attachment refuses unloaded/child sessions or unverifiable tools. It explicitly calls `thread/resume` without configuration overrides after a loaded check: a concurrent unload can cause a cold resume. No subscribe-only upstream API exists. This owner action is absent from agent-facing MCP. Readiness does not guarantee model tool invocation.

Only one daemon may open a state file. A second owner fails with `store_in_use`; unsupported schemas and corrupt state fail closed. Storage write failures make the hub unavailable (503), never trigger a retry, and attempt to emit `storage.error`. Claude restores outstanding callback correlations at startup, reusing the prior path; an active or replaced endpoint is refused. Codex restores correlation IDs but requires owner attachment on the new connection. Events persist with SQLite; approval requests remain process-local.

SSE `message.status` frames carry receipt snapshots; `adapter.event` carries observed native events. `ready` supplies the current cursor; `gap` reports a slow consumer. Stored events use `id`, `type`, `timestamp`, `sessionId`, `turnId`, `data`; `sessionId` is an encoded composite address, not a native UUID. Bounded replay errors are explicit. SSE does not implicitly subscribe/resume a backend session. Native adapter events are limited to this connection's traffic, and are not a complete per-session audit log.

Approval responses use upstream schemas and are never inferred from a peer message. The MCP facade omits these endpoints. Unsupported adapter operations return 501/422. Native errors and transport uncertainty remain visible.

The separate [Codex Bridge API](../vendor/codex-bridge/docs/API.md) retains all 22 original operations; its UUID routes and user-input semantics apply only to that interface.

## Client diagnostics

`HarnessHubClient.doctor({ scope?, sessionId? })` composes existing GET endpoints; it adds no HTTP route or MCP tool. `sessionId` requires `{ harness, instance }`. Reports contain `schemaVersion:1`, `checkedAt`, `readOnly:true`, `deliveryTested:false`, overall `status` and individual `checks`. A check contains `id/status/code/message` and optional `scope/details`; statuses are `ok/warning/error`, with the most severe determining the overall result. Default mode checks discovery; target mode checks send/reply prerequisites.

At most four instances run concurrently, capped at the first 32. Each discovery reads only the first limit=10 page and reports hasMore explicitly. One instance failure does not skip others. Reports omit names, cwd, content, tokens and raw backend errors. CLI doctor defaults to 10 seconds per request. The fetch client accepts optional `timeoutMs` (integer 1..120000, default remains 70000), with no retries. This timeout applies to JSON requests; SSE continues to use its caller-provided signal. CLI exit codes 0/2/1 map to ok/warning/error; missing token files and invalid arguments use the existing stderr error path without creating credentials or starting a daemon.

See [Extensions](EXTENSIONS.md) for caller grants, durable event semantics, full-text search and explicit managed-session endpoints.
