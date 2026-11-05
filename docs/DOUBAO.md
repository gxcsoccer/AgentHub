# Doubao Work integration

The first implementation is a **local CLI connector plus Skill** under `plugins/doubao`. Doubao calls a local Hub, sends a request to an authorized Claude/Codex session and retrieves its correlated reply by request ID. Plugin version 0.1.0 requires AgentHub 0.2.0. Store submission and Doubao host acceptance remain pending.

This is an external client, not a verified native Doubao session. It does not implement arbitrary Doubao session discovery/history, unsolicited wake-up, Agent OpenAPI or MCP Events adapters. A passing CLI/HTTP test is not evidence that Doubao loaded the plugin.

## Configure

Requirements: Node.js 22.13+, AgentHub 0.2.0 and existing dedicated test sessions. macOS has native acceptance evidence; Linux still needs host acceptance. Windows remains pending. These scripts are run from the source checkout and only generate configuration.

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

This creates a new `$HOME/.agenthub/doubao` directory (0700), containing private files (0600): separate random owner/caller tokens, `access.json` with target-specific read/send grants, `hub.json`, connector profiles and separate enrollment credentials. Existing directories are never overwritten. Output includes paths and startup argv, never token values. `--directory /ABS/NEW_DIRECTORY` supports isolated tests; adjust the plugin URL/token paths if using a different location.

After review, run the dedicated Hub:

```sh
env -u AGENTHUB_TOKEN agenthub serve --port 3214 \
  --config "$HOME/.agenthub/doubao/hub.json" \
  --token-file "$HOME/.agenthub/doubao/owner.token" \
  --access-file "$HOME/.agenthub/doubao/access.json" \
  --connector-file "$HOME/.agenthub/doubao/connectors.json" \
  --state-file "$HOME/.agenthub/doubao/state.sqlite"
```

An occupied port is an error, not permission to stop another daemon. The generator does not edit existing configurations, start services, install MCP tools, change host permissions or send messages. Policy changes require an owner edit and Hub restart. The plugin uses only `caller.token`; each command clears inherited `AGENTHUB_TOKEN` so it cannot override the explicit credential file.

The owner can prepare Codex reply tools with:

```sh
env -u AGENTHUB_TOKEN agenthub connect --harness codex --session-id CODEX_TEST_UUID \
  --connector-profile "$HOME/.agenthub/doubao/codex-client.json" \
  --url http://127.0.0.1:3214 --token-file "$HOME/.agenthub/doubao/owner.token"
```

Codex uses the distinct MCP name `agenthub_doubao`; reload affects the instance and conflicting configuration is not overwritten. Claude can reply through its native callback. To enable its unified CLI tools, the owner may use the equivalent `connect` with `--harness claude`, `claude-client.json` and `--wait-ms 60000`. This can start a Claude model turn under its existing Bash permissions. These are owner operations, not plugin actions. See [connector setup](CONNECTOR_SETUP.md).

## Package and load

```sh
npm run package:doubao
```

Requires system `zip`. Produces `.local/doubao/agenthub-plugin-0.1.0.zip` and refuses to overwrite an existing archive. Only three allowlisted files are packaged: root `plugin.json`, `com.doubao/cli.json` and the Skill. Tokens, local configuration, histories and verification reports are excluded. Installation is pinned to `@gxcsoccer/agenthub@0.2.0`.

Local package checks do not establish platform approval or global Skill-name uniqueness. The user's independent Doubao Work plugin-loading entry point still needs confirmation. No store publication, automatic import or working-conversation changes have occurred. A read-only check found `dbx 0.0.41` unauthenticated locally; its application-plugin debugging workflow is not proof of this CLI plugin's host behavior.

## Semantics

- Origin is `Doubao Work via AgentHub`, with no native `origin.session` or `replyTo` route. Model-supplied conversation IDs are not identity evidence.
- Requests use `messageKind: request`, Claude `peer_message` or Codex `tool_output`, never `user_input`.
- The current Doubao task polls the receipt; there is no automatic wake-up or background callback promise.
- Only `replied` with `reply.text` is a response. Accepted, received, held and transport-written are delivery evidence. Unknown delivery is not automatically retried.
- Preserve the original JSON and UUID; after a lost response, query the same ID before any owner-directed retry.
- Credentials isolate callers and target grants, not individual Doubao conversations. Tasks sharing one token share its caller permissions.

## Verification

```sh
npm run build
node --test --test-timeout=15000 test/doubao-plugin.test.mjs
node scripts/smoke-connector-codex.mjs --run --doubao-cli
```

Automated checks cover private configuration, separate credentials, no overwrite, invalid/wildcard rejection, ZIP contents and a real CLI → HTTP → fixture-backend workflow with reply correlation, deduplication and access denial.

The explicit live runner creates only its own App Server, Claude PTY and temporary workspace. After the connector checks it exercises the plugin CLI workflow with a scoped caller against both real coding backends, then cleans up its sessions and credentials. It incurs model usage. Private reports remain in ignored `.local/verification/doubao-cli-backends-live.json`. **It does not start Doubao or verify host loading, tool selection or permission UI.** See [verification](VERIFICATION.md) for observed results.

## Later: wake Doubao from other agents

The official [CLI connector](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/cli-connector) runs on the PC. Published [MCP configuration](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-server-development) requires remote HTTPS. The user's earlier successful local stdio integration is a separate host-loading path to reproduce.

[MCP Events](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-events) invokes user-confirmed saved tasks and requires remote Streamable HTTP, durable subscriptions, signed public HTTPS callbacks, callback verification and authorization. A 2xx response confirms event receipt, not task completion. A future relay needs an explicitly authorized outbound connection from the local Hub and separate application receipts; cloud services cannot assume access to local sockets or the office network.

[Agent OpenAPI](https://open.doubao.com/document/doubao-developer-guide/openapi-call-flow) needs a developer application, scopes and a user access token. Application-created sessions are not arbitrary existing Doubao sessions. These paths remain unimplemented.
