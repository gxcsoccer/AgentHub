# Doubao Work integration

Use **local stdio MCP** to request work from authorized Claude/Codex sessions and retrieve replies in Doubao, without installing an AgentHub plugin. On macOS, Doubao Work **2.35.15** loaded the seven tools and displayed real replies from both harnesses in an independent test conversation. The verification record separates host observation from backend tests.

This development branch adds the unified `agenthub setup` commands. Published **0.2.0** supplies the underlying CLI/MCP API; it does **not** include these setup commands. Native Doubao conversation identity, arbitrary session discovery/history and proactive wake-up remain future work.

## Build and select targets

Use Node.js 22.13+ and this checkout. Until the next release, run the source CLI with a temporary shell function:

```sh
npm ci
npm run build
AGENTHUB_CLI="$PWD/dist/src/cli.js"
agenthub() { node "$AGENTHUB_CLI" "$@"; }
agenthub setup targets --harness claude
agenthub setup targets --harness codex
```

Target discovery is read-only. Codex lists loaded roots, and Claude lists native live sessions. Use `--cursor` when a continuation is returned. Select an exact UUID from the results; initialization does not silently select or contact a working session.

For one target:

```sh
agenthub setup init --harness claude --session-id CLAUDE_TEST_UUID
```

For several, create `targets.json` and initialize once:

```json
[
  { "harness": "claude", "instance": "local", "sessionId": "REPLACE_WITH_TEST_UUID" },
  { "harness": "codex", "instance": "local", "sessionId": "REPLACE_WITH_TEST_UUID" }
]
```

```sh
agenthub setup init --targets /ABS/targets.json
```

Keep only the targets you intend to authorize. The generator accepts explicit local Claude/Codex UUIDs, using the same validation as manifest loading before creating any files. It creates `$HOME/.agenthub/doubao` with mode 0700 and refuses to overwrite an existing directory. `--directory /ABS/NEW_DIRECTORY` and `--port 3214` customize paths and the port; a custom parent must already exist and be canonical. Credentials and configuration are 0600; the generated `agenthub-mcp` launcher is 0700.

Files include separate owner/caller/enrollment tokens, target-specific read/send grants, Hub and connector profiles, a setup manifest, `mcp.json` and the launcher. Output contains paths and argument arrays, never token values. MCP uses absolute Node/CLI paths and caller credentials, clearing inherited `AGENTHUB_TOKEN`. Keep the checkout or installation at that path. For changed targets or installation paths, stop the old setup and generate a new directory; lifecycle commands reject manually edited generated files.

## Start, connect and load in Doubao

Run the managed Hub in its own terminal, using the same source CLI:

```sh
agenthub setup serve --directory "$HOME/.agenthub/doubao"
```

This stays in the foreground. An occupied port produces an error. Initialize does not start a Hub or send messages. In a second terminal, prepare Codex's reply tools when Codex was selected:

```sh
agenthub setup connect --directory "$HOME/.agenthub/doubao" --harness codex
```

The generated MCP name is `agenthub_doubao`; native reload affects the Codex instance and preserves conflicting configuration. Claude replies through its native callback without this step. Optional `setup connect --harness claude` enables unified agent CLI tools and can start a model turn under existing Bash permissions. Omitting the harness connects **all configured targets**. See [connector setup](CONNECTOR_SETUP.md) for activation boundaries.

### Automatic host registration (experimental)

With Doubao **already running with an explicitly enabled CDP port**, register the generated launcher without filling the form:

```sh
agenthub setup host-install --directory "$HOME/.agenthub/doubao" --doubao-cdp-port 9224
agenthub setup host-disable --directory "$HOME/.agenthub/doubao" --doubao-cdp-port 9224
agenthub setup host-enable --directory "$HOME/.agenthub/doubao" --doubao-cdp-port 9224
agenthub setup host-remove --directory "$HOME/.agenthub/doubao" --doubao-cdp-port 9224
```

This uses the desktop client's internal connector API, currently gated to **2.35.15**, not a public versioned SDK. AgentHub uses the existing renderer login and observed desktop request metadata; cookies and authentication query values are neither exported nor stored. It does not open a debug port or restart Doubao. If needed, explicitly quit and start Doubao with `open -a DoubaoWork --args --remote-debugging-port=9224`, or use the separately installed [dbtrace](https://github.com/gxcsoccer/dbtrace) launcher. Choose when to restart the application yourself.

The CLI persists a unique registration name before creation, records the returned ID, checks the exact launcher configuration, and reuses that entry on repeat installation. After a lost response, it recovers a matching entry by that name; if creation remains uncertain, it refuses another create and retains the private setup for investigation. Removal uses `connector/disconnect`, then verifies absence from the complete local list. A manually edited entry is left untouched. More than one result page (48 local entries), unsupported versions and missing desktop context fail closed.

`installed` means registration and connection acceptance were checked. `hostLoadingVerified` and `deliveryTested` remain false until a separate actual tool/reply test. Host enable/disable changes the connector entry; `setup enable/disable` controls the Hub. These are explicit separate operations.

If registration stopped before attempting creation, `host-remove` clears that pending record without connecting to Doubao; `setup uninstall` also handles it directly. If creation was attempted, a rejected or lost response cannot establish whether the entry exists. A deleted entry or an upgraded host can also prevent API cleanup. Use the offline recovery command with the exact name reported by the error, `setup doctor` (`hostRegistration`), or private `setup.json`:

```sh
agenthub setup host-forget --directory "$HOME/.agenthub/doubao" --confirm-host-name agenthub-EXACT_UUID
agenthub setup uninstall --directory "$HOME/.agenthub/doubao"
```

`host-forget` needs no CDP connection. It records `forgotten`, retains the name/ID and reports `remoteCleanupVerified: false`; check that entry in Doubao and remove it manually. This acknowledgment permits local uninstall and prevents further automatic host operations for that setup. It does not stop a running Hub or revoke credentials itself; follow it with `setup uninstall`.

### Manual entry

In Doubao Work 2.35.15 on macOS:

1. Open **插件 · 技能 · 伙伴** (`⇧⌘S`) → **添加** → **新建自定义连接器**.
2. Choose **STDIO**, name the connector `agenthub` and set command to the absolute **`launcherPath`** returned by init, such as `/Users/you/.agenthub/doubao/agenthub-mcp`.
3. Leave args and environment empty, then save. This custom connector is local to this computer.

The legacy `mcp.json` is also available for hosts that accept a command/args configuration; preserve argument boundaries and other servers. The optional CLI plugin is not needed for this path.

The loaded tools are `list_instances`, `list_sessions`, `get_session`, `get_history`, `search_history`, `send_message` and `get_message_status`. Discover an authorized target, send `messageKind: request`, then poll the same UUID. Tool descriptions provide bounded polling guidance. If pending, report the request ID for a later user-directed status check.

```sh
agenthub setup doctor --directory "$HOME/.agenthub/doubao"
```

Doctor is read-only: backend errors exit 1; otherwise exit 2 because host loading and model replies require a separate test conversation. `hostLoadingVerified: false` means this diagnostic did not establish host loading, not that the host is necessarily disconnected. It never sends a probe message.

## Disable and remove

```sh
agenthub setup disable --directory "$HOME/.agenthub/doubao"
agenthub setup enable --directory "$HOME/.agenthub/doubao"
# Start setup serve again after enable; enable alone does not launch it.
agenthub setup uninstall --directory "$HOME/.agenthub/doubao"
```

Disable persists a disabled flag, waits for this setup's managed Hub to exit and refuses new launcher starts. In-flight work already accepted by a harness is not interrupted. Enable permits a later explicit start. SQLite process locks prevent two managed servers and release after a crash; no process is killed by a guessed PID. A legacy daemon started outside `setup serve` must be stopped separately before disabling or uninstalling.

An unrelated service returning 401/403/404/405, HTML or non-Hub JSON on the configured port does not block cleanup and is left running. A timeout, connection reset or server failure returns `setup_hub_unknown` and retains credentials: inspect or stop that service, then retry. A responsive Hub accepting this setup's credentials still blocks cleanup until stopped.

Uninstall removes only unchanged generated files, retaining private receipt state, lifecycle metadata and unrelated files. **Host entries are a separate cleanup step:** use `setup host-remove` for an API-managed Doubao entry before uninstalling, or the explicit `host-forget` recovery above when remote cleanup cannot be verified. Creation that was never attempted needs neither step. Remove a manually created entry through Doubao's UI, and the matching native MCP entry if `connect` installed one. Interrupted uninstalls can be retried, with remaining files checked before deletion. Uninstalled setups cannot be re-enabled.

The uninstall result separates Doubao registration from native connector configuration:

| `cleanup.doubao.status` | Meaning                                                                   | `hostCleanupRequired` |
| ----------------------- | ------------------------------------------------------------------------- | --------------------- |
| `removed`               | Removal of the recorded entry was verified                                | `false`               |
| `not_created`           | The recorded registration never attempted creation                        | `false`               |
| `forgotten`             | Management was explicitly abandoned; check the retained name/ID in Doubao | `true`                |
| `untracked`             | No API registration record; check for a manually added entry              | `true`                |

`hostCleanupRequired` refers only to that Doubao entry. `cleanup.nativeConnectors` separately reports `status: unchecked`, `checkRequired: true` and the configured harnesses: installation outside the generated files is not tracked. Check those harnesses and remove only native configuration referencing this setup, if present. The command does not modify native configuration or claim it is absent; repeat uninstall preserves the same cleanup report.

## Optional CLI plugin

```sh
npm run package:doubao
```

System `zip` produces `.local/doubao/agenthub-plugin-0.1.0.zip`, refusing an existing archive. It contains only `plugin.json`, `com.doubao/cli.json` and a Skill; no credentials or reports. Plugin version 0.1.0 pins `@gxcsoccer/agenthub@0.2.0`, now published on npm. Nondefault setup paths or ports require corresponding plugin/Skill edits. The CLI plugin itself has not been loaded or store-published in Doubao; the real host acceptance used the custom STDIO connector.

## Message boundaries

- The caller identifies as `Doubao Work` (optional plugin: `Doubao Work via AgentHub`), with no asserted native `origin.session` or automatic `replyTo` route.
- Requests use Claude `peer_message` or Codex `tool_output`, preserving external origin. Only `replied` with actual `reply.text` is an answer; transport acceptance is not completion.
- The current Doubao task polls results. No background callback or proactive wake-up is implemented.
- Preserve the original JSON and UUID. Query that ID after a lost response; do not silently replace it or retry unknown delivery.
- The token isolates a caller and its target grants, **not individual Doubao conversations**. Tasks sharing it share caller permissions.

## Verification and reproduction

```sh
npm run check
npm run test:package
node scripts/smoke-connector-codex.mjs --run --doubao-mcp
# Optional CLI workflow
node scripts/smoke-connector-codex.mjs --run --doubao-cli
# Explicit host-assisted acceptance, with up to 15 minutes to operate Doubao
node scripts/smoke-connector-codex.mjs --run --doubao-host
# Real host API lifecycle, no model messages or app restart
node scripts/smoke-doubao-host-api.mjs --run --cdp-port 9224
```

Live runners create only their own App Server, Claude PTY and temporary directories, incur model usage, and clean owned sessions and credentials. MCP mode tests real replies, duplicates and receipt retrieval after an MCP reconnect. These modes alone do not operate Doubao.

Host mode first completes those backend checks, then writes ignored `.local/verification/doubao-host-pending.json` with a temporary `hostLauncherPath`, two exact request envelopes and `observedFile`. Add that launcher as a temporary Doubao STDIO connector in a dedicated test conversation. Ask Doubao to send the exact requests and retrieve replies. Only **after observing both replies in the UI**, write `observedFile` with `{ "host": "Doubao Work", "hostVersion": "…", "repliesVisible": true, "messageIds": ["…", "…"], "evidence": "private screenshot path" }`. The runner independently matches persisted replies to the fixed requests before recording host checks. Remove the temporary host connector afterward; the fixture cannot remove it for you. A timeout is failure, not acceptance.

A separate five-check production CLI run verified creation/readback, idempotent registration, enabled-state readback and removal while retaining every prior local connector. Its report is `doubao-host-api-live.json`. The observed 17-check run covers 15 backend checks plus two visible Doubao replies. Busy user interleaving, actual host disconnect/recovery, native identity and other host platforms remain unverified. See [verification](VERIFICATION.md); private reports and screenshots stay excluded from publication.

## Later: proactive wake-up

The official [CLI connector](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/cli-connector) runs locally. Published [MCP configuration](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-server-development) describes remote HTTPS publication; the confirmed custom STDIO entry is a separate local route.

[MCP Events](https://open.doubao.com/document/plugin-docs-center/build/mcp-server-development/plugin-development-spec/mcp-events) requires saved tasks, remote Streamable HTTP, durable subscriptions and signed public HTTPS callbacks. [Agent OpenAPI](https://open.doubao.com/document/doubao-developer-guide/openapi-call-flow) needs a developer application, scopes and user access token. A future relay needs explicit authorization and separate completion receipts; neither route grants access to arbitrary existing Doubao conversations. These adapters remain unimplemented.
