# Claude activation from outside a session

[简体中文](CLAUDE_AUTO_ACTIVATION_EXPERIMENT.zh-CN.md) · [Connector design](AGENT_CONNECTOR.md) · [Plugin hot-load](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.md)

2026-11-05, macOS / Claude Code 2.1.318. The owner should run one external CLI command to install and activate integration in an existing session. **Manual `/reload-plugins` does not meet that goal.** No external MCP reload interface for an ordinary existing terminal session has been validated. A skill → CLI alternative worked under specific conditions but is not production-ready.

## External MCP installation and live activation

An owned interactive session without strict MCP configuration first called its existing keep MCP. An independent process then installed a uniquely named local test plugin and added a separate server with `claude mcp add --scope local`, scoped to the temporary project.

| Operation                                              | Observation                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Install plugin externally, wait and request its tool   | No plugin MCP process observed; no target call within 25 seconds; model reported MISSING_TOOL |
| Add ordinary local MCP, wait and request its tool      | No target call within 25 seconds; model reported MISSING_TOOL                                 |
| Call keep again                                        | Real call succeeded, controlling for a dead session/tool channel                              |
| Execute `/reload-plugins` inside the original terminal | Plugin MCP started and the real model called it; original PID/UUID unchanged                  |
| Uninstall plugin and reload inside the terminal        | Plugin tool removed                                                                           |

These are bounded observations with positive controls, not universal negative claims. The ordinary local MCP had no separate restart control; the plugin result does not establish its behavior.

CLI help, native message-handler inspection and official documentation yielded no validated external reload path for ordinary sessions. Native messages skip slash-command execution, so sending reload text does not perform an owner control operation. [Messaging boundary](https://code.claude.com/docs/en/cross-session-messaging#how-a-session-treats-an-incoming-message)

SDK `Query.setMcpServers()` controls a session already held by that SDK. Pre-enabled plugin directory watchers, development mods and owned PTYs have their own host prerequisites. None establishes arbitrary existing-terminal access. SDK, desktop, background attach and terminal automation were not tested here. [SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#mcpsetserversresult), [Mod development](https://code.claude.com/docs/en/plugins/mods/create)

## Alternative: native message → skill → CLI

The candidate uses existing Skill/Bash tools without adding MCP. In the combined experiment, a new skill added to a project skills directory that existed at startup loaded on a normal user request and executed a CLI before any plugin reload.

A separate run then tested native triggering and clear:

1. Start an owned session with experimental Skill/Bash/native SendMessage access. The skills directory and a harmless baseline skill exist at launch; invoke the baseline first.
2. Externally add a new skill. It has no `allowed-tools` grant. The exact test CLI command was already authorized at session launch.
3. Send an ordinary collaboration request to this session's native inbox. The real model invokes the new Skill and CLI; independent logs contain the expected marker.
4. CLI `CLAUDE_CODE_SESSION_ID`, skill `${CLAUDE_SESSION_ID}` and the native directory UUID agree. CLI ancestry contains the target Claude PID.
5. Execute `/clear` in the owned terminal and send another native request. Both CLI/skill IDs update to the new UUID; the host PID stays unchanged.

Three checks passed: native triggering without reload, CLI identity correspondence, and refreshed identity after clear. This run installed no MCP and executed neither reload command. The CLI only recorded test identity: **this is not complete AgentHub enrollment, authorization or collaboration acceptance**. Self-recorded ancestry is experimental evidence; production Hub must independently verify it rather than trust submitted PIDs/UUIDs.

### Failed attempts and limits

- An initial fixture generated an invalid JavaScript newline. Skill invocation and attempted execution succeeded, but the CLI could not parse. The fixture was corrected and tested in a fresh session; the failed report remains.
- Two runs with only an empty skills directory at launch reported MISSING_SKILL after native messages, without CLI execution. One had completed a normal conversation turn. Neither had a same-run reload control, so they do not establish total watcher failure.
- The successful run also added a baseline skill, a project settings file and an explicit instruction to try the Skill call. These variables have not been isolated. **Directory existence alone is not a validated readiness test.**
- When the top-level skills directory was created after launch, no CLI call occurred within 30 seconds. Explicit `/reload-skills` then enabled a real CLI call through native messaging. That is a positive control, not automatic activation.

Official documentation describes live changes in existing skills directories; a top-level directory created after startup needs `/reload-skills`. Skill watching does not reload a plugin's MCP/hooks. Host policy, tool availability and command permissions remain prerequisites. [Skills documentation](https://code.claude.com/docs/en/skills#edit-a-skill-during-a-session)

## Product consequence

The proposed `agenthub connect` retains installation, activation and validation as its goal. Ordinary Claude MCP activation still lacks a validated external control interface; returning a manual instruction is incomplete.

Skill → CLI deserves further validation but is not the production default. Isolate watcher/discovery prerequisites, then test restricted credentials, independent Hub identity validation, real request/reply and revocation. Readiness may require a real model call; read-only diagnostics must not silently trigger it. Keep installation scope separate from session authorization, without automatically widening to user scope or granting shell access through the skill.

## Private evidence and cleanup

Ignored 0600 reports: `claude-auto-activation.json` (nine combined checks), `claude-skill-auto.json` (three native/identity checks), and `claude-skill-auto-absent-root.json` (one explicit reload control). Failed reports: `claude-skill-auto-fixture-error.json`, `claude-skill-auto-first-turn-missing.json`, `claude-skill-auto-prewarmed-missing.json`.

Drivers: `.local/lifecycle-spike/auto-activation.mjs` and `skill-auto.mjs`. A follow-up driver accidentally reused the earlier plugin summary filename; that summary was reconstructed from retained original terminal/process artifacts and marked accordingly. Current reports use separate names. Private reports and raw records remain unpublished.

Only newly created test sessions and temporary projects were changed. Native commands removed the test plugin, marketplace and local MCP entry; fixture skills were removed and processes exited. Working sessions, production `src/` and the published package were unchanged.
