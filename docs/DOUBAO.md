# Doubao integration

The implemented entry points are the local JSON CLI and MCP stdio facade. No Doubao OpenAPI adapter or MCP Events server is implemented in this version. No automatic modification of Doubao settings is performed.

## First local trial

1. Install `npm install -g @gxcsoccer/agenthub` and start its daemon using `examples/local.json`.
2. Ensure `agenthub` is on the host PATH and add the server from `examples/mcp.json` to a separately created Doubao test environment that supports local stdio MCP. Do not publish this template as an official remote-MCP plugin package.
3. Ask the test conversation to call `list_sessions` for Claude, inspect `get_session`, and select a dedicated test session whose capabilities include `peer_message`.
4. Call `send_message` with a new UUID, explicit address and fixed test text. Poll `get_message_status` with that same UUID. Verify a matching reply appears in the same Doubao conversation.
5. If the result is `held`, `rejected` or `unknown`, report it. Do not change the recipient's policy, resume it, or silently generate a new message ID and retry.

The standalone official MCP client test verifies the facade, not steps 2–4 inside Doubao. A real Doubao trial is still required.

The user's supplied `doubao-plugin-docs` notes record local stdio MCP as previously working. Official [MCP Server documentation](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-server-development) currently specifies remote HTTPS MCP. Keep these support scopes separate. The official [CLI connector](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/cli-connector) runs on the local PC; it can invoke the same JSON CLI. `@gxcsoccer/agenthub@0.1.0` is published on npm. A validated Doubao plugin-store bundle and Doubao runtime acceptance are still pending.

## Later adapters

| Path               | Scope                                                                      | Boundary                                                                                               |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Agent OpenAPI      | Application-created sessions, messages/history, interrupt, per-request SSE | User-authorized `user.message`; busy returns 409; arbitrary existing-session access is not established |
| MCP Events         | User-confirmed event subscriptions invoking a saved task                   | Preview; remote MCP and signed public HTTPS callbacks; receipt 2xx is not task completion              |
| Application JS API | Host-associated UI/worker conversation                                     | sendFollowUpMessage is user input; updateModelContext does not trigger a turn                          |

Sources: [OpenAPI prerequisites](https://open.doubao.com/document/doubao-developer-guide/openapi-call-flow), [application session scope](https://open.doubao.com/document/uAjLw4CM/ukTMukTMukTM/doubao/agent-v1/session/list), [event semantics](https://open.doubao.com/document/uAjLw4CM/ukTMukTMukTM/doubao/agent-v1/session-event/event-overview), [MCP Events](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-events), [conversation JS API](https://open.doubao.com/document/plugin-docs-center/build/interface-development/conversation-js-api).

OpenAPI requires an authorized application, scopes and user access token; it must explicitly declare user-input semantics. A future Events adapter can deliver a message-available event, let the saved task read the message through a tool, and send a correlated reply. Its endpoint is a subscription/task, not proof of an arbitrary live-session attachment.

The supplied environment notes say Doubao MCP Apps cannot reach the office network. A cloud event service must not assume it can directly access local Codex/Claude sockets. Any future relay needs an explicit connection from the local Hub and appropriately scoped message access.
