# AgentHub v0.1 design

One API across coding harnesses. The library connects to existing processes; it does not resume, restart, or interrupt them implicitly.

## Boundaries

- Core: composite session addresses, discovery, detail, history, explicit delivery semantics, idempotency, receipts, bounded event replay, and optional correlated reply forwarding.
- Codex adapter: existing App Server WebSocket over UDS; external messages use `turn/start.toolOutput`. Reads do not restore sessions. Sends check loaded/root status. Original 22-operation HTTP/SDK interface remains available in the imported Codex Bridge.
- Claude adapter: read-only `claude agents --json` discovery, native inbox delivery and reverse callback sockets, transcript history including peer `queued_command` attachments. The inbox implementation is experimental and version-gated to 2.1.317 / 2.1.318.
- Local service: authenticated loopback HTTP API, fetch client, JSON CLI, and an official-SDK MCP stdio facade. CLI/MCP clients share daemon receipt state; they do not create independent receipt stores on each command.
- Doubao: local CLI/MCP integration example. OpenAPI managed sessions and MCP Events remain documented adapter plans until credentials and an isolated runtime validation are available.

## Identity and delivery

`{ harness, instance, sessionId }` is an opaque address. The core does not impose Codex UUID rules on other harnesses. An adapter advertises its actual capabilities. Codex `tool_output` and Claude `peer_message` are distinct; neither silently falls back to user input. Agent-facing tools do not expose permission approval or configuration changes.

Each message has a caller-generated UUID, origin, target, explicit delivery type, optional correlation/in-reply-to fields, deadline and hop count. Origin metadata is attribution, not authenticated peer identity. Replies require explicit correlation. A reply route, if supplied, forwards only the first reply and does not install another reply route. The forwarding attempt has its own receipt and failures remain visible.

Receipts distinguish `pending`, `transport_written`, `accepted`, `held`, `received`, `replied`, `rejected`, `failed`, and `unknown`. Native callbacks may precede the send response. Later transport acknowledgements must not overwrite stronger evidence. Neither socket writes nor API acceptance prove that a model read a message.

Idempotency is bounded (24 hours, 10,000 receipts). Optional SQLite storage, enabled by default in the daemon, commits a reservation before adapter I/O. Each record tracks reserved/dispatching/settled phases; interrupted nonterminal submissions become unknown on recovery and are not replayed. The original reply and its fixed forward ID are committed together, then parent state and child reservation are committed atomically before forwarding. Only a saved intent without a child reservation can be newly submitted on startup. Native I/O and SQLite cannot be one transaction; there is no exactly-once guarantee. Events persist with SQLite; approval requests remain process-local and cursor gaps are explicit.

The store uses Node native SQLite (Node >=22.13), full synchronous commits, a schema version and private file modes. A separate SQLite transaction lock enforces one owner and is released by the OS after a crash. State corruption, unsupported schemas and disk failures fail closed. Claude callback path/inode and outgoing correlation are committed before the native write. Startup rebinds the old path only if it is absent or the same owned inactive socket; active/replaced endpoints are refused. Callbacks sent during downtime are not replayed by Hub. Library callers without a store retain ephemeral behavior.

## Local trust and scope

The daemon binds to loopback and requires a private bearer token. Browser origins are rejected. Claude callback sockets use random names and private file modes; only callbacks from expected addresses and outstanding message IDs are processed. Node does not authenticate a kernel peer PID for inbound callbacks; same-OS-user processes are the local trust boundary. Claude's recorded verifiedPeerPid identifies the Hub process, not the original remote author.

Existing Claude sockets stay untouched. Existing sessions retain their inbound policy; the adapter never changes accept/hold/refuse, permissions, or configuration. Codex reply capture requires the `agenthub_reply` dynamic tool registered by the session owner and a native thread listener on this connection. `turn/start` does not install or restore that listener. A real disconnect test confirmed that transport reconnection alone cannot guarantee correlated replies. Read-only readiness uses local persisted tool registration plus this connection's observed listener. Owners can explicitly attach verified loaded roots using thread/resume without config overrides, acknowledging the check-to-resume unload race. No automatic attach or arbitrary live tool registration is provided. The transport epoch invalidates readiness on disconnect. Other approvals remain with their owner.

## Verification

Keep imported Codex tests. Add core/adapter contract tests for duplicate and uncertain delivery, identity preservation, callback races, capability rejection, history pagination, and safe socket cleanup. Use fake backends for transport failure tests. Live smoke uses newly created, allowlisted Codex/Claude sessions only; no command execution, external network tools, or working-session writes. Doubao availability is not inferred from a standalone MCP client test.

See [Extensions](EXTENSIONS.md) for caller grants, durable event semantics, full-text search and explicit managed-session endpoints.
