# Doubao Work integration

The preferred path is **local stdio MCP**. A host supporting local MCP can use the generated configuration to call the Hub, request work from authorized Claude/Codex sessions and retrieve correlated replies without installing an AgentHub plugin. This development branch provides configuration generation and seven MCP tools; `plugins/doubao` is an optional local CLI plus Skill package. **Loading this configuration and invoking tools inside Doubao still require host acceptance.** Generic MCP tests do not establish Doubao support.

This is an external client, not a verified native Doubao session. It does not implement arbitrary Doubao session discovery/history, unsolicited wake-up, Agent OpenAPI or MCP Events adapters. A passing CLI/HTTP test is not evidence that Doubao loaded the plugin.

## Configure

Requirements: Node.js 22.13+, this development branch and dedicated running test sessions. Run `npm ci && npm run build` in the checkout first. This path uses the compiled local CLI and does not depend on an unpublished npm version. Claude/Codex have native macOS acceptance evidence; Doubao on Linux still needs host verification. Windows remains pending. The generator only creates isolated configuration.

Create `targets.json` with explicit addresses:

```json
[
  { "harness": "claude", "instance": "local", "sessionId": "REPLACE_WITH_TEST_UUID" },
  { "harness": "codex", "instance": "local", "sessionId": "REPLACE_WITH_TEST_UUID" }
]
```

Keep only the targets you intend to authorize. Wildcards, guessed names, other harnesses and nonlocal instance names are rejected.

```sh
mkdir -p "$HOME/.agenthub"
node scripts/setup-doubao.mjs --targets /ABS/targets.json
```

This creates a new `$HOME/.agenthub/doubao` directory (0700), containing private files (0600): separate random owner/caller tokens, `access.json` with target-specific read/send grants, `hub.json`, connector profiles, separate enrollment credentials and **`mcp.json`**. Existing directories are never overwritten. Output includes `mcpConfigPath` and `startArgv`, never token values. `--directory /ABS/NEW_DIRECTORY` and `--port 3214` customize all generated paths and URLs. `--cli /ABS/dist/src/cli.js` selects another compiled CLI. MCP launches absolute Node/CLI paths with literal argument boundaries, including paths containing spaces.

After review, run the dedicated Hub:

```sh
env -u AGENTHUB_TOKEN node dist/src/cli.js serve --port 3214 \
  --config "$HOME/.agenthub/doubao/hub.json" \
  --token-file "$HOME/.agenthub/doubao/owner.token" \
  --access-file "$HOME/.agenthub/doubao/access.json" \
  --connector-file "$HOME/.agenthub/doubao/connectors.json" \
  --state-file "$HOME/.agenthub/doubao/state.sqlite"
```

An occupied port is an error, not permission to stop another daemon. The generator does not edit existing configurations, start services, install MCP tools, change host permissions or send messages. Policy changes require an owner edit and Hub restart. MCP and the optional plugin use only `caller.token`. The generated command uses `/usr/bin/env -u AGENTHUB_TOKEN` to remove inherited owner credentials before selecting the caller file. Configuration contains no raw secrets.

The owner can prepare Codex reply tools with:

```sh
env -u AGENTHUB_TOKEN node dist/src/cli.js connect --harness codex --session-id CODEX_TEST_UUID \
  --connector-profile "$HOME/.agenthub/doubao/codex-client.json" \
  --url http://127.0.0.1:3214 --token-file "$HOME/.agenthub/doubao/owner.token"
```

Codex uses the distinct MCP name `agenthub_doubao`; reload affects the instance and conflicting configuration is not overwritten. Claude can reply through its native callback. To enable its unified CLI tools, the owner may use the equivalent `connect` with `--harness claude`, `claude-client.json` and `--wait-ms 60000`. This can start a Claude model turn under its existing Bash permissions. These are owner operations, not plugin actions. See [connector setup](CONNECTOR_SETUP.md).

Add the generated `agenthub` entry from `mcp.json` through the host's local stdio MCP configuration interface, preserving other servers. If the interface separates command and args, copy each value literally. The local MCP entry in Doubao Work 2.35.15 has not yet been confirmed. A generic [template](../examples/mcp.json) is provided.

After loading, expect seven tools: `list_instances`, `list_sessions`, `get_session`, `get_history`, `search_history`, `send_message`, `get_message_status`. Discover an authorized target, send `messageKind: request` and poll its UUID. Tool descriptions include reply and bounded polling guidance, so a separate Skill is optional. Report pending IDs for later user-directed checks.

To disable, remove only this MCP entry and stop the Hub started from this configuration. Credential revocation requires restarting that Hub. Retain its private state to inspect receipts; leave other servers and the default Hub untouched.

## Optional CLI plugin packaging

```sh
npm run package:doubao
```

Requires system `zip`. Produces `.local/doubao/agenthub-plugin-0.1.0.zip` and refuses to overwrite an existing archive. Only three allowlisted files are packaged: root `plugin.json`, `com.doubao/cli.json` and the Skill. Tokens, local configuration, histories and verification reports are excluded. Plugin version 0.1.0 pins installation to `@gxcsoccer/agenthub@0.2.0`, which must be published before that installation command works. The source-based MCP path above has no such release dependency. For nondefault directories or ports, update the plugin configuration and Skill accordingly.

Local package checks do not establish platform approval or global Skill-name uniqueness. The user's independent Doubao Work plugin-loading entry point still needs confirmation. No store publication, automatic import or working-conversation changes have occurred. A read-only check found `dbx 0.0.41` unauthenticated locally; its application-plugin debugging workflow is not proof of this CLI plugin's host behavior.

## Semantics

- MCP origin is `Doubao Work`; the CLI plugin uses `Doubao Work via AgentHub`, with no native `origin.session` or `replyTo` route. Model-supplied conversation IDs are not identity evidence.
- Requests use `messageKind: request`, Claude `peer_message` or Codex `tool_output`, never `user_input`.
- The current task polls `get_message_status` (CLI: `status`); there is no automatic wake-up or background callback promise.
- Only `replied` with `reply.text` is a response. Accepted, received, held and transport-written are delivery evidence. Unknown delivery is not automatically retried.
- Preserve the original JSON and UUID; after a lost response, query the same ID before any owner-directed retry.
- Credentials isolate callers and target grants, not individual Doubao conversations. Tasks sharing one token share its caller permissions.

## Verification

```sh
npm run build
node --test --test-timeout=15000 test/doubao-plugin.test.mjs
node scripts/smoke-connector-codex.mjs --run --doubao-mcp
# Optional CLI plugin path
node scripts/smoke-connector-codex.mjs --run --doubao-cli
```

Automated checks cover private configuration, separate credentials, paths/ports, no overwrite, invalid/wildcard rejection, ZIP contents and actual CLI / stdio MCP → HTTP → fixture-backend workflows with reply correlation, deduplication and access denial. The generated MCP configuration remains scoped even with an inherited owner token.

The explicit live runner creates only its own App Server, Claude PTY and temporary workspace. After the connector checks, `--doubao-mcp` or `--doubao-cli` exercises the selected workflow with a scoped caller against both real coding backends, then cleans up its sessions and credentials. MCP mode uses generated launch arguments and checks receipt lookup, deduplication and target denial after an MCP process reconnect. It incurs model usage. Private reports remain in ignored `.local/verification/doubao-mcp-backends-live.json` and `doubao-cli-backends-live.json`. **It does not start Doubao or verify host loading, tool selection or permission UI.** See [verification](VERIFICATION.md) for observed results.

## Later: wake Doubao from other agents

The official [CLI connector](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/cli-connector) runs on the PC. Published [MCP configuration](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-server-development) requires remote HTTPS. The user's earlier successful local stdio integration is a separate host-loading path to reproduce.

[MCP Events](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-events) invokes user-confirmed saved tasks and requires remote Streamable HTTP, durable subscriptions, signed public HTTPS callbacks, callback verification and authorization. A 2xx response confirms event receipt, not task completion. A future relay needs an explicitly authorized outbound connection from the local Hub and separate application receipts; cloud services cannot assume access to local sockets or the office network.

[Agent OpenAPI](https://open.doubao.com/document/doubao-developer-guide/openapi-call-flow) needs a developer application, scopes and a user access token. Application-created sessions are not arbitrary existing Doubao sessions. These paths remain unimplemented.
