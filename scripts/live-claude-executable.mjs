#!/usr/bin/env node
// Acceptance-only executable shim: preserve the real SDK/CLI protocol while
// excluding user hooks, configured MCP servers and all model tools.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const command = process.env.AGENTHUB_TEST_CLAUDE;
assert(command, 'AGENTHUB_TEST_CLAUDE must name the real Claude executable');
let args = process.argv.slice(2);
const flagName = (arg) => arg.split('=', 1)[0];
if (args.some((arg) => flagName(arg) === '--output-format')) {
  const variadic = new Set([
    '--tools',
    '--allowedTools',
    '--allowed-tools',
    '--disallowedTools',
    '--disallowed-tools',
    '--mcp-config',
  ]);
  const single = new Set(['--settings', '--setting-sources', '--permission-mode']);
  const flags = new Set([
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-chrome',
    '--chrome',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
  ]);
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i],
      name = flagName(arg);
    assert.notEqual(arg, '--', 'Positional separator is unsupported in the isolated launcher');
    if (variadic.has(name)) {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
    } else if (single.has(name)) {
      if (!arg.includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
    } else if (!flags.has(name)) filtered.push(arg);
  }
  args = filtered;
  args.push(
    '--tools',
    '',
    '--allowedTools',
    '',
    '--setting-sources',
    '',
    '--settings',
    JSON.stringify({ disableAllHooks: true, crossSessionInbound: 'refuse' }),
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--no-chrome',
  );
}
const child = spawn(command, args, { stdio: 'inherit' });
child.on('error', (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
