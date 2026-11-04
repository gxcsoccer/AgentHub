# Authorization, replay, search and managed adapters

[简体中文](EXTENSIONS.zh-CN.md)

## Caller authorization

The owner token retains full access. Configure additional callers using `serve --access-file /private/access.json`. The configuration and each token file must be owner-only regular files (0600 on POSIX). Relative token paths resolve beside the configuration. Each token must be unique, at least 32 non-whitespace characters; credentials are never persisted in receipts.

```json
{
  "callers": [
    {
      "id": "reviewer",
      "tokenFile": "reviewer.token",
      "grants": [
        {
          "harness": "codex",
          "instance": "local",
          "sessions": ["allowed-native-session-id"],
          "operations": ["read", "send"]
        }
      ]
    }
  ]
}
```

Omitting `sessions` grants the whole instance. Empty lists grant no sessions. Operations are `read`, `send`, `attach`, `approve`, `manage`, and `prompt`. Creation requires instance-wide `manage`; user input requires `prompt`. Send permission never implies approval, attachment or prompt permission. Scoped discovery reads only listed sessions instead of enumerating the backend. Unsupported or denied requests do not silently fall back.

The HTTP server binds the caller from its token, ignoring client claims about caller identity. Receipts and idempotency IDs belong to their creator; the owner can inspect all. Restricted SSE streams contain only that caller's receipt events for currently permitted targets. Raw adapter events are owner-only. `replyTo` requires send access to both endpoints, including when forwarding after restart. Update policy and restart the daemon to revoke access. Already submitted backend work is not cancelled by revocation. The shared opaque event cursor exposes stream progression, not other callers' content. This is local access control, not isolation from another process running as the same OS account.

Library setup passes policies in `new HarnessHub(adapters, { callers })` and credentials separately in `createHubServer({ hub, token, callers })`. Trusted in-process calls default to the owner; this is not a sandbox for untrusted code in the same process. Each MCP process should receive its own restricted token.

## Durable events

SQLite schema 2 migrates schema 1 in a transaction. Receipt changes and their `message.status` events commit together. Restart preserves event epoch and sequence; bounded retention remains 2,000 events / 4 MiB. Cursors older than retention or from a different store fail explicitly. The client owns its checkpoint and reconnect policy; no consumer-offset service or exactly-once guarantee is provided. Ephemeral hubs retain process-local events. Approval requests remain transient; missing native events during disconnection cannot be reconstructed from the log. Storage failures fail closed, and a disk failure may prevent writing a `storage.error` event too.

## Full-text search

`GET /v1/search?harness=...&instance=...&sessionId=...&search=...` and `client.search(address, { search, cursor?, limit? })` search normalized history text using a literal, case-insensitive substring. CLI `search` and MCP `search_history` use the same endpoint. Session metadata search remains `list_sessions`/`GET /v1/sessions`.

Each request scans at most ten native history pages. An empty result with a continuation is normal: continue until `nextCursor` is null. Cursors bind caller, address and query. Results preserve native items. There is no shared private-history index, ranking, regex execution or snapshot guarantee across backend history changes. Read permission is required before any history access.

## ACP v1 managed sessions

HarnessHub uses official `@agentclientprotocol/sdk` 2.4.0, stable ACP v1. A configured command is launched only by explicit session creation, using `spawn` without a shell. It is not used to attach or restore an arbitrary running session. The command is owner configuration; callers cannot replace it through HTTP.

```json
{
  "codex": false,
  "claude": false,
  "acp": [{ "instance": "managed", "command": "/absolute/path/to/acp-agent", "args": [] }]
}
```

```ts
const session = await client.createSession(
  { harness: 'acp', instance: 'managed' },
  '/work/project',
);
const receipt = await client.prompt({
  messageId: crypto.randomUUID(),
  to: session.address,
  origin: { name: 'owner' },
  delivery: 'user_input',
  text: 'Explain this project',
});
await client.cancel(session.address);
```

Endpoints: `POST /v1/sessions`, `POST /v1/prompts`, `POST /v1/session/cancel`. CLI: `create`, `prompt --message-file`, `cancel`. These operations are absent from agent-facing MCP. Normal `send` rejects user input; automatic reply forwarding never chooses it. ACP streams text into a correlated reply when the turn ends. Other stop reasons are reported in native evidence. No silent authentication flow, agent restart or session load is attempted. Disconnect or timeout leaves uncertain delivery; a timeout closes the owned agent process, affecting its other managed sessions too. Default prompt timeout is 60 seconds; callers configuring a longer timeout must adjust their HTTP request timeout and poll the same receipt ID after transport uncertainty.

Permissions use the existing interaction endpoints: an explicitly authorized caller selects an advertised option ID or cancels. Timeout, cancellation and closure cancel pending requests. HarnessHub advertises no client filesystem or terminal execution capabilities. The agent's own execution sandbox and credentials remain its owner's responsibility; ACP is not an execution sandbox. Managed history holds at most 200 entries / 1 MiB text per session in this process, at most 100 sessions. It is not native transcript recovery.

Primary references: [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn), [official TypeScript SDK](https://agentclientprotocol.com/libraries/typescript).

## Windows scope

Windows supports the HTTP client, MCP client facade and managed ACP process transport. Run the local daemon with explicit `--ephemeral` and a private `HARNESSHUB_TOKEN`; the POSIX private SQLite store and private credential-file loader deliberately fail closed on Windows. Native Codex UDS access is not provided on Windows.

Experimental `ClaudePipeAdapter` (`claudeWindows` configuration) accepts owner-supplied session ID, native pipe path and messaging token. It writes the required auth frame first, followed by a peer frame in prompting mode. It does not scrape process credentials, guess endpoints, start sessions or claim authentication success from a successful write. A receipt stays `transport_written`; Windows native callback replies and native history are unsupported. Tokens must be protected as secrets in configuration; session detail never returns them.

```ts
new ClaudePipeAdapter({
  instance: 'windows',
  experimental: true,
  sessions: [{ sessionId, pipe, token }],
});
```

The Windows CI test uses an actual Windows named pipe and the managed ACP fixture process. This does **not** validate the native Claude Windows model receiver, its private frame compatibility or reply semantics. Keep this adapter experimental until isolated live Windows acceptance is available. The public auth-frame requirement is documented in [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
