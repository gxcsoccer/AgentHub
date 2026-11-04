#!/usr/bin/env node
// Acceptance-only executable shim: preserve the real SDK/CLI protocol while
// excluding user hooks, configured MCP servers and all model tools.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const command = process.env.AGENTHUB_TEST_CLAUDE;
assert(command, 'AGENTHUB_TEST_CLAUDE must name the real Claude executable');
let args = process.argv.slice(2);
if (args.includes('--output-format')) {
  const pairs = new Set([
    '--tools',
    '--allowedTools',
    '--disallowedTools',
    '--settings',
    '--setting-sources',
    '--permission-mode',
    '--mcp-config',
  ]);
  const flags = new Set(['--strict-mcp-config', '--disable-slash-commands', '--no-chrome']);
  args = args.filter((arg, i, all) => !pairs.has(arg) && !pairs.has(all[i - 1]) && !flags.has(arg));
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
if (process.env.AGENTHUB_TEST_PIDS)
  appendFileSync(process.env.AGENTHUB_TEST_PIDS, `${child.pid}\n`, { mode: 0o600 });
child.on('error', (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
