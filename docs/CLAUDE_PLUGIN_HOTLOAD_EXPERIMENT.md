# Dynamic loading of Claude plugin MCP servers

[简体中文](CLAUDE_PLUGIN_HOTLOAD_EXPERIMENT.zh-CN.md) · [Integration design](AGENT_CONNECTOR.md) · [Earlier lifecycle experiment](CONNECTOR_LIFECYCLE_EXPERIMENT.md)

On 2026-11-05, an isolated interactive CLI on macOS / Claude Code 2.1.318 **loaded a newly installed plugin MCP into an already-running session, and the real model called it without changing the Claude PID or session UUID**. This extends the earlier experiment that only edited a `--mcp-config` file. A production AgentHub plugin is not implemented or published.

## Executed path and observations

1. Started a new owned Claude with only the original keep MCP configuration. The real model called keep; logs showed no plugin MCP yet.
2. From a separate process, added a temporary local marketplace and installed a uniquely named plugin with `--scope local` for the test workspace. Its `.mcp.json` declared one stdio probe server.
3. Entered `/reload-plugins` in the original session. A new MCP process started without restart or resume.
4. The real model called `mcp__plugin_<name>_bridge__probe`. Its startup UUID matched the original session UUID and its PPID matched the Claude PID.
5. The model successfully called keep again.
6. Uninstalled the test plugin and entered `/reload-plugins --force`. The summary reported zero plugin MCP servers; an independent process check found the plugin MCP PID had exited. A subsequent request produced no plugin tool call and the model reported MISSING_TOOL.

The final run passed **seven checks**: baseline model call, initial plugin absence, new tool invocation, new MCP process, unchanged session/correct identity, original tool continuity and live removal.

Installation occurred while the test session was idle. Permissions allowed only the two experimental probes, without bypass mode. Replacement during an active tool call, arbitrary plugin contents and interactive user approvals were not tested.

## Strict mode and host boundaries

The first run included `--strict-mcp-config`. Reload summaries listed one plugin MCP server, but neither normal reload nor force produced an observed MCP process. The driver stopped before a model probe. This negative result establishes absent startup under that test condition only. Removing strict in a separate run, with the other main conditions retained, produced a successful real call. Strict is documented to use only explicitly supplied `--mcp-config` servers, so plugin counts must not stand in for connection readiness. [MCP documentation](https://code.claude.com/docs/en/mcp#project-scope)

Officially, `/reload-plugins` applies pending installation, update and enable/disable changes. If adding/removing tools would invalidate the prompt cache, normal reload warns and `--force` accepts an uncached next request. This installation succeeded with normal reload; the controller explicitly used force for removal. [Plugin command reference](https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins)

That reference also states that this slash command does not connect/disconnect plugin MCP servers in sessions without an interactive terminal, including desktop, SDK and `-p`. This is a **documented boundary, not a desktop/SDK experiment**. Agent SDK separately exposes `Query.setMcpServers()` for dynamic configuration by the host holding the Query. It is not an attach API for arbitrary existing CLI sessions and was not tested here. [SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#mcpsetserversresult)

## Design consequence

The preferred interactive CLI installation can be a Claude plugin: install at the owner's selected scope, reload in the current session, then enroll using native MCP UUID/process evidence. Loading remains an owner action in the host; no peer message invoked a slash command in this experiment. Future sessions can load the installed configuration at startup.

Strict sessions and other hosts report their actual capabilities and retain next-normal-launch fallback. Existing Claude sessions need not universally exit, while CLI success does not establish identical hot loading on every host.

## Evidence and cleanup

Private mode-0600 reports: `.local/verification/claude-plugin-hotload.json` and the earlier `claude-plugin-hotload-strict-attempt.json`. Ignored `.local/lifecycle-spike/plugin-hotload.mjs` reuses the probe and PTY helpers; full terminal records and a separate process observation remain in report-referenced temporary directories.

Runtime manifest validation passed; directory-submission checks noted missing README/LICENSE/icon. This local fixture was not submitted to a plugin directory and is not release-package acceptance.

Both runs' processes exited. Test plugins and marketplaces were removed, with registration files checked for leftover entries. Installation used local scope in the test workspace; unrelated plugins, working sessions and their permissions were not changed. Production `src/` was unchanged.
